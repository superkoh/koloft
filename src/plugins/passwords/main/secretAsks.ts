import { randomUUID } from 'crypto'
import { loopbackHttp, urlOrNull } from '@shared/browserRoute'
import type { SecretAskShape, SecretAskView } from '@shared/types'
import type { OwnerWaits } from '@core/ownerWaits'

export interface SecretAsk {
  tabId: string
  from: string
  shape: SecretAskShape
  header(name: string): string
  body: string
  label: string
}

export type SecretAnswer =
  { typed: string } | { doneInKoloft: true } | { passed: true } | { ended: 'timeout' | 'declined' }

export type AnsweredElsewhere = { typed: string } | { passed: true } | { ended: 'declined' }

export type HowItEnded =
  'timeout' | 'closed' | 'answered-in-koloft' | 'declined-in-koloft' | 'answered-elsewhere'

export interface SecretAskListener<A extends SecretAsk> {
  asked: (id: string, ask: A) => boolean
  ended: (id: string, how: HowItEnded, ask: A) => void
}

export interface SecretAskDeps {
  show(asks: SecretAskView[]): void
  owner: OwnerWaits
}

interface Pending<A extends SecretAsk> {
  ask: A
  signInGuest?: number
  settle(answer: SecretAnswer): void
}

function sameUrl(a: string, b: string): boolean {
  return (urlOrNull(a)?.href ?? a) === (urlOrNull(b)?.href ?? b)
}

export class SecretAsks<A extends SecretAsk = SecretAsk> {
  private pending = new Map<string, Pending<A>>()
  private listeners: SecretAskListener<A>[] = []

  constructor(private d: SecretAskDeps) {}

  listen(listener: SecretAskListener<A>): void {
    this.listeners.push(listener)
  }

  async ask(ask: A, waitMs: number): Promise<SecretAnswer> {
    const id = randomUUID()
    let settle!: (answer: SecretAnswer) => void
    const answer = new Promise<SecretAnswer>((resolve) => (settle = resolve))
    this.pending.set(id, { ask, settle })
    this.d.show(this.views())
    const timer = setTimeout(() => this.end(id, { ended: 'timeout' }, 'timeout'), waitMs)
    const shownElsewhere = this.listeners.filter((l) => l.asked(id, ask)).length > 0
    if (!shownElsewhere) this.d.owner.waitsOnTheOwner(ask.tabId)
    const value = await answer
    clearTimeout(timer)
    return value
  }

  pendingAsk(id: string): A | undefined {
    return this.pending.get(id)?.ask
  }

  views(): SecretAskView[] {
    return [...this.pending].map(([id, p]) => ({ ...p.ask.shape, id, tabId: p.ask.tabId }))
  }

  answer(id: string, typed: string): void {
    if (typed) this.end(id, { typed }, 'answered-in-koloft')
  }

  done(id: string): void {
    if (this.pending.get(id)?.ask.shape.kind === 'sudo') return
    this.end(id, { doneInKoloft: true }, 'answered-in-koloft')
  }

  decline(id: string): void {
    this.end(id, { ended: 'declined' }, 'declined-in-koloft')
  }

  answerFromElsewhere(id: string, answer: AnsweredElsewhere): void {
    this.end(id, answer, 'answered-elsewhere')
  }

  navigationStarted(guestId: number, url: string): void {
    for (const p of this.pending.values()) {
      const s = p.ask.shape
      if (s.kind === 'url' && p.signInGuest === undefined && sameUrl(url, s.signIn))
        p.signInGuest = guestId
    }
  }

  navigated(guestId: number, url: string): void {
    for (const [id, p] of this.pending) {
      const s = p.ask.shape
      const landed =
        (s.kind === 'page' && s.guestId === guestId) ||
        (s.kind === 'url' &&
          p.signInGuest === guestId &&
          !!loopbackHttp(url) &&
          !sameUrl(url, s.signIn))
      if (landed) this.done(id)
    }
  }

  rehome(fromTabId: string, toTabId: string): void {
    let moved = false
    for (const p of this.pending.values())
      if (p.ask.tabId === fromTabId) {
        p.ask = { ...p.ask, tabId: toTabId }
        moved = true
      }
    if (moved) this.d.show(this.views())
  }

  forget(tabId: string): void {
    for (const [id, p] of this.pending)
      if (p.ask.tabId === tabId || p.ask.from === tabId)
        this.end(id, { ended: 'timeout' }, 'closed')
  }

  private end(id: string, answer: SecretAnswer, how: HowItEnded): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.settle(answer)
    this.d.show(this.views())
    const tabId = p.ask.tabId
    if (![...this.pending.values()].some((q) => q.ask.tabId === tabId))
      this.d.owner.ownerAnswered(tabId)
    for (const l of this.listeners) l.ended(id, how, p.ask)
  }
}
