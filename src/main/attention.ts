import type { AttentionEvent, AttentionKind, AttentionSubject, SessionStatus } from '@shared/types'

export type SavedMark = AttentionEvent & { sessionId: string }

export function edgeAttention(
  prev: SessionStatus | undefined,
  next: SessionStatus
): 'approval' | 'turn-done' | null {
  if (next === 'approval') return 'approval'
  if (next === 'waiting' && (prev === 'working' || prev === 'approval')) return 'turn-done'
  return null
}

export class AttentionTracker {
  private pending = new Map<string, AttentionEvent>()
  asleep: (tabId: string) => boolean = () => false
  waitsOnAnother: (tabId: string) => boolean = () => false
  watching: () => string | null = () => null
  turnDone: (tabId: string) => void = () => {}

  constructor(
    private readonly onChange: (pending: AttentionEvent[], event: AttentionEvent | null) => void,
    lastRun: SavedMark[] = []
  ) {
    for (const { tabId, kind, at, title, sessionId, fyi } of lastRun) {
      const deadKind = kind === 'approval' ? 'turn-done' : kind
      this.pending.set(tabId, { tabId, kind: deadKind, at, title, sessionId, fyi })
    }
  }

  bound(tabId: string, sessionId: string): void {
    const carried = this.list().find((e) => e.sessionId === sessionId)
    if (!carried) return
    for (const e of this.list()) if (e.sessionId === sessionId) this.pending.delete(e.tabId)
    this.pending.set(tabId, { ...carried, tabId, kind: 'turn-done' })
    this.onChange(this.list(), null)
  }

  rehome(fromTabId: string, toTabId: string): void {
    const mark = this.pending.get(fromTabId)
    if (!mark) return
    this.pending.delete(fromTabId)
    if (!this.pending.has(toTabId)) this.pending.set(toTabId, { ...mark, tabId: toTabId })
    this.onChange(this.list(), null)
  }

  onStatusChange(
    tabId: string,
    prev: SessionStatus | undefined,
    next: SessionStatus,
    subject: AttentionSubject = {}
  ): void {
    if (next === 'working') {
      this.clear(tabId)
      return
    }
    const kind = edgeAttention(prev, next)
    if (!kind) return
    this.raise(tabId, kind, subject)
  }

  onExited(tabId: string, subject: AttentionSubject = {}): void {
    this.raise(tabId, 'exited', subject)
  }

  waitsOnApproval(tabId: string): boolean {
    return this.pending.get(tabId)?.kind === 'approval'
  }

  unjudgedTurnDone(tabId: string): number | undefined {
    const cur = this.pending.get(tabId)
    return cur?.kind === 'turn-done' && !cur.fyi ? cur.at : undefined
  }

  markFyi(tabId: string, raisedAt: number): void {
    const cur = this.pending.get(tabId)
    if (cur?.kind !== 'turn-done' || cur.fyi || cur.at !== raisedAt) return
    if (this.watching() === tabId) return this.drop(tabId)
    this.pending.set(tabId, { ...cur, fyi: true })
    this.onChange(this.list(), null)
  }

  seen(tabId: string): void {
    if (this.pending.get(tabId)?.fyi) this.drop(tabId)
  }

  clear(tabId: string): void {
    if (!this.asleep(tabId)) this.drop(tabId)
  }

  private drop(tabId: string): void {
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

  list(): AttentionEvent[] {
    return [...this.pending.values()]
  }

  private raise(tabId: string, kind: AttentionKind, subject: AttentionSubject): void {
    const fyi = kind === 'turn-done' && this.waitsOnAnother(tabId)
    const event: AttentionEvent = { ...subject, tabId, kind, at: Date.now(), ...(fyi && { fyi }) }
    const cur = this.pending.get(tabId)
    if (cur && cur.kind === 'approval' && kind === 'turn-done') return
    if (fyi && this.watching() === tabId) return this.drop(tabId)
    this.pending.set(tabId, event)
    this.onChange(this.list(), cur?.kind === kind ? null : event)
    if (kind === 'turn-done' && !fyi) this.turnDone(tabId)
  }
}
