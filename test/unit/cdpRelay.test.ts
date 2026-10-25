import dns from 'dns'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import WebSocket from 'ws'
import type { RelayTarget } from '../../src/main/cdpProtocol'
import type { RelayDeps } from '../../src/main/cdpRelay'

let userData = ''
const guests = new Map<number, FakeGuest>()

vi.mock('electron', () => ({
  app: { getPath: (): string => userData },
  webContents: { fromId: (id: number): FakeGuest | undefined => guests.get(id) }
}))

interface FakeGuest {
  isDestroyed(): boolean
  getURL(): string
  debugger: {
    attach: ReturnType<typeof vi.fn>
    detach: ReturnType<typeof vi.fn>
    isAttached(): boolean
    on(event: string, fn: (...a: never[]) => void): void
    once(event: string, fn: (...a: never[]) => void): void
    off(event: string, fn: (...a: never[]) => void): void
    sendCommand: ReturnType<typeof vi.fn>
  }
  reload: ReturnType<typeof vi.fn>
  reloadIgnoringCache: ReturnType<typeof vi.fn>
  listenerCount(): number
  releaseFrameTree(): void
  emit(event: string, ...args: unknown[]): void
}

function fakeGuest(id: number, opts: { holdFrameTree?: boolean; url?: string } = {}): FakeGuest {
  const listeners = new Map<string, Set<(...a: never[]) => void>>()
  let attached = false
  let release = (): void => {}
  const add = (event: string, fn: (...a: never[]) => void): void => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)?.add(fn)
  }
  const guest: FakeGuest = {
    isDestroyed: () => false,
    getURL: () => opts.url ?? 'http://x/a',
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    debugger: {
      attach: vi.fn(() => {
        attached = true
      }),
      detach: vi.fn(() => {
        attached = false
      }),
      isAttached: () => attached,
      on: add,
      once: add,
      off: (event, fn) => void listeners.get(event)?.delete(fn),
      sendCommand: vi.fn(async (method: string) => {
        if (method === 'Page.getFrameTree') {
          if (opts.holdFrameTree) await new Promise<void>((r) => (release = r))
          return { frameTree: { frame: { id: `frame-${id}` } } }
        }
        return {}
      })
    },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    releaseFrameTree: () => release(),
    emit: (event, ...args) => {
      if (event === 'detach') attached = false
      for (const fn of [...(listeners.get(event) ?? [])]) (fn as (...a: unknown[]) => void)(...args)
    }
  }
  guests.set(id, guest)
  return guest
}

const TAB = 'tab-1'
const SESSION = 'sess-1'

interface Harness extends RelayDeps {
  session: string | null
  strip: RelayTarget[]
}

function makeDeps(): Harness {
  const h: Harness = {
    session: SESSION,
    strip: [{ targetId: 'bt1', url: 'http://x/a', title: 'A', guestId: 11 }],
    sessionForTab: () => h.session,
    mount: vi.fn(async (_s: string, tabId: string) => Number(tabId.replace('bt', '1'))),
    create: vi.fn(async (_s: string, url: string) => ({
      targetId: 'bt2',
      url,
      title: '',
      guestId: 12
    })),
    close: vi.fn(async () => {}),
    stage: vi.fn(async () => {}),
    setAttached: vi.fn()
  } as unknown as Harness
  return h
}

type Relay = typeof import('../../src/main/cdpRelay')

let relay: Relay
let composition: typeof import('../../src/main/hostComposition')
let deps: Harness
const sockets: WebSocket[] = []

interface Conn {
  ws: WebSocket
  closed: Promise<string>
  cmd(method: string, params?: unknown, sessionId?: string): Promise<Record<string, unknown>>
  events: Record<string, unknown>[]
}

let nextId = 1

function connect(): Conn {
  const ws = new WebSocket(relay.relayEndpoint(TAB))
  sockets.push(ws)
  const events: Record<string, unknown>[] = []
  const replies = new Map<number, (m: Record<string, unknown>) => void>()
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as Record<string, unknown>
    if (typeof msg.id === 'number') replies.get(msg.id)?.(msg)
    else events.push(msg)
  })
  const closed = new Promise<string>((resolve) => {
    ws.on('close', (_code, reason) => resolve(String(reason)))
    ws.on('error', () => resolve('error'))
  })
  return {
    ws,
    closed,
    events,
    cmd: (method, params, sessionId) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = nextId++
        replies.set(id, resolve)
        closed.then(() => reject(new Error('socket closed before the reply')))
        const send = (): void =>
          ws.send(JSON.stringify({ id, method, params: params ?? {}, sessionId }))
        if (ws.readyState === WebSocket.OPEN) send()
        else ws.on('open', send)
      })
  }
}

