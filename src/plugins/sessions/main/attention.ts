import type { AttentionEvent, AttentionKind, AttentionSubject, SessionStatus } from '@shared/types'
import type { HeldStep, StepClaim } from './heldSteps'

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
  private held = new Map<string, AttentionEvent & { kind: HeldStep }>()
  asleep: (tabId: string) => boolean = () => false
  waitsOnAnother: (tabId: string) => boolean = () => false
  watching: () => string | null = () => null
  turnDone: (tabId: string) => void = () => {}
  outlivesKoloft: (tabId: string) => boolean = () => false
  claim: (tabId: string, step: HeldStep) => StepClaim = () => undefined

  constructor(
    private readonly onChange: (pending: AttentionEvent[], event: AttentionEvent | null) => void,
    lastRun: SavedMark[] = []
  ) {
    for (const { tabId, kind, at, title, sessionId, fyi, wasAsking, stoppedByRestart } of lastRun) {
      const deadKind = kind === 'approval' ? 'turn-done' : kind
      this.pending.set(tabId, {
        tabId,
        kind: deadKind,
        at,
        title,
        sessionId,
        fyi,
        ...((kind === 'approval' || wasAsking) && { wasAsking: true }),
        ...(stoppedByRestart && { stoppedByRestart })
      })
    }
  }

  bound(tabId: string, sessionId: string): void {
    const carried = this.list().find((e) => e.sessionId === sessionId)
    if (!carried) return
    const askingHere = this.pending.get(tabId)
    for (const e of this.list()) if (e.sessionId === sessionId) this.pending.delete(e.tabId)
    const wasAsking = carried.kind === 'approval' || carried.wasAsking
    const sameAsk = wasAsking && !carried.stoppedByRestart
    this.pending.set(
      tabId,
      askingHere?.kind === 'approval' && askingHere !== carried
        ? { ...askingHere, sessionId, ...(sameAsk && { at: carried.at }) }
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
    const kind = edgeAttention(prev, next)
    if (next === 'working' || kind) this.held.delete(tabId)
    if (next === 'working') {
      const cur = this.pending.get(tabId)
      const mayAskAgain = cur?.wasAsking && !cur.stoppedByRestart && this.outlivesKoloft(tabId)
      if (!mayAskAgain || this.askKeptThroughWorking.has(tabId)) this.clear(tabId)
      else this.askKeptThroughWorking.add(tabId)
      return
    }
    if (!kind) return
    const claim = this.claim(tabId, kind)
    if (claim === 'take') return
    if (claim === 'hold') return this.hold(tabId, kind, subject)
    this.raise(tabId, kind, subject, true)
  }

  private hold(tabId: string, kind: HeldStep, subject: AttentionSubject): void {
    if (kind === 'turn-done' && this.pending.get(tabId)?.kind === 'approval') return
    const fyi = kind === 'turn-done' && this.waitsOnAnother(tabId)
    this.held.set(tabId, { ...subject, tabId, kind, at: Date.now(), ...(fyi && { fyi }) })
    if (kind === 'turn-done' && !fyi) this.turnDone(tabId)
  }

  letGo(tabId: string, note?: string): boolean {
    const held = this.held.get(tabId)
    if (!held) return false
    this.held.delete(tabId)
    const { title, sessionId, at, fyi } = held
    this.raise(tabId, held.kind, { title, sessionId, ...(note && { note }) }, true, { at, fyi })
    return true
  }

  heldMarks(): AttentionEvent[] {
    return [...this.held.values()].filter((e) => !this.pending.has(e.tabId))
  }

  take(tabId: string): void {
    this.held.delete(tabId)
  }

  holdsTurn(tabId: string): boolean {
    return this.held.get(tabId)?.kind === 'turn-done'
  }

  onExited(tabId: string, subject: AttentionSubject = {}): void {
    this.held.delete(tabId)
    this.raise(tabId, 'exited', subject)
  }

  waitsOnTheOwner(tabId: string, subject: AttentionSubject): void {
    this.raise(tabId, 'approval', subject)
  }

  ownerAnswered(tabId: string): void {
    if (this.pending.get(tabId)?.kind === 'approval') this.drop(tabId)
  }

  waitsOnApproval(tabId: string): boolean {
    return this.pending.get(tabId)?.kind === 'approval'
  }

  awaitingVerdict(tabId: string): boolean {
    const cur = this.held.get(tabId) ?? this.pending.get(tabId)
    return cur?.kind === 'turn-done' && !cur.fyi
  }

  markFyi(tabId: string): void {
    const held = this.held.get(tabId)
    if (held?.kind === 'turn-done') return void this.held.set(tabId, { ...held, fyi: true })
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
    if (this.asleep(tabId)) return
    this.held.delete(tabId)
    this.drop(tabId)
  }

  private drop(tabId: string): void {
    if (this.pending.delete(tabId)) this.onChange(this.list(), null)
  }

  clearKeepingExit(tabId: string): void {
    if (this.pending.get(tabId)?.kind !== 'exited') this.clear(tabId)
  }

  tabStopping(tabId: string, restarting: boolean): void {
    this.held.delete(tabId)
    const cur = this.pending.get(tabId)
    const asking = cur?.kind === 'approval' || cur?.wasAsking
    const parked = tabId + PARKED_WHILE_ITS_TAB_RESTARTS
    if (!restarting) this.drop(parked)
    if (!restarting || !asking || !cur.sessionId) return this.clearKeepingExit(tabId)
    this.pending.delete(tabId)
    this.pending.set(parked, { ...cur, ...STOPPED_BY_A_RESTART, tabId: parked })
    this.onChange(this.list(), null)
  }

  clearSession(sessionId: string): void {
    for (const e of this.held.values()) if (e.sessionId === sessionId) this.held.delete(e.tabId)
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
    subject: AttentionSubject & Pick<AttentionEvent, 'note'>,
    sameAsk = false,
    held?: Pick<AttentionEvent, 'at' | 'fyi'>
  ): void {
    const fyi = (kind === 'turn-done' && this.waitsOnAnother(tabId)) || !!held?.fyi
    const cur = this.pending.get(tabId)
    const sameAskAsBefore =
      kind === 'approval' && sameAsk && cur?.wasAsking && !cur.stoppedByRestart
    const at = sameAskAsBefore ? cur.at : (held?.at ?? Date.now())
    const event: AttentionEvent = { ...subject, tabId, kind, at, ...(fyi && { fyi }) }
    if (cur && cur.kind === 'approval' && kind === 'turn-done') return
    if (fyi && this.watching() === tabId) return this.drop(tabId)
    this.pending.set(tabId, event)
    const alreadySaid = cur?.kind === kind && !cur.wasAsking
    this.onChange(this.list(), alreadySaid || sameAskAsBefore ? null : event)
    if (kind === 'turn-done' && !fyi) this.turnDone(tabId)
  }
}
