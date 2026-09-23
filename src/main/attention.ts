import type { AttentionEvent, AttentionKind, SessionStatus } from '@shared/types'

export interface AttentionContext {
  windowFocused: boolean
  activeTabId: string | null
}

export const RECONSIDER_WINDOW_MS = 3000

export class AttentionTracker {
  private pending = new Map<string, AttentionEvent>()
  private recentlySuppressed = new Map<string, AttentionEvent>()

  constructor(
    private readonly onChange: (pending: AttentionEvent[], event: AttentionEvent | null) => void
  ) {}

  onStatusChange(
    tabId: string,
    prev: SessionStatus | undefined,
    next: SessionStatus,
    ctx: AttentionContext,
    title?: string
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
    this.raise(tabId, kind, ctx, title)
  }

  onExited(tabId: string, ctx: AttentionContext, title?: string): void {
    this.raise(tabId, 'exited', ctx, title)
  }

  onEvent(tabId: string, kind: AttentionKind, ctx: AttentionContext, title?: string): void {
    this.raise(tabId, kind, ctx, title)
  }

  clear(tabId: string): void {
    this.recentlySuppressed.delete(tabId)
    if (this.pending.delete(tabId)) this.onChange(this.list(), null)
  }

  reconsider(tabId: string, ctx: AttentionContext, maxAgeMs = RECONSIDER_WINDOW_MS): void {
    const ev = this.recentlySuppressed.get(tabId)
    if (!ev) return
    this.recentlySuppressed.delete(tabId)
    if (Date.now() - ev.at > maxAgeMs) return
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
