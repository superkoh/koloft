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
  debugger: {
    attach: ReturnType<typeof vi.fn>
    detach: ReturnType<typeof vi.fn>
    isAttached(): boolean
    on(event: string, fn: (...a: never[]) => void): void
    once(event: string, fn: (...a: never[]) => void): void
    off(event: string, fn: (...a: never[]) => void): void
    sendCommand(method: string, params?: unknown, sessionId?: string): Promise<unknown>
  }
  listenerCount(): number
  releaseFrameTree(): void
  emit(event: string, ...args: unknown[]): void
}

function fakeGuest(id: number, opts: { holdFrameTree?: boolean } = {}): FakeGuest {
  const listeners = new Map<string, Set<(...a: never[]) => void>>()
  let attached = false
  let release = (): void => {}
  const add = (event: string, fn: (...a: never[]) => void): void => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)?.add(fn)
  }
  const guest: FakeGuest = {
    isDestroyed: () => false,
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
      sendCommand: async (method: string) => {
        if (method === 'Page.getFrameTree') {
          if (opts.holdFrameTree) await new Promise<void>((r) => (release = r))
          return { frameTree: { frame: { id: `frame-${id}` } } }
        }
        return {}
      }
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
    mount: vi.fn(async () => 11),
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
let deps: Harness
const sockets: WebSocket[] = []

interface Conn {
  ws: WebSocket
  closed: Promise<string>
  cmd(method: string, params?: unknown): Promise<Record<string, unknown>>
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
    cmd: (method, params) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = nextId++
        replies.set(id, resolve)
        closed.then(() => reject(new Error('socket closed before the reply')))
        const send = (): void => ws.send(JSON.stringify({ id, method, params: params ?? {} }))
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
  relay.startRelay(deps)
  relay.relayStripChanged(SESSION, deps.strip)
  relay.setRelayEnabled(true, [TAB])
  await until(() => relay.relayEndpoint(TAB) !== '', 'the relay to listen')
})

afterEach(() => {
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