async function registered(): Promise<Conn> {
  const c = connect()
  await c.cmd('Browser.getVersion')
  return c
}

async function closedReason(c: Conn): Promise<string> {
  return await Promise.race([
    c.closed,
    new Promise<string>((r) => setTimeout(() => r('<still connected>'), 3_000))
  ])
}

async function until(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

beforeEach(async () => {
  vi.resetModules()
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-cdp-relay-'))
  guests.clear()
  fakeGuest(11)
  deps = makeDeps()
  relay = await import('../../src/main/cdpRelay')
  composition = await import('../../src/main/hostComposition')
  relay.startRelay(deps)
  relay.relayStripChanged(SESSION, deps.strip)
  relay.setRelayEnabled(true, [TAB])
  await until(() => relay.relayEndpoint(TAB) !== '', 'the relay to listen')
})

afterEach(() => {
  composition.hostComposing(false)
  for (const ws of sockets.splice(0)) ws.close()
  relay.setRelayEnabled(false, [])
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('one client per endpoint (D8)', () => {
  it('a refused second connection does not take the first client down with it', async () => {
    const a = await registered()

    const b = connect()
    expect(await closedReason(b)).toBe('this endpoint already has a client')

    const c = connect()
    expect(await closedReason(c)).toBe('this endpoint already has a client')
    expect(deps.setAttached).not.toHaveBeenCalled()
    expect(await a.cmd('Browser.getVersion')).toHaveProperty('result')
  })
})

describe('the master switch reaches connections that are still handshaking (D2)', () => {
  it('refuses a connection that was waiting for its session when the switch went off', async () => {
    deps.session = null
    const a = connect()
    await until(() => deps.sessionForTab(TAB) === null && a.ws.readyState === WebSocket.OPEN, 'a')

    relay.setRelayEnabled(false, [TAB])
    deps.session = SESSION

    expect(await closedReason(a)).toBe('the Koloft browser endpoint is off')
  })
})

describe('a tab whose session went away (§4.4)', () => {
  // PLATFORM§17
  it('BB-38/39: a rebind to the SAME session changes nothing — the client keeps its pages', async () => {
    fakeGuest(11)
    const a = await registered()
    await a.cmd('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false })
    await until(() => a.events.some((e) => e.method === 'Target.attachedToTarget'), 'the attach')
    ;(deps.setAttached as ReturnType<typeof vi.fn>).mockClear()
    const before = a.events.length

    relay.relayTabRebound(TAB, SESSION)
    await new Promise((r) => setTimeout(r, 100))

    const methods = a.events.slice(before).map((e) => e.method)
    expect(methods).not.toContain('Target.detachedFromTarget')
    expect(methods).not.toContain('Target.targetDestroyed')
    expect(deps.setAttached).not.toHaveBeenCalledWith(SESSION, [])
    expect(await a.cmd('Browser.getVersion')).toHaveProperty('result')
  })

  // CODEX§26
  it('a client sent away with the old session frees the endpoint for the next client, which drives the new session', async () => {
    const a = await registered()
    deps.session = 'session-after-clear'

    relay.relayClientEvicted(TAB, 'a new session took over this tab')
    relay.relayTabRebound(TAB, 'session-after-clear')

    expect(await closedReason(a)).toBe('a new session took over this tab')
    const b = await registered()
    await b.cmd('Target.createTarget', { url: 'http://x/new' })
    expect(deps.create).toHaveBeenCalledWith('session-after-clear', 'http://x/new')
  })

  it('answers no targets and refuses to make one while nothing is bound', async () => {
    const a = await registered()
    relay.relayTabRebound(TAB, null)

    const listed = (await a.cmd('Target.getTargets')).result as { targetInfos: unknown[] }
    expect(listed.targetInfos).toEqual([])

    const made = await a.cmd('Target.createTarget', { url: 'http://x/new' })
    expect(String((made.error as { message?: string })?.message)).toContain(
      'the tab has no running session'
    )
    expect(deps.create).not.toHaveBeenCalled()
  })
})

describe("a session on another machine never reaches this Mac's files or local servers through the Workbench browser", () => {
  const MAC_FILE = 'file:///Users/me/.ssh/id_ed25519'
  const NAME_FOR_THE_MAC = 'http://mac-server.test/'
  const REFUSED = 'cannot reach files or local servers of the Mac'
  const errorOf = (reply: Record<string, unknown>): string =>
    String((reply.error as { message?: string } | undefined)?.message ?? '')

  beforeEach(() => {
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async (host: string) =>
      host === 'mac-server.test'
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }]) as never)
  })
  afterEach(() => vi.restoreAllMocks())

  async function attachedTo(c: Conn, url: string): Promise<string> {
    const listed = (await c.cmd('Target.getTargets')).result as {
      targetInfos: { targetId: string; url: string }[]
    }
    const targetId = listed.targetInfos.find((t) => t.url === url)?.targetId ?? ''
    return ((await c.cmd('Target.attachToTarget', { targetId })).result as { sessionId: string })
      .sessionId
  }

  const NOTES = 'file:///Users/me/notes.html'

  it('refuses to open, navigate to, upload or drag in a Mac file, or open a server on the Mac, however the address is written; web pages still work', async () => {
    relay.relayEndpointOnMachine(TAB)
    const guest = fakeGuest(11)
    const c = await registered()

    for (const url of [
      MAC_FILE,
      'fi\tle:///etc/hosts',
      '\u0001file:///etc/hosts',
      'FILE:/etc/hosts',
      'http://127.0.0.1:8888/tree',
      'http://localhost:3000/',
      NAME_FOR_THE_MAC
    ])
      expect(errorOf(await c.cmd('Target.createTarget', { url })), url).toContain(REFUSED)
    expect(deps.create).not.toHaveBeenCalled()

    const sid = await attachedTo(c, 'http://x/a')
    expect(relay.guestDrivenFromAnotherMachine(11)).toBe(true)
    for (const [method, params] of [
      ['Page.navigate', { url: MAC_FILE }],
      ['Page.navigate', { url: 'fi\nle:///etc/hosts' }],
      ['Page.navigate', { url: `view-source:${MAC_FILE}` }],
      ['Page.navigate', { url: 'http://[::1]:5173/' }],
      ['Page.navigate', { url: NAME_FOR_THE_MAC }],
      ['Network.loadNetworkResource', { url: MAC_FILE, frameId: 'f', options: {} }],
      ['Fetch.continueRequest', { requestId: 'r', url: MAC_FILE }],
      ['DOM.setFileInputFiles', { files: ['/Users/me/.ssh/id_ed25519'], backendNodeId: 1 }],
      ['DOM.getFileInfo', { objectId: 'file-1' }],
      ['Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/Users/me/Library' }],
      [
        'Input.dispatchDragEvent',
        { type: 'drop', x: 1, y: 1, data: { items: [], files: ['/etc/hosts'] } }
      ]
    ] as const) {
      expect(errorOf(await c.cmd(method, params, sid))).toContain(REFUSED)
    }
    const sent = (): string[] =>
      guest.debugger.sendCommand.mock.calls.map((call) => String(call[0]))
    for (const method of [
      'Page.navigate',
      'Fetch.continueRequest',
      'DOM.setFileInputFiles',
      'DOM.getFileInfo',
      'Page.setDownloadBehavior'
    ])
      expect(sent()).not.toContain(method)

    await c.cmd('Page.navigate', { url: 'https://example.com/' }, sid)
    expect(guest.debugger.sendCommand).toHaveBeenCalledWith('Page.navigate', {
      url: 'https://example.com/'
    })
    await c.cmd('Target.createTarget', { url: 'about:blank' })
    expect(deps.create).toHaveBeenCalledWith(SESSION, 'about:blank')

    c.ws.close()
    await until(() => !relay.guestDrivenFromAnotherMachine(11), 'the guest to be let go')
  })

  it('never shows it, or lets it attach to, a tab on a Mac file or local server, even before the strip has caught up', async () => {
    relay.relayEndpointOnMachine(TAB)
    fakeGuest(11)
    fakeGuest(13, { url: NOTES })
    fakeGuest(14, { url: NOTES })
    relay.relayStripChanged(SESSION, [
      ...deps.strip,
      { targetId: 'bt3', url: NOTES, title: 'notes', guestId: 13 },
      { targetId: 'bt4', url: 'http://x/before', title: 'before', guestId: 14 },
      { targetId: 'bt6', url: 'http://localhost:3000/', title: 'dev server', guestId: 16 }
    ])
    const c = await registered()
    await c.cmd('Target.setDiscoverTargets', { discover: true })

    const listed = (await c.cmd('Target.getTargets')).result as {
      targetInfos: { targetId: string; url: string }[]
    }
    expect(listed.targetInfos.map((t) => t.url)).toEqual(['http://x/a', 'http://x/before'])
    const lagging = listed.targetInfos[1]?.targetId ?? ''
    expect(errorOf(await c.cmd('Target.attachToTarget', { targetId: lagging }))).toContain(REFUSED)

    relay.relayStripChanged(SESSION, [
      ...deps.strip,
      { targetId: 'bt3', url: NOTES, title: 'notes', guestId: 13 },
      { targetId: 'bt4', url: NOTES, title: 'notes', guestId: 14 },
      { targetId: 'bt5', url: 'file:///Users/me/new.html', title: 'new', guestId: 15 }
    ])
    await c.cmd('Browser.getVersion')
    expect(JSON.stringify(c.events)).not.toContain('file:')
    expect(c.events.map((e) => e.method)).toContain('Target.targetDestroyed')
  })

  it("a session on this Mac still opens this Mac's files", async () => {
    const guest = fakeGuest(11)
    const c = await registered()
    const sid = await attachedTo(c, 'http://x/a')
    expect(relay.guestDrivenFromAnotherMachine(11)).toBe(false)
    await c.cmd('Page.navigate', { url: MAC_FILE }, sid)
    expect(guest.debugger.sendCommand).toHaveBeenCalledWith('Page.navigate', { url: MAC_FILE })
  })
})

