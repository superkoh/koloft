import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  CdpProtocol,
  RELAY_CONTEXT_ID,
  SET_AUTO_ATTACH_REPLY_MS,
  stripDiff,
  type RelayBackend,
  type RelayTarget
} from '../../src/main/cdpProtocol'

/**
 * The relay's conversation with a CDP client (§04/§4.2).
 *
 * Unit-level because the conversation IS the contract and almost none of it is visible
 * from outside: which targets are announced, in what order the lifecycle events go out,
 * and — the ones that cost hours when wrong — the fields Playwright silently ASSERTS on
 * (type "page", a non-empty browserContextId) and the commands Koloft must answer itself
 * because Electron cannot (Target.createTarget returns nothing there).
 */

const VERSION = {
  product: 'Chrome/150.0.7871.212',
  userAgent: 'Mozilla/5.0 … Chrome/150.0.7871.212 Safari/537.36',
  revision: '@abcdef',
  jsVersion: '15.0'
}

function target(over: Partial<RelayTarget> = {}): RelayTarget {
  return { targetId: 't1', url: 'http://localhost/a', title: 'A', guestId: 11, ...over }
}

let sent: Record<string, unknown>[]
let tabs: RelayTarget[]
let backend: RelayBackend
let relay: CdpProtocol

/** every message the relay pushed that is not a reply to a command */
function events(method?: string): Record<string, unknown>[] {
  const evs = sent.filter((m) => m.method !== undefined)
  return method ? evs.filter((m) => m.method === method) : evs
}

/** the reply to command `id` */
function reply(id: number): Record<string, unknown> | undefined {
  return sent.find((m) => m.id === id)
}

beforeEach(() => {
  sent = []
  tabs = [target()]
  backend = {
    targets: () => tabs,
    mount: vi.fn(async (id: string) => tabs.find((t) => t.targetId === id)?.guestId ?? 99),
    create: vi.fn(async (url: string) => {
      const t = target({ targetId: `t${tabs.length + 1}`, url, title: '', guestId: 20 })
      tabs.push(t)
      return t
    }),
    close: vi.fn(async () => {}),
    attachGuest: vi.fn(async () => {}),
    detachGuest: vi.fn(),
    forward: vi.fn(async () => ({ ok: true })),
    version: () => VERSION
  }
  relay = new CdpProtocol((m) => sent.push(m), backend)
})

async function cmd(
  id: number,
  method: string,
  params?: unknown,
  sessionId?: string
): Promise<void> {
  await relay.handle(JSON.stringify({ id, method, params: params ?? {}, sessionId }))
}

describe('the browser-level commands the relay answers itself', () => {
  it('reports the REAL Chromium version — Playwright branches on it', async () => {
    await cmd(1, 'Browser.getVersion')
    expect(reply(1)).toEqual({
      id: 1,
      result: {
        protocolVersion: '1.3',
        product: VERSION.product,
        revision: VERSION.revision,
        userAgent: VERSION.userAgent,
        jsVersion: VERSION.jsVersion
      }
    })
  })

  it('lists every tab as a "page" target with a browserContextId, and loads none', async () => {
    tabs = [
      target({ targetId: 't1' }),
      target({ targetId: 't2', guestId: null, url: 'http://x/b' })
    ]
    await cmd(2, 'Target.getTargets')

    expect(reply(2)).toEqual({
      id: 2,
      result: {
        targetInfos: [
          {
            targetId: 't1',
            type: 'page',
            title: 'A',
            url: 'http://localhost/a',
            attached: false,
            browserContextId: RELAY_CONTEXT_ID
          },
          {
            targetId: 't2',
            type: 'page',
            title: 'A',
            url: 'http://x/b',
            attached: false,
            browserContextId: RELAY_CONTEXT_ID
          }
        ]
      }
    })
    // D4: listing a tab must not load it
    expect(backend.mount).not.toHaveBeenCalled()
  })

  // Measured against playwright-core 1.62: connectOverCDP sends this with NO targetId
  // right after the handshake, and an error here makes it drop the connection outright.
  it('answers getTargetInfo with no targetId as the BROWSER’s own target', async () => {
    await cmd(2, 'Target.getTargetInfo')
    const r = reply(2) as { result: { targetInfo: { type: string; targetId: string } } }
    expect(r.result.targetInfo.type).toBe('browser')
    expect(r.result.targetInfo.targetId).toBeTruthy()
  })

  it('answers setDownloadBehavior rather than passing it to a guest', async () => {
    await cmd(3, 'Browser.setDownloadBehavior', { behavior: 'default' })
    expect(reply(3)).toEqual({ id: 3, result: {} })
    expect(backend.forward).not.toHaveBeenCalled()
  })

  it('refuses a second browser context with an error the client can read', async () => {
    await cmd(4, 'Target.createBrowserContext')
    const r = reply(4) as { error?: { message?: string } }
    expect(r.error?.message).toBeTruthy()
    // …and the connection carries on
    await cmd(5, 'Browser.getVersion')
    expect(reply(5)).toHaveProperty('result')
  })
})

