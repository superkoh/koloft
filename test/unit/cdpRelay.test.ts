import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import WebSocket from 'ws'
import type { RelayTarget } from '../../src/main/cdpProtocol'
import type { RelayDeps } from '../../src/main/cdpRelay'

/**
 * The socket half of the CDP relay (§04) — the part the protocol suite
 * cannot see: who is allowed to connect, what a half-finished connection may still do
 * after the world moved under it, and what is left behind when a client vanishes
 * mid-handshake.
 *
 * Every case here drives the REAL server: `startRelay` + `setRelayEnabled` open an
 * actual ws server on a free port, and a real `ws` client talks to it over a real
 * socket. Only Electron (`app.getPath`, `webContents`) and the app-side deps are
 * stubbed, because the bugs these cases pin are all about ORDER — a close handler
 * firing before registration, a switch flipping inside an await — and order is exactly
 * what a hand-called `onConnection` would not reproduce.
 */

// ---- the electron seam --------------------------------------------------------------

let userData = ''
const guests = new Map<number, FakeGuest>()

vi.mock('electron', () => ({
  app: { getPath: (): string => userData },
  webContents: { fromId: (id: number): FakeGuest | undefined => guests.get(id) }
}))

/** a guest webContents with just the debugger surface the relay touches */
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
  /** how many listeners the relay currently has on this guest */
  listenerCount(): number
  /** the next `Page.getFrameTree` waits until this is called */
  releaseFrameTree(): void
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
    releaseFrameTree: () => release()
  }
  guests.set(id, guest)
  return guest
}

// ---- the app-side deps --------------------------------------------------------------

const TAB = 'tab-1'
const SESSION = 'sess-1'

interface Harness extends RelayDeps {
  /** what `sessionForTab` answers; null = "not bound yet" */
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

// ---- harness ------------------------------------------------------------------------

type Relay = typeof import('../../src/main/cdpRelay')

let relay: Relay
let deps: Harness
const sockets: WebSocket[] = []

/** a live connection, with everything a case needs to observe it */
interface Conn {
  ws: WebSocket
  /** resolves with the close reason the server gave, if any */
  closed: Promise<string>
  /** send a command and wait for its reply (or its error) */
  cmd(method: string, params?: unknown): Promise<Record<string, unknown>>
  /** the ids of every event the relay pushed */
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

/** a connection that got past the handshake — proven by an answered command */
async function registered(): Promise<Conn> {
  const c = connect()
  await c.cmd('Browser.getVersion')
  return c
}

/** the reason the server closed a socket with, or a readable stand-in — never a hang:
 *  a connection that stays up when it should have been refused IS the failure, and it
 *  should read that way rather than as a test timeout. */
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
  relay.relayStripChanged(SESSION, deps.strip) // the renderer's report IS the registry
  relay.setRelayEnabled(true, [TAB])
  await until(() => relay.relayEndpoint(TAB) !== '', 'the relay to listen')
})

afterEach(() => {
  for (const ws of sockets.splice(0)) ws.close()
  relay.setRelayEnabled(false, [])
  fs.rmSync(userData, { recursive: true, force: true })
})

// ---- cases --------------------------------------------------------------------------

describe('one client per endpoint (D8)', () => {
  it('a refused second connection does not take the first client down with it', async () => {
    const a = await registered()

    const b = connect()
    expect(await closedReason(b)).toBe('this endpoint already has a client')

    // the whole bug in one assertion: if B's own `close` dropped A, the endpoint is free
    // again and a third connection walks straight in
    const c = connect()
    expect(await closedReason(c)).toBe('this endpoint already has a client')
    // …and nothing told the strip that A stopped driving
    expect(deps.setAttached).not.toHaveBeenCalled()
    // A is still the client
    expect(await a.cmd('Browser.getVersion')).toHaveProperty('result')
  })
})

describe('the master switch reaches connections that are still handshaking (D2)', () => {
  it('refuses a connection that was waiting for its session when the switch went off', async () => {
    deps.session = null
    const a = connect()
    await until(() => deps.sessionForTab(TAB) === null && a.ws.readyState === WebSocket.OPEN, 'a')

    relay.setRelayEnabled(false, [TAB])
    deps.session = SESSION // the session binds a moment later — too late

    expect(await closedReason(a)).toBe('the Koloft browser endpoint is off')
  })
})

describe('a tab whose session went away (§4.4)', () => {
  it('a rebind to the SAME session changes nothing — the client keeps its pages', async () => {
    // The handshake reads the tracker's live state, but the "session bound" record that
    // drives rebinds lands on a throttled event a moment later. That event must not read
    // as "the session changed": it used to tear every page down and announce it again,
    // and Playwright drops a page the instant it is told it detached (measured: BB-38/39
    // saw one page where it had just opened two).
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
    // the tab must never be pinned as "being driven" for a client that is gone
    for (const call of (deps.setAttached as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).toEqual([])
    }
  })
})
