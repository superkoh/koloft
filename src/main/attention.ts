import type { AttentionEvent, AttentionKind, AttentionSubject, SessionStatus } from '@shared/types'

export type SavedMark = AttentionEvent & { sessionId: string }

const PARKED_WHILE_ITS_TAB_RESTARTS = ':restarting'
const STOPPED_BY_A_RESTART = { kind: 'turn-done', wasAsking: true, stoppedByRestart: true } as const

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
  private askKeptThroughWorking = new Set<string>()
  asleep: (tabId: string) => boolean = () => false
  waitsOnAnother: (tabId: string) => boolean = () => false
  watching: () => string | null = () => null
  turnDone: (tabId: string) => void = () => {}
  outlivesKoloft: (tabId: string) => boolean = () => false

  constructor(
    private readonly onChange: (pending: AttentionEvent[], event: AttentionEvent | null) => void,
    lastRun: SavedMark[] = []
  ) {
    for (const { tabId, kind, at, title, sessionId, fyi, wasAsking } of lastRun) {
      const deadKind = kind === 'approval' ? 'turn-done' : kind
      this.pending.set(tabId, {
        tabId,
        kind: deadKind,
        at,
        title,
        sessionId,
        fyi,
        ...((kind === 'approval' || wasAsking) && { wasAsking: true })
      })
    }
  }

  bound(tabId: string, sessionId: string): void {
    const carried = this.list().find((e) => e.sessionId === sessionId)
    if (!carried) return
    const askingHere = this.pending.get(tabId)
    for (const e of this.list()) if (e.sessionId === sessionId) this.pending.delete(e.tabId)
    const wasAsking = carried.kind === 'approval' || carried.wasAsking
    this.pending.set(
      tabId,
      askingHere?.kind === 'approval' && askingHere !== carried
        ? { ...askingHere, sessionId, ...(wasAsking && { at: carried.at }) }
        : { ...carried, tabId, kind: 'turn-done', ...(wasAsking && { wasAsking: true }) }
    )
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
      const cur = this.pending.get(tabId)
      const mayAskAgain = cur?.wasAsking && !cur.stoppedByRestart && this.outlivesKoloft(tabId)
      if (!mayAskAgain || this.askKeptThroughWorking.has(tabId)) this.clear(tabId)
      else this.askKeptThroughWorking.add(tabId)
      return
    }
    const kind = edgeAttention(prev, next)
    if (!kind) return
    this.raise(tabId, kind, subject, true)
  }

  onExited(tabId: string, subject: AttentionSubject = {}): void {
    this.raise(tabId, 'exited', subject)
  }

  asksForASecret(tabId: string, subject: AttentionSubject): void {
    this.raise(tabId, 'approval', subject)
  }

  secretAnswered(tabId: string): void {
    if (this.pending.get(tabId)?.kind === 'approval') this.drop(tabId)
  }

  waitsOnApproval(tabId: string): boolean {
    return this.pending.get(tabId)?.kind === 'approval'
  }

  awaitingVerdict(tabId: string): boolean {
    const cur = this.pending.get(tabId)
    return cur?.kind === 'turn-done' && !cur.fyi
  }

  markFyi(tabId: string): void {
    const cur = this.pending.get(tabId)
    if (cur?.kind !== 'turn-done' || cur.fyi) return
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
    this.askKeptThroughWorking.delete(tabId)
    if (this.pending.delete(tabId)) this.onChange(this.list(), null)
  }

  clearKeepingExit(tabId: string): void {
    this.drop(tabId + PARKED_WHILE_ITS_TAB_RESTARTS)
    if (this.pending.get(tabId)?.kind !== 'exited') this.clear(tabId)
  }

  tabStopping(tabId: string, restarting: boolean): void {
    const cur = this.pending.get(tabId)
    const asking = cur?.kind === 'approval' || cur?.wasAsking
    if (!restarting || !asking || !cur.sessionId) return this.clearKeepingExit(tabId)
    const parked = tabId + PARKED_WHILE_ITS_TAB_RESTARTS
    this.pending.delete(tabId)
    this.pending.set(parked, { ...cur, ...STOPPED_BY_A_RESTART, tabId: parked })
    this.onChange(this.list(), null)
  }

  clearSession(sessionId: string): void {
    const stale = this.list().filter((e) => e.sessionId === sessionId)
    for (const e of stale) this.pending.delete(e.tabId)
    if (stale.length) this.onChange(this.list(), null)
  }

  list(): AttentionEvent[] {
    return [...this.pending.values()]
  }

  private raise(
    tabId: string,
    kind: AttentionKind,
    subject: AttentionSubject,
    sameAsk = false
  ): void {
    const fyi = kind === 'turn-done' && this.waitsOnAnother(tabId)
    const cur = this.pending.get(tabId)
    const sameAskAsBefore =
      kind === 'approval' && sameAsk && cur?.wasAsking && !cur.stoppedByRestart
    const at = sameAskAsBefore ? cur.at : Date.now()
    const event: AttentionEvent = { ...subject, tabId, kind, at, ...(fyi && { fyi }) }
    if (cur && cur.kind === 'approval' && kind === 'turn-done') return
    if (fyi && this.watching() === tabId) return this.drop(tabId)
    this.pending.set(tabId, event)
    const alreadySaid = cur?.kind === kind && !cur.wasAsking
    this.onChange(this.list(), alreadySaid || sameAskAsBefore ? null : event)
    if (kind === 'turn-done' && !fyi) this.turnDone(tabId)
  }
}
