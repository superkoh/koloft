/**
 * The Koloft CDP relay's protocol core (§04) — the half that speaks Chrome's
 * remote-debugging language, with no Electron and no socket in it.
 *
 * What it is for: agent browser tools (playwright-mcp, the Playwright CLI) drive a
 * browser through CDP. Koloft's Browser is a set of <webview> guests, which such a client
 * refuses to drive — Playwright only accepts targets of type "page" — and Electron's own
 * `Target.createTarget` returns nothing, so a client cannot even open a page. The relay
 * therefore says "page" on the guests' behalf, answers the handful of browser-level
 * commands Koloft has to answer itself, and forwards everything else to the guest's own
 * `webContents.debugger`.
 *
 * Split out from the socket so the translation is testable as data in / data out: the
 * conversation IS the contract, and almost none of it has an observable side effect a
 * black-box case could pin instead.
 */

import type { BrowserStripTarget } from '@shared/types'

/** One Browser tab as the relay describes it to a client — the strip's own report. */
export type RelayTarget = BrowserStripTarget

/** Everything the protocol needs the rest of Koloft to do for it. */
export interface RelayBackend {
  /** the tabs of the session this endpoint belongs to, strip order */
  targets(): RelayTarget[]
  /** give this tab a live guest (mounting it in the background if need be) */
  mount(targetId: string): Promise<number>
  /** a CDP-source new tab: never deduped against an existing url (§4.1c) */
  create(url: string): Promise<RelayTarget>
  close(targetId: string): Promise<void>
  /** start piping this guest's debugger through `fromGuest` */
  attachGuest(targetId: string, guestId: number): Promise<void>
  detachGuest(targetId: string): void
  /** one command down to a guest; rejects on protocol error, or on the timeout that
   *  keeps a hung command (S1: a screenshot off screen never answers) from wedging the
   *  client for good */
  forward(
    targetId: string,
    guestId: number,
    method: string,
    params: unknown,
    sessionId?: string
  ): Promise<unknown>
  /** the real Chromium version this Electron carries — Playwright branches on it */
  version(): { product: string; userAgent: string; revision: string; jsVersion: string }
}

/** Playwright asserts a non-empty browserContextId on every attached target. */
export const RELAY_CONTEXT_ID = 'KOLOFT-BROWSER-CONTEXT'
/** How long `Target.setAutoAttach` may hold its reply while it attaches the tabs that
 *  already exist: Playwright gives the whole handshake 30s, and several tabs that cannot
 *  be driven would otherwise cost a full mount budget each. Past this the reply goes out
 *  and the rest keep attaching behind it, announcing themselves as they land. */
export const SET_AUTO_ATTACH_REPLY_MS = 20_000

/** Resolve when `work` settles or after `ms`, whichever is first, leaving no timer
 *  behind. `work` keeps running either way — the caller wants to stop WAITING on it,
 *  not to cancel it. */
function raceBudget(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    void work.then(finish, finish)
  })
}

/** what the relay calls the browser itself, for the one command that asks about it */
export const RELAY_BROWSER_TARGET_ID = 'KOLOFT-BROWSER'

interface Incoming {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
}

/** What changed between two reports of a strip, in the events a client is owed. */
export interface StripDiff {
  created: RelayTarget[]
  changed: RelayTarget[]
  destroyed: string[]
}

/**
 * The strip is reported whole, every time it changes; a client wants the difference.
 * Pure, and tested, because the two sides of the comparison arrive in different
 * languages (the strip speaks tab ids, a client speaks target ids) and comparing across
 * them silently turns every report into "everything is new" — no error, no crash, just a
 * client that never hears about a navigation again.
 */
export function stripDiff(before: RelayTarget[], next: RelayTarget[]): StripDiff {
  const was = new Map(before.map((t) => [t.targetId, t]))
  const now = new Set(next.map((t) => t.targetId))
  const created: RelayTarget[] = []
  const changed: RelayTarget[] = []
  for (const t of next) {
    const prev = was.get(t.targetId)
    if (!prev) created.push(t)
    else if (prev.url !== t.url || prev.title !== t.title) changed.push(t)
  }
  return {
    created,
    changed,
    destroyed: before.filter((t) => !now.has(t.targetId)).map((t) => t.targetId)
  }
}

/** what a client is told a target is */
function targetInfo(t: RelayTarget, attached: boolean): Record<string, unknown> {
  return {
    targetId: t.targetId,
    // the whole point of the relay: a webview is refused, a page is driven
    type: 'page',
    title: t.title,
    url: t.url,
    attached,
    browserContextId: RELAY_CONTEXT_ID
  }
}