describe("a tab's endpoint made for its machine (each new ssh forward)", () => {
  it('turns the old address away and sends off a client still on it, so an address read off a port another account took after the link dropped opens nothing', async () => {
    const old = relay.relayEndpoint(TAB)
    const onOld = await registered()
    const renewed = relay.renewRelayEndpointOnMachine(TAB)
    expect(renewed).not.toBe(old)
    expect(relay.relayEndpoint(TAB)).toBe(renewed)
    expect(await closedReason(onOld)).toBe('the ssh forward to the machine was made again')

    const stale = new WebSocket(old)
    sockets.push(stale)
    const reason = await new Promise<string>((resolve) =>
      stale.on('close', (_code, r) => resolve(String(r)))
    )
    expect(reason).toBe('unknown endpoint')
    expect(await (await registered()).cmd('Browser.getVersion')).toHaveProperty('result')
  })
})

describe('a client that drops in the middle of an attach', () => {
  it('leaves no debugger attached and no listeners behind', async () => {
    const guest = fakeGuest(11, { holdFrameTree: true })
    const a = await registered()
    const listed = (await a.cmd('Target.getTargets')).result as {
      targetInfos: { targetId: string }[]
    }
    const targetId = listed.targetInfos[0]?.targetId ?? ''

    void a.cmd('Target.attachToTarget', { targetId }).catch(() => {})
    await until(() => guest.debugger.attach.mock.calls.length > 0, 'the debugger to attach')

    a.ws.close()
    await until(
      () => (deps.setAttached as ReturnType<typeof vi.fn>).mock.calls.length > 0,
      'the drop'
    )
    guest.releaseFrameTree()
    await new Promise((r) => setTimeout(r, 100))

    expect(guest.debugger.detach).toHaveBeenCalled()
    expect(guest.listenerCount()).toBe(0)
    for (const call of (deps.setAttached as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).toEqual([])
    }
  })
})

