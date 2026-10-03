import type { AttentionEvent, AttentionKind, AttentionSubject, SessionStatus } from '@shared/types'

export interface AttentionContext {
  windowFocused: boolean
  activeTabId: string | null
}

export const RECONSIDER_WINDOW_MS = 3000

export type SavedMark = AttentionEvent & { sessionId: string }

export class AttentionTracker {
  private pending = new Map<string, AttentionEvent>()
  private recentlySuppressed = new Map<string, AttentionEvent>()

  constructor(
    private readonly onChange: (pending: AttentionEvent[], event: AttentionEvent | null) => void,
    lastRun: SavedMark[] = []
  ) {
    for (const { tabId, kind, at, title, sessionId } of lastRun) {
      const deadKind = kind === 'approval' ? 'turn-done' : kind
      this.pending.set(tabId, { tabId, kind: deadKind, at, title, sessionId })
    }
  }

  bound(tabId: string, sessionId: string, ctx: AttentionContext): void {
    const carried = this.list().find((e) => e.sessionId === sessionId)
    this.clearSession(sessionId)
    if (carried) this.raise(tabId, 'turn-done', ctx, { title: carried.title, sessionId }, true)
  }

  onStatusChange(
    tabId: string,
    prev: SessionStatus | undefined,
    next: SessionStatus,
    ctx: AttentionContext,
    subject: AttentionSubject = {}
  ): void {
    if (next === 'working') {
      this.recentlySuppressed.delete(tabId)
      this.clear(tabId)
      return
    }
    let kind: AttentionKind | null = null
    if (next === 'approval') kind = 'approval'
    else if (next === 'waiting' && (prev === 'working' || prev === 'approval')) kind = 'turn-done'
    if (!kind) return
    this.raise(tabId, kind, ctx, subject)
  }

  onExited(tabId: string, ctx: AttentionContext, subject: AttentionSubject = {}): void {
    this.raise(tabId, 'exited', ctx, subject)
  }

  clear(tabId: string): void {
    this.recentlySuppressed.delete(tabId)
    if (this.pending.delete(tabId)) this.onChange(this.list(), null)
  }

  clearKeepingExit(tabId: string): void {
    if (this.pending.get(tabId)?.kind !== 'exited') this.clear(tabId)
  }

  clearSession(sessionId: string): void {
    const stale = this.list().filter((e) => e.sessionId === sessionId)
    for (const e of stale) this.pending.delete(e.tabId)
    if (stale.length) this.onChange(this.list(), null)
  }

  reconsider(tabId: string, ctx: AttentionContext, maxAgeMs = RECONSIDER_WINDOW_MS): void {
    const ev = this.recentlySuppressed.get(tabId)
    if (!ev) return
    this.recentlySuppressed.delete(tabId)
    if (Date.now() - ev.at > maxAgeMs) return
    this.raise(tabId, ev.kind, ctx, ev, true)
  }

  list(): AttentionEvent[] {
    return [...this.pending.values()]
  }

  private raise(
    tabId: string,
    kind: AttentionKind,
    ctx: AttentionContext,
    subject: AttentionSubject,
    resurrected?: boolean
  ): void {
    const event: AttentionEvent = { ...subject, tabId, kind, at: Date.now(), resurrected }
    if (ctx.windowFocused && ctx.activeTabId === tabId) {
      this.recentlySuppressed.set(tabId, event)
      return
    }
    const cur = this.pending.get(tabId)
    if (cur && cur.kind === 'approval' && kind === 'turn-done') return
    if (cur && cur.kind === kind) {
      this.pending.set(tabId, event)
      this.onChange(this.list(), null)
      return
    }
    this.pending.set(tabId, event)
    this.onChange(this.list(), event)
  }
}