export class CdpProtocol {
  /** our own session id per attached target (sub-sessions keep the guest's own ids) */
  private readonly sessions = new Map<string, string>()
  /** …and back: session id → targetId, for both ours and the guest's sub-sessions */
  private readonly owners = new Map<string, string>()
  /** attaches in flight, by target — see `attach` */
  private readonly attaching = new Map<string, Promise<string>>()
  /** how many times each target has been destroyed — an attach in flight reads it to
   *  find out whether the tab it is mounting is still there (see `doAttach`). Entries
   *  are kept for the endpoint's life, one small number per tab ever opened: deleting
   *  one would reset it to the value a stale attach is still holding. */
  private readonly destroys = new Map<string, number>()
  /** attach every target that appears from now on (Playwright's flat auto-attach) */
  private autoAttach = false
  private discovering = false
  private nextSession = 1

  constructor(
    private readonly send: (msg: Record<string, unknown>) => void,
    private readonly backend: RelayBackend
  ) {}

  async handle(raw: string): Promise<void> {
    let msg: Incoming
    try {
      msg = JSON.parse(raw) as Incoming
    } catch {
      return // a client that cannot frame JSON has nothing to be answered
    }
    const { id, method, sessionId } = msg
    const params = msg.params ?? {}
    if (typeof id !== 'number' || typeof method !== 'string') return
    if (sessionId) {
      // A SESSION command is DISPATCHED, not awaited: every client message goes through
      // one promise chain, and a page command can only finish once a LATER message
      // arrives (page.route + fetch, a 30s waitForSelector) — awaiting it deadlocks the
      // connection. The lookups that must stay ordered run in the synchronous prefix;
      // the reply lands when the forward settles, failure included.
      void this.onSessionCommand(sessionId, method, params).then(
        (result) => this.reply(id, result, sessionId),
        (e) => this.fail(id, e instanceof Error ? e.message : String(e), sessionId)
      )
      return
    }
    try {
      // browser-level: in order, because attach ordering is the thing the chain protects
      this.reply(id, await this.onBrowserCommand(method, params))
    } catch (e) {
      this.fail(id, e instanceof Error ? e.message : String(e))
    }
  }

  // ---- browser-level -------------------------------------------------------------

  private async onBrowserCommand(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    switch (method) {
      case 'Browser.getVersion': {
        const v = this.backend.version()
        return {
          protocolVersion: '1.3',
          product: v.product,
          revision: v.revision,
          userAgent: v.userAgent,
          jsVersion: v.jsVersion
        }
      }
      // every connectOverCDP client sends these two; neither means anything to a guest
      case 'Browser.setDownloadBehavior':
      case 'Browser.close':
        return {}
      case 'Target.getBrowserContexts':
        return { browserContextIds: [RELAY_CONTEXT_ID] }
      case 'Target.createBrowserContext':
      case 'Target.disposeBrowserContext':
        // MVP: one shared context, which is the whole point — the agent drives the same
        // logged-in browser the user has (D10 is what makes that a decision, not an
        // accident). The reference implementations refuse this too.
        throw new Error('Target.createBrowserContext is not supported by the Koloft relay')
      case 'Target.getTargets':
        return { targetInfos: this.backend.targets().map((t) => targetInfo(t, this.attached(t))) }
      case 'Target.getTargetInfo':
        // Playwright asks this straight after the handshake, with no targetId: what it
        // wants is the BROWSER's own target, and a client that gets an error here gives
        // up on the connection entirely (measured against playwright-core 1.62, which
        // never asks about a page this way).
        return {
          targetInfo: {
            targetId: RELAY_BROWSER_TARGET_ID,
            type: 'browser',
            title: 'Koloft',
            url: '',
            attached: true
          }
        }
      case 'Target.setDiscoverTargets': {
        this.discovering = params.discover !== false
        if (this.discovering) {
          for (const t of this.backend.targets()) this.emitCreated(t)
        }
        return {}
      }
      case 'Target.setAutoAttach': {
        this.autoAttach = params.autoAttach !== false
        if (this.autoAttach) {
          // Attach every existing tab, but do NOT hold the reply for the slow ones: the
          // attaches run one at a time (§4.1a's single stage), each can take its whole
          // mount budget, and Playwright's connectOverCDP gives the entire handshake 30s
          // — so N un-mountable tabs would turn "those tabs are unusable" into "there is
          // no browser". The loop keeps running in the background, announcing each tab as
          // it lands; the reply goes out once they finish or the budget is up.
          const targets = this.backend.targets()
          const all = (async (): Promise<void> => {
            for (const t of targets) await this.tryAttach(t)
          })()
          await raceBudget(all, SET_AUTO_ATTACH_REPLY_MS)
        }
        return {}
      }
      case 'Target.attachToTarget': {
        const t = this.find(String(params.targetId ?? ''))
        return { sessionId: await this.attach(t) }
      }
      case 'Target.detachFromTarget': {
        const sid = String(params.sessionId ?? '')
        const owner = this.owners.get(sid)
        if (owner) this.detach(owner, 'Target.detachFromTarget')
        return {}
      }
      case 'Target.createTarget': {
        const t = await this.backend.create(String(params.url ?? 'about:blank'))
        this.emitCreated(t)
        // the page exists from here on, whatever its attach does: an error now would
        // hand the client a page it cannot see under a targetId it never learns
        if (this.autoAttach) await this.tryAttach(t)
        return { targetId: t.targetId }
      }
      case 'Target.closeTarget': {
        const t = this.find(String(params.targetId ?? ''))
        await this.backend.close(t.targetId)
        return { success: true }
      }
      default:
        throw new Error(`'${method}' is not supported by the Koloft relay`)
    }
  }