describe('a guest whose debugger detaches by itself', () => {
  it('delivers each later guest event exactly once after the tab is attached again, because the old message listener is removed', async () => {
    const guest = fakeGuest(11)
    const a = await registered()
    const listed = (await a.cmd('Target.getTargets')).result as {
      targetInfos: { targetId: string }[]
    }
    const targetId = listed.targetInfos[0]?.targetId ?? ''
    await a.cmd('Target.attachToTarget', { targetId })

    guest.emit('detach')
    await until(
      () => a.events.some((e) => e.method === 'Target.detachedFromTarget'),
      'the detach to reach the client'
    )
    await a.cmd('Target.attachToTarget', { targetId })
    guest.emit('message', {}, 'Page.loadEventFired', { timestamp: 1 }, '')
    await until(
      () => a.events.some((e) => e.method === 'Page.loadEventFired'),
      'the guest event to reach the client'
    )
    await new Promise((r) => setTimeout(r, 100))

    expect(a.events.filter((e) => e.method === 'Page.loadEventFired')).toHaveLength(1)
  })
})

describe('a socket that closes while its tab is still binding', () => {
  it('is never registered as the endpoint’s client, so a later client can still connect', async () => {
    let asked = 0
    deps.sessionForTab = (): string | null => {
      asked++
      return deps.session
    }
    deps.session = null
    const a = connect()
    await until(() => asked > 0 && a.ws.readyState === WebSocket.OPEN, 'a to be waiting')

    a.ws.close()
    await a.closed
    await new Promise((r) => setTimeout(r, 100))
    deps.session = SESSION
    asked = 0
    await until(() => asked > 0, 'the wait to see the session')
    await new Promise((r) => setTimeout(r, 100))

    const b = connect()
    expect(await b.cmd('Browser.getVersion')).toHaveProperty('result')
  })
})