describe('attaching (the handshake Playwright actually performs)', () => {
  it('setAutoAttach attaches every tab, each with a session and a context id', async () => {
    tabs = [target({ targetId: 't1' }), target({ targetId: 't2', guestId: 12 })]
    await cmd(1, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    })

    expect(reply(1)).toEqual({ id: 1, result: {} })
    const attached = events('Target.attachedToTarget')
    expect(attached).toHaveLength(2)
    for (const ev of attached) {
      const p = ev.params as { sessionId: string; targetInfo: Record<string, unknown> }
      expect(p.sessionId).toBeTruthy()
      expect(p.targetInfo.type).toBe('page')
      expect(p.targetInfo.browserContextId).toBe(RELAY_CONTEXT_ID)
    }
    // attaching IS loading (D4's other half): both guests are mounted and piped
    expect(backend.mount).toHaveBeenCalledTimes(2)
    expect(backend.attachGuest).toHaveBeenCalledTimes(2)
  })

  it('attachToTarget touches ONE tab and answers with its session', async () => {
    tabs = [target({ targetId: 't1' }), target({ targetId: 't2', guestId: null })]
    await cmd(1, 'Target.attachToTarget', { targetId: 't2', flatten: true })

    const r = reply(1) as { result: { sessionId: string } }
    expect(r.result.sessionId).toBeTruthy()
    expect(backend.mount).toHaveBeenCalledTimes(1)
    expect(backend.mount).toHaveBeenCalledWith('t2')
    expect(events('Target.attachedToTarget')).toHaveLength(1)
  })

  // Two attaches for one target are the NORMAL case: a client's createTarget and the
  // auto-attach the same tab's arrival triggers. Announcing that page twice makes
  // Playwright drop the connection outright ("Duplicate target").
  it('attaches a target exactly once even when two attaches race', async () => {
    await Promise.all([
      cmd(1, 'Target.attachToTarget', { targetId: 't1', flatten: true }),
      cmd(2, 'Target.attachToTarget', { targetId: 't1', flatten: true })
    ])

    expect(events('Target.attachedToTarget')).toHaveLength(1)
    const a = (reply(1) as { result: { sessionId: string } }).result.sessionId
    const b = (reply(2) as { result: { sessionId: string } }).result.sessionId
    expect(a).toBe(b)
    expect(backend.attachGuest).toHaveBeenCalledTimes(1)
  })

  it('answers an unknown targetId with an error instead of attaching nothing', async () => {
    await cmd(1, 'Target.attachToTarget', { targetId: 'nope' })
    expect(reply(1)).toHaveProperty('error')
    expect(backend.mount).not.toHaveBeenCalled()
  })

  it('discovery announces the existing tabs without attaching them', async () => {
    tabs = [target({ targetId: 't1' }), target({ targetId: 't2' })]
    await cmd(1, 'Target.setDiscoverTargets', { discover: true })

    expect(reply(1)).toEqual({ id: 1, result: {} })
    expect(events('Target.targetCreated')).toHaveLength(2)
    expect(backend.attachGuest).not.toHaveBeenCalled()
  })
})

