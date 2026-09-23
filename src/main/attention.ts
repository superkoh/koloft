/**
 * Attention layer: derives "this session needs the user" events from
 * SessionStatus transitions and keeps the per-tab pending set that every outlet
 * renders — sidebar badges / Needs-you strip now, toasts / OS notifications /
 * dock badge in the notification PR. One state source keeps all outlets agreeing.
 *
 * Pure logic, no Electron imports: the caller supplies the moment's context
 * (window focus + active tab) and receives changes through one callback.
 */

import type { AttentionEvent, AttentionKind, SessionStatus } from '@shared/types'

export interface AttentionContext {
  windowFocused: boolean
  activeTabId: string | null
}

/** A suppressed event this much younger than a switch-away was likely a stale-context
 *  race (the status hook outran the renderer's active-tab report), not a seen event. */
export const RECONSIDER_WINDOW_MS = 3000

export class AttentionTracker {
  private pending = new Map<string, AttentionEvent>()
  // events swallowed by the watching rule, kept briefly so a switch-away that raced
  // the suppression can resurrect them (see reconsider)
  private recentlySuppressed = new Map<string, AttentionEvent>()

  /** `event` is the freshly-raised event (for one-shot outlets like toasts/OS
   *  notifications), null when the change was a clear. `pending` is the full set. */
  constructor(
    private readonly onChange: (pending: AttentionEvent[], event: AttentionEvent | null) => void
  ) {}

  /** A claude tab's run-state moved. Only *transitions* raise events:
   *   working  → waiting  = the turn finished, the user's move   → 'turn-done'
   *   approval → waiting  = ditto — Stop can beat the jsonl poll that would have
   *                         flipped a granted approval back to 'working' first, so
   *                         this edge is a finished turn too, not a downgrade
   *   *        → approval = a tool is blocked on permission      → 'approval'
   *   *        → working  = the session is busy again            → clears pending
   *   waiting  → idle     = visual downgrade only, already notified at 'waiting'
   *  `title` is snapshotted into the event: an exited session is untracked moments
   *  later, and a marker whose tab already reverted must still name its session. */
  onStatusChange(
    tabId: string,
    prev: SessionStatus | undefined,
    next: SessionStatus,
    ctx: AttentionContext,
    title?: string
  ): void {
    if (next === 'working') {
      this.recentlySuppressed.delete(tabId) // a new turn obsoletes any swallowed edge
      this.clear(tabId)
      return
    }
    let kind: AttentionKind | null = null
    if (next === 'approval') kind = 'approval'
    else if (next === 'waiting' && (prev === 'working' || prev === 'approval')) kind = 'turn-done'
    if (!kind) return
    this.raise(tabId, kind, ctx, title)
  }

  /** claude died hard under a live shell (liveness probe; no SessionEnd fired). */
  onExited(tabId: string, ctx: AttentionContext, title?: string): void {
    this.raise(tabId, 'exited', ctx, title)
  }

  onEvent(tabId: string, kind: AttentionKind, ctx: AttentionContext, title?: string): void {
    this.raise(tabId, kind, ctx, title)
  }

  /** The user looked at it (tab activated / window refocused on it) or the tab is
   *  gone — either way there is nothing left to draw anyone's attention to. */
  clear(tabId: string): void {
    this.recentlySuppressed.delete(tabId)
    if (this.pending.delete(tabId)) this.onChange(this.list(), null)
  }

  /** The user just moved OFF `tabId` (tab switch or window blur). If an event for it
   *  was swallowed by the watching rule only moments ago, that judgment likely used
   *  stale context (the status hook beat the renderer's active-tab report over IPC) —
   *  re-raise it now that the user is demonstrably elsewhere. */
  reconsider(tabId: string, ctx: AttentionContext, maxAgeMs = RECONSIDER_WINDOW_MS): void {
    const ev = this.recentlySuppressed.get(tabId)
    if (!ev) return
    this.recentlySuppressed.delete(tabId)
    if (Date.now() - ev.at > maxAgeMs) return // old enough that the user really saw it
    // resurrected: pend it (badge/strip/dock) but flag it so the one-shot outlets
    // (toast / OS notification / sound) skip it — the user may well have watched the
    // original moments ago, and an interrupting banner for a watched turn is exactly
    // the false positive the suppression rule exists to prevent
    this.raise(tabId, ev.kind, ctx, ev.title, true)
  }

  list(): AttentionEvent[] {
    return [...this.pending.values()]
  }

  private raise(
    tabId: string,
    kind: AttentionKind,
    ctx: AttentionContext,
    title?: string,
    resurrected?: boolean
  ): void {
    const event: AttentionEvent = { tabId, kind, at: Date.now(), title, resurrected }
    // the one suppression rule: never notify about the tab the user is watching —
    // but remember the swallowed edge briefly, in case this context was stale (see
    // reconsider). A switch-away within the window resurrects it.
    if (ctx.windowFocused && ctx.activeTabId === tabId) {
      this.recentlySuppressed.set(tabId, event)
      return
    }
    // approval outranks a mere finished turn (the TUI can nudge 'waiting' while a
    // permission prompt is still up) — but 'exited' REPLACES approval: a dead
    // session's permission prompt is moot, and hiding the death behind a stale
    // approval marker would send the user to approve a ghost.
    const cur = this.pending.get(tabId)
    if (cur && cur.kind === 'approval' && kind === 'turn-done') return
    // same-kind re-raise (a status flap, or turn N+1 finishing while turn N's marker
    // is still unconsumed): refresh the marker silently — the user already has a live
    // notification for exactly this tab+reason, and re-firing the one-shot outlets
    // would turn a jsonl flap into an OS-banner storm.
    if (cur && cur.kind === kind) {
      this.pending.set(tabId, event)
      this.onChange(this.list(), null)
      return
    }
    this.pending.set(tabId, event)
    this.onChange(this.list(), event)
  }
}