  // ---- session-level -------------------------------------------------------------

  private async onSessionCommand(
    sessionId: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const targetId = this.owners.get(sessionId)
    if (!targetId) throw new Error(`no session ${sessionId}`)
    // D3: a client may ask for the foreground and is told yes; nothing on screen moves —
    // the pane never opens itself and the strip never switches tabs behind the user
    if (method === 'Page.bringToFront') return {}
    const guestId = this.guestFor(targetId)
    // ours is the target's own session; anything else is a sub-session the guest itself
    // minted (OOPIF, worker) and its id travels back down unchanged
    const sub = this.sessions.get(targetId) === sessionId ? undefined : sessionId
    return await this.backend.forward(targetId, guestId, method, params, sub)
  }

  // ---- what the rest of Koloft tells us ---------------------------------------------

  /** async because attaching mounts the guest first; callers may ignore the promise */
  async targetCreated(t: RelayTarget): Promise<void> {
    this.emitCreated(t)
    // `tryAttach`, never `attach`: nobody awaits this promise, and main has no
    // `unhandledRejection` handler — a rejection here is Electron's native error dialog.
    // An automatic attach costs the client that tab, not the app.
    if (this.autoAttach) await this.tryAttach(t)
  }

  targetDestroyed(targetId: string): void {
    this.gone(targetId)
    // §4.3: the client hears the detach BEFORE the destroy, so a pinned guest is never
    // torn down under a session that still believes it holds it
    this.detach(targetId, 'Target.targetDestroyed')
    this.send({ method: 'Target.targetDestroyed', params: { targetId } })
  }