// PLATFORM§10
describe('a client driving a page while the user is mid-word in an input method', () => {
  async function attachedGuest(): Promise<{ guest: FakeGuest; a: Conn; sessionId: string }> {
    const guest = fakeGuest(11)
    const a = await registered()
    const listed = (await a.cmd('Target.getTargets')).result as {
      targetInfos: { targetId: string }[]
    }
    const targetId = listed.targetInfos[0]?.targetId ?? ''
    const { sessionId } = (await a.cmd('Target.attachToTarget', { targetId })).result as {
      sessionId: string
    }
    return { guest, a, sessionId }
  }
  const evaluated = (guest: FakeGuest): number =>
    guest.debugger.sendCommand.mock.calls.filter((c) => c[0] === 'Runtime.evaluate').length
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
  }

  it('holds the command until the user finishes the word, then sends it', async () => {
    const { guest, a, sessionId } = await attachedGuest()
    composition.hostComposing(true)
    const reply = a.cmd('Runtime.evaluate', { expression: '1' }, sessionId)
    await new Promise((r) => setTimeout(r, 200))
    expect(evaluated(guest)).toBe(0)

    composition.hostComposing(false)
    expect(await reply).toHaveProperty('result')
    expect(evaluated(guest)).toBe(1)
  })

  it('drops a held command whose client went away before the word was done, so it never lands on a page a later client drives', async () => {
    const { guest, a, sessionId } = await attachedGuest()
    composition.hostComposing(true)
    void a.cmd('Runtime.evaluate', { expression: '1' }, sessionId).catch(() => {})
    await new Promise((r) => setTimeout(r, 100))
    a.ws.close()
    await until(() => !relay.relayAttached(TAB), 'the relay to drop the client')

    composition.hostComposing(false)
    await settle()
    expect(evaluated(guest)).toBe(0)
  })

  it('sends the held command anyway once the word has sat untouched for 8 s, so a composition that never ends cannot stall the agent', async () => {
    const { guest, a, sessionId } = await attachedGuest()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      composition.hostComposing(true)
      const reply = a.cmd('Runtime.evaluate', { expression: '1' }, sessionId)
      await settle()
      await vi.advanceTimersByTimeAsync(7_000)
      composition.hostComposing(true)
      await vi.advanceTimersByTimeAsync(7_000)
      await settle()
      expect(evaluated(guest)).toBe(0)

      await vi.advanceTimersByTimeAsync(1_000)
      await settle()
      expect(evaluated(guest)).toBe(1)
      expect(await reply).toHaveProperty('result')
    } finally {
      vi.useRealTimers()
    }
  })
})

// PLATFORM§16
describe('a client reloading a page', () => {
  it('reloads that guest by itself and never sends Page.reload to its debugger, which reloads the whole Koloft window', async () => {
    const guest = fakeGuest(11)
    const a = await registered()
    const listed = (await a.cmd('Target.getTargets')).result as {
      targetInfos: { targetId: string }[]
    }
    const targetId = listed.targetInfos[0]?.targetId ?? ''
    const attached = (await a.cmd('Target.attachToTarget', { targetId })).result as {
      sessionId: string
    }

    expect(await a.cmd('Page.reload', {}, attached.sessionId)).toHaveProperty('result')
    expect(await a.cmd('Page.reload', { ignoreCache: true }, attached.sessionId)).toHaveProperty(
      'result'
    )

    expect(guest.reload).toHaveBeenCalledTimes(1)
    expect(guest.reloadIgnoringCache).toHaveBeenCalledTimes(1)
    expect(guest.debugger.sendCommand.mock.calls.map((c) => c[0])).not.toContain('Page.reload')
  })
})