describe('session-level traffic', () => {
  async function attached(): Promise<string> {
    await cmd(1, 'Target.attachToTarget', { targetId: 't1', flatten: true })
    return (reply(1) as { result: { sessionId: string } }).result.sessionId
  }

  it('forwards a command to that tab’s guest and returns its answer', async () => {
    const sid = await attached()
    await cmd(2, 'Page.navigate', { url: 'http://x/y' }, sid)

    expect(backend.forward).toHaveBeenCalledWith(
      't1',
      11,
      'Page.navigate',
      { url: 'http://x/y' },
      undefined
    )
    expect(reply(2)).toEqual({ id: 2, sessionId: sid, result: { ok: true } })
  })

  it('turns a failed command into an error reply — never a silent hang', async () => {
    const sid = await attached()
    ;(backend.forward as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    await cmd(2, 'Page.captureScreenshot', {}, sid)

    const r = reply(2) as { error?: { message?: string }; sessionId?: string }
    expect(r.error?.message).toContain('boom')
    expect(r.sessionId).toBe(sid)
  })

  it('D3: bringToFront is answered without moving anything on screen', async () => {
    const sid = await attached()
    await cmd(2, 'Page.bringToFront', {}, sid)

    expect(reply(2)).toEqual({ id: 2, sessionId: sid, result: {} })
    expect(backend.forward).not.toHaveBeenCalled()
  })

  // Electron hands the guest's own session id over as an EMPTY STRING, not as absent.
  // Passed through, it addresses every page event to the browser session — where a
  // client reads them as belonging to no page, and its first page "detaches".
  it('passes a guest’s events up on that session, flat — an empty guest session id too', async () => {
    const sid = await attached()
    relay.fromGuest('t1', 'Page.frameNavigated', { frame: { id: 'f1' } }, '')

    expect(events('Page.frameNavigated')[0]).toEqual({
      method: 'Page.frameNavigated',
      params: { frame: { id: 'f1' } },
      sessionId: sid
    })
  })

  // A guest's own sub-targets (a cross-origin iframe, a worker) attach through flat
  // mode: the guest announces the child ON THE ROOT session, with the child's id inside
  // `params`. Getting this wrong is invisible until a client drives an OOPIF and its
  // commands come back "no session" (BB-68).
  it('learns a sub-session from the guest’s announcement and routes its commands', async () => {
    const sid = await attached()
    relay.fromGuest('t1', 'Target.attachedToTarget', {
      sessionId: 'CHILD',
      targetInfo: { targetId: 'iframe-1', type: 'iframe' }
    })

    const ev = events('Target.attachedToTarget').at(-1) as Record<string, unknown>
    expect(ev.sessionId).toBe(sid) // announced on the root, as the guest sent it
    expect((ev.params as { sessionId: string }).sessionId).toBe('CHILD')

    await cmd(3, 'Runtime.evaluate', { expression: '1' }, 'CHILD')
    expect(backend.forward).toHaveBeenLastCalledWith(
      't1',
      11,
      'Runtime.evaluate',
      { expression: '1' },
      'CHILD'
    )
  })

  it('routes a sub-session that announced itself on its own channel too', async () => {
    await attached()
    relay.fromGuest('t1', 'Runtime.executionContextCreated', {}, 'WORKER')
    await cmd(3, 'Runtime.evaluate', { expression: '1' }, 'WORKER')
    expect(backend.forward).toHaveBeenLastCalledWith(
      't1',
      11,
      'Runtime.evaluate',
      { expression: '1' },
      'WORKER'
    )
  })
})

describe('creating and closing tabs', () => {
  it('closeTarget closes that tab and says so', async () => {
    await cmd(1, 'Target.closeTarget', { targetId: 't1' })
    expect(backend.close).toHaveBeenCalledWith('t1')
    expect(reply(1)).toEqual({ id: 1, result: { success: true } })
  })
})

/**
 * The strip arrives whole on every change; the client is owed the difference. Unit-level
 * because getting it wrong is SILENT: compare the two reports in different id languages
 * and every report reads as "all new" — no error anywhere, just a client that stops
 * hearing about navigations.
 */
describe('stripDiff', () => {
  const t = (id: string, over: Partial<RelayTarget> = {}): RelayTarget =>
    target({ targetId: id, ...over })

  it('says nothing at all when nothing moved', () => {
    const list = [t('a'), t('b')]
    expect(stripDiff(list, [...list])).toEqual({ created: [], changed: [], destroyed: [] })
  })

  it('reports a new tab as created and a gone one as destroyed', () => {
    const d = stripDiff([t('a'), t('b')], [t('b'), t('c')])
    expect(d.created.map((x) => x.targetId)).toEqual(['c'])
    expect(d.destroyed).toEqual(['a'])
    expect(d.changed).toEqual([])
  })

  it('reports a navigation and a retitle as a CHANGE, never as a new target', () => {
    const d = stripDiff(
      [t('a', { url: 'http://x/1', title: 'One' })],
      [t('a', { url: 'http://x/2', title: 'Two' })]
    )
    expect(d.changed.map((x) => x.url)).toEqual(['http://x/2'])
    expect(d.created).toEqual([])
    expect(d.destroyed).toEqual([])
  })

  it('ignores a guest arriving on a tab — that is an attach, not a target change', () => {
    const d = stripDiff([t('a', { guestId: null })], [t('a', { guestId: 7 })])
    expect(d).toEqual({ created: [], changed: [], destroyed: [] })
  })
})

describe('lifecycle events', () => {
  // Chrome's own rule: targetCreated belongs to DISCOVERY, attachedToTarget to
  // auto-attach. A client that asked for one must not be handed the other.
  it('with auto-attach on, a new tab arrives as an attach (not as a discovery event)', async () => {
    await cmd(1, 'Target.setAutoAttach', { autoAttach: true, flatten: true })
    sent = []
    await relay.targetCreated(target({ targetId: 't9', guestId: 30 }))

    expect(events('Target.attachedToTarget')).toHaveLength(1)
    expect(events('Target.targetCreated')).toHaveLength(0)
  })

  it('with discovery on, a new tab arrives as targetCreated', async () => {
    await cmd(1, 'Target.setDiscoverTargets', { discover: true })
    sent = []
    await relay.targetCreated(target({ targetId: 't9', guestId: 30 }))

    expect(events('Target.targetCreated')).toHaveLength(1)
    expect(events('Target.attachedToTarget')).toHaveLength(0)
  })

  it('a closing tab detaches BEFORE it is destroyed (§4.3 order)', async () => {
    await cmd(1, 'Target.attachToTarget', { targetId: 't1', flatten: true })
    sent = []
    relay.targetDestroyed('t1')

    const order = events().map((m) => m.method)
    expect(order).toEqual(['Target.detachedFromTarget', 'Target.targetDestroyed'])
    expect(backend.detachGuest).toHaveBeenCalledWith('t1')
  })

  it('an unattached tab is simply destroyed — no detach for a session that never was', async () => {
    await cmd(1, 'Target.setDiscoverTargets', { discover: true })
    sent = []
    relay.targetDestroyed('t1')
    expect(events().map((m) => m.method)).toEqual(['Target.targetDestroyed'])
  })

  it('D6: the user opening DevTools takes the target back, with a reason the client sees', async () => {
    await cmd(1, 'Target.attachToTarget', { targetId: 't1', flatten: true })
    sent = []
    relay.forceDetach('t1', 'DevTools opened')

    expect(events('Target.detachedFromTarget')).toHaveLength(1)
    expect(backend.detachGuest).toHaveBeenCalledWith('t1')
    // the target still exists — the tab is fine, only the client's grip is gone
    expect(events('Target.targetDestroyed')).toHaveLength(0)
  })

  it('a navigation is reported as targetInfoChanged, not as a new target', async () => {
    await cmd(1, 'Target.setDiscoverTargets', { discover: true })
    sent = []
    relay.targetInfoChanged(target({ url: 'http://x/moved', title: 'Moved' }))

    const ev = events('Target.targetInfoChanged')[0]
    expect((ev.params as { targetInfo: { url: string } }).targetInfo.url).toBe('http://x/moved')
    expect(events('Target.targetCreated')).toHaveLength(0)
  })
})

// Chrome never fails Target.setAutoAttach because ONE target could not be attached, and
// Playwright reads a failure there as "there is no browser": the whole connectOverCDP
// rejects, and the endpoint stays unusable for exactly as long as that one tab exists.
// A tab that cannot be driven (its guest never mounts, another debugger holds it) must
// cost the client that tab, not the session — it stays listed, and attaching it by hand
// still returns the real error.
describe('one tab that cannot be driven does not take the endpoint down', () => {
  function targetIdOf(ev: Record<string, unknown>): string {
    return (ev.params as { targetInfo: { targetId: string } }).targetInfo.targetId
  }

  it('setAutoAttach skips the tab whose attach fails and still attaches the rest', async () => {
    tabs = [
      target(),
      target({ targetId: 't2', url: 'http://localhost/b', title: 'B', guestId: 12 })
    ]
    backend.attachGuest = vi.fn(async (targetId: string) => {
      if (targetId === 't1') throw new Error('cannot attach to t1')
    })

    await cmd(1, 'Target.setAutoAttach', { autoAttach: true, flatten: true })

    expect(reply(1)).toEqual({ id: 1, result: {} })
    const attached = events('Target.attachedToTarget')
    expect(attached.map(targetIdOf)).toEqual(['t2'])
    // the skipped tab is still a target the client can reach for
    await cmd(2, 'Target.getTargets')
    const listed = (reply(2)?.result as { targetInfos: { targetId: string; attached: boolean }[] })
      .targetInfos
    expect(listed.find((t) => t.targetId === 't1')?.attached).toBe(false)
  })

  it('createTarget answers with the page it made even when that page cannot be attached', async () => {
    backend.attachGuest = vi.fn(async (targetId: string) => {
      if (targetId === 't2') throw new Error('cannot attach to t2')
    })
    await cmd(1, 'Target.setDiscoverTargets', { discover: true })
    await cmd(2, 'Target.setAutoAttach', { autoAttach: true, flatten: true })
    sent = []

    await cmd(3, 'Target.createTarget', { url: 'http://localhost/new' })

    // the page exists — reporting the create as failed would hand the client a page it
    // cannot see under a targetId it never learns
    expect(reply(3)).toEqual({ id: 3, result: { targetId: 't2' } })
    expect(events('Target.targetCreated').map(targetIdOf)).toEqual(['t2'])
    expect(events('Target.attachedToTarget')).toHaveLength(0)
  })

  // The attaches run one at a time, and each may take its whole mount budget to fail.
  // The reply must not wait for all of them: Playwright gives the entire handshake 30s,
  // so a strip of tabs that cannot be driven would otherwise turn "those tabs are
  // unusable" into "there is no browser".
  it('setAutoAttach replies within its budget even while a tab is still mounting', async () => {
    vi.useFakeTimers()
    try {
      tabs = [
        target(),
        target({ targetId: 't2', url: 'http://localhost/b', title: 'B', guestId: 12 })
      ]
      backend.attachGuest = vi.fn(
        (targetId: string) => new Promise<void>((resolve) => targetId !== 't1' && resolve())
      ) // t1 never finishes
      void cmd(1, 'Target.setAutoAttach', { autoAttach: true, flatten: true })

      await vi.advanceTimersByTimeAsync(SET_AUTO_ATTACH_REPLY_MS)
      expect(reply(1)).toEqual({ id: 1, result: {} })
    } finally {
      vi.useRealTimers()
    }
  })
})

/** let every already-queued microtask run */
async function tick(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/**
 * The relay hands every client message to `handle` through ONE promise chain, so
 * whatever `handle` waits for, the whole connection waits for. A page command can
 * legitimately take minutes (an evaluate that only finishes once the client answers a
 * paused request; a wait-for-selector), and holding the line behind it is not merely
 * slow — it is a deadlock, because the answer the client owes travels on that same line.
 */
describe('a slow page command does not hold the connection', () => {
  async function attached(): Promise<string> {
    await cmd(1, 'Target.attachToTarget', { targetId: 't1', flatten: true })
    return (reply(1) as { result: { sessionId: string } }).result.sessionId
  }

  // The exact deadlock: page.route + page.evaluate(fetch). The evaluate cannot finish
  // until the client's Fetch.continueRequest lands, and that command was queued behind
  // the evaluate.
  it('answers a second command while the first is still running', async () => {
    const sid = await attached()
    let release!: (v: unknown) => void
    ;(backend.forward as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve))
    )

    let dispatched = false
    void relay
      .handle(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: {}, sessionId: sid }))
      .then(() => (dispatched = true))
    await tick()
    expect(dispatched).toBe(true) // the line is free again, though nothing was answered
    expect(reply(2)).toBeUndefined()

    await cmd(3, 'Fetch.continueRequest', { requestId: 'r1' }, sid)
    expect(reply(3)).toEqual({ id: 3, sessionId: sid, result: { ok: true } })

    release({ ok: 'evaluated' })
    await tick()
    expect(reply(2)).toEqual({ id: 2, sessionId: sid, result: { ok: 'evaluated' } })
  })

  // Browser-level commands keep their in-order semantics: an attach and the first
  // command on the session it mints arrive back to back.
  it('keeps browser-level commands in order — attach finishes before handle returns', async () => {
    let finish!: (guestId: number) => void
    backend.mount = vi.fn(() => new Promise<number>((resolve) => (finish = resolve)))
    let done = false
    void cmd(1, 'Target.attachToTarget', { targetId: 't1', flatten: true }).then(
      () => (done = true)
    )
    await tick()
    expect(done).toBe(false)
    finish(11)
    await tick()
    expect(done).toBe(true)
  })
})