  targetInfoChanged(t: RelayTarget): void {
    this.send({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: targetInfo(t, this.attached(t)) }
    })
  }

  fromGuest(targetId: string, method: string, params: unknown, sessionId?: string): void {
    const own = this.sessions.get(targetId)
    if (!own) return // nothing is listening to this guest
    // Where sub-sessions come from, both ways round: a guest announces a child target
    // (an OOPIF, a worker) ON ITS ROOT session with the child's id inside `params`, and
    // afterwards the child's own traffic arrives carrying that id. Learn it from either,
    // or the client's first command to the child comes back "no session".
    if (method === 'Target.attachedToTarget') {
      const child = (params as { sessionId?: unknown } | null)?.sessionId
      if (typeof child === 'string' && child) this.owners.set(child, targetId)
    }
    if (sessionId && !this.owners.has(sessionId)) this.owners.set(sessionId, targetId)
    // `||`, not `??`: Electron reports the guest's OWN (root) session as an empty
    // string, and `??` would pass that straight through — every page event would then
    // be addressed to the browser session, where a client reads it as belonging to no
    // page at all ("Frame has been detached" on the first newPage — measured).
    this.send({ method, params: params ?? {}, sessionId: sessionId || own })
  }

  forceDetach(targetId: string, reason: string): void {
    this.detach(targetId, reason)
  }

  // ---- helpers ---------------------------------------------------------------------

  private find(targetId: string): RelayTarget {
    const t = this.backend.targets().find((x) => x.targetId === targetId)
    if (!t) throw new Error(`no target ${targetId}`)
    return t
  }

  private attached(t: RelayTarget): boolean {
    return this.sessions.has(t.targetId)
  }

  private guestFor(targetId: string): number {
    const guestId = this.find(targetId).guestId
    if (guestId === null) throw new Error(`target ${targetId} has no live page`)
    return guestId
  }

  private emitCreated(t: RelayTarget): void {
    if (!this.discovering) return
    this.send({
      method: 'Target.targetCreated',
      params: { targetInfo: targetInfo(t, this.attached(t)) }
    })
  }

  /**
   * The AUTOMATIC attaches — everything a client did not ask for by name. Chrome never
   * fails setAutoAttach because one target could not be attached, and Playwright reads
   * a failure there as "there is no browser": the whole connectOverCDP rejects, and the
   * endpoint stays unusable for exactly as long as that one tab exists. So a tab that
   * cannot be driven costs the client that tab, not the session: it stays listed
   * unattached, `attaching` is already cleared on the way out, and attaching it by
   * name still returns the real error (the relay's notice fired on the way in).
   */
  private async tryAttach(t: RelayTarget): Promise<void> {
    try {
      await this.attach(t)
    } catch {
      /* this tab's problem, reported where it happened — not the endpoint's */
    }
  }

  private async attach(t: RelayTarget): Promise<string> {
    const existing = this.sessions.get(t.targetId)
    if (existing) return existing
    // Two attaches for one target arrive routinely — the client's own createTarget and
    // the auto-attach that the same tab's arrival in the strip triggers. Mounting takes
    // a moment, so without this they both get past the check above and the client is
    // told about one page TWICE, which Playwright rejects outright ("Duplicate target").
    const already = this.attaching.get(t.targetId)
    if (already) return await already
    const pending = this.doAttach(t)
    this.attaching.set(t.targetId, pending)
    try {
      return await pending
    } finally {
      this.attaching.delete(t.targetId)
    }
  }

  private gone(targetId: string): void {
    this.destroys.set(targetId, (this.destroys.get(targetId) ?? 0) + 1)
  }

  /**
   * An attach waits twice (the mount, the guest's frame-tree call) and the tab can be
   * closed inside either wait, with no session to detach yet — unchecked, the client is
   * told a DESTROYED target just attached. Hence the destroy count, read on the way in
   * and re-read after each wait; a count rather than a set, so a targetId that comes
   * back does not look alive to the attach already in flight.
   */
  private async doAttach(t: RelayTarget): Promise<string> {
    const era = this.destroys.get(t.targetId) ?? 0
    /** did this tab close while we were waiting? then undo and say so */
    const lost = (): boolean => (this.destroys.get(t.targetId) ?? 0) !== era
    const abandon = (): never => {
      // whatever the mount gave us is let go again; harmless when there is nothing to let
      // go, and the only way a guest piped in the meantime stops being pinned as driven
      this.backend.detachGuest(t.targetId)
      throw new Error(`target ${t.targetId} was closed while attaching`)
    }
    const guestId = await this.backend.mount(t.targetId)
    if (lost()) abandon()
    await this.backend.attachGuest(t.targetId, guestId)
    if (lost()) abandon()
    const sessionId = `KOLOFT-${this.nextSession++}`
    this.sessions.set(t.targetId, sessionId)
    this.owners.set(sessionId, t.targetId)
    this.send({
      method: 'Target.attachedToTarget',
      params: {
        sessionId,
        targetInfo: targetInfo({ ...t, guestId }, true),
        waitingForDebugger: false
      }
    })
    return sessionId
  }

  private detach(targetId: string, reason: string): void {
    const sessionId = this.sessions.get(targetId)
    if (!sessionId) return
    this.sessions.delete(targetId)
    for (const [sid, owner] of this.owners) if (owner === targetId) this.owners.delete(sid)
    this.backend.detachGuest(targetId)
    this.send({
      method: 'Target.detachedFromTarget',
      params: { sessionId, targetId, reason }
    })
  }

  private reply(id: number, result: unknown, sessionId?: string): void {
    this.send(sessionId ? { id, sessionId, result } : { id, result })
  }

  private fail(id: number, message: string, sessionId?: string): void {
    const error = { code: -32000, message }
    this.send(sessionId ? { id, sessionId, error } : { id, error })
  }
}