/**
 * Nothing in Koloft awaits the promise `targetCreated` returns (both callers drop it with
 * `void`), and the main process has no `unhandledRejection` handler — so a rejection
 * here is promoted to an uncaught exception and Electron raises its native "A
 * JavaScript error occurred in the main process" dialog. Every ordinary attach failure
 * (DevTools open on that tab, a mount that times out, the tab cap) would do it.
 */
describe('an automatic attach that fails stays quiet', () => {
  it('targetCreated resolves even when the attach cannot be done', async () => {
    tabs = []
    await cmd(1, 'Target.setAutoAttach', { autoAttach: true, flatten: true })
    backend.mount = vi.fn(async () => {
      throw new Error('the guest never mounted')
    })

    await expect(
      relay.targetCreated(target({ targetId: 't9', guestId: null }))
    ).resolves.toBeUndefined()
    expect(events('Target.attachedToTarget')).toHaveLength(0)
  })
})

/**
 * An attach waits twice (the mount, then the guest's frame-tree call), and a tab can be
 * closed inside either wait. Without a check the mount lands on a tab that no longer
 * exists: the client is told a destroyed target just attached, and the strip keeps
 * showing a closed tab as driven.
 */
describe('a tab closed while it is attaching', () => {
  it('is never announced as attached when it goes while mounting', async () => {
    let finish!: (guestId: number) => void
    backend.mount = vi.fn(() => new Promise<number>((resolve) => (finish = resolve)))
    const attaching = cmd(1, 'Target.attachToTarget', { targetId: 't1', flatten: true })
    await tick()

    relay.targetDestroyed('t1')
    tabs = []
    finish(11)
    await attaching

    expect(backend.attachGuest).not.toHaveBeenCalled()
    expect(events('Target.attachedToTarget')).toHaveLength(0)
    // a hand-written attach hears why, rather than getting a session over a dead tab
    expect((reply(1) as { error?: { message?: string } }).error?.message).toBeTruthy()
  })

  it('is undone when it goes while the guest is being piped', async () => {
    let finish!: () => void
    backend.attachGuest = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    const attaching = cmd(1, 'Target.attachToTarget', { targetId: 't1', flatten: true })
    await tick()

    relay.targetDestroyed('t1')
    tabs = []
    finish()
    await attaching

    expect(events('Target.attachedToTarget')).toHaveLength(0)
    // the guest that was piped in the meantime is let go again
    expect(backend.detachGuest).toHaveBeenCalledWith('t1')
    expect((reply(1) as { error?: { message?: string } }).error?.message).toBeTruthy()
  })
})
