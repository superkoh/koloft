import { randomUUID } from 'crypto'
import type { OwnerWaits } from '@core/ownerWaits'
import { errorText } from '@core/errorText'
import { INSTRUCTIONS_CHANGED_MEANWHILE, type InstructionAskView } from '../shared/instructionAsks'

export type OwnersAnswer = 'agreed' | 'declined' | 'timeout' | 'closed' | 'changed-meanwhile'

export type InstructionAsk = Omit<InstructionAskView, 'id'>

type AnsweredAt = 'computer' | 'phone'

export type InstructionAskEnd =
  | { how: 'changed' | 'not-changed' | 'changed-meanwhile'; at: AnsweredAt }
  | { how: 'write-failed'; at: AnsweredAt; error: unknown }
  | { how: 'timeout' | 'tab-closed' | 'stopped-waiting' }

export interface InstructionAskListener {
  asked(id: string, ask: InstructionAsk): void
  ended(id: string, end: InstructionAskEnd): void
}

export interface InstructionAskDeps {
  show(asks: InstructionAskView[]): void
  owner: OwnerWaits
  told(text: string): void
}

const THE_CALLER_IS_ASKED_WHETHER_IT_STILL_WAITS_EVERY_MS = 2000

type Given =
  | { how: 'agreed'; at: AnsweredAt }
  | { how: 'not-changed'; at: AnsweredAt }
  | { how: 'timeout' | 'tab-closed' | 'stopped-waiting' }

interface Pending {
  ask: InstructionAsk
  settle(given: Given): void
}

const ANSWER_TO_THE_AGENT: Record<
  Exclude<InstructionAskEnd['how'], 'write-failed'>,
  OwnersAnswer
> = {
  changed: 'agreed',
  'not-changed': 'declined',
  'changed-meanwhile': 'changed-meanwhile',
  timeout: 'timeout',
  'tab-closed': 'closed',
  'stopped-waiting': 'closed'
}

export class InstructionAsks {
  private pending = new Map<string, Pending>()
  private listeners: InstructionAskListener[] = []

  constructor(private d: InstructionAskDeps) {}

  listen(listener: InstructionAskListener): void {
    this.listeners.push(listener)
  }

  async ask(
    ask: InstructionAsk,
    waitMs: number,
    write: () => Promise<boolean>,
    stillWaiting: () => boolean = () => true
  ): Promise<OwnersAnswer> {
    const id = randomUUID()
    let settle!: (given: Given) => void
    const answer = new Promise<Given>((resolve) => (settle = resolve))
    this.pending.set(id, { ask, settle })
    this.d.show(this.views())
    this.d.owner.waitsOnTheOwner(ask.tabId)
    for (const l of this.listeners) l.asked(id, ask)
    const timer = setTimeout(() => this.end(id, { how: 'timeout' }), waitMs)
    const watchTheCaller = (): void => {
      if (!stillWaiting()) this.end(id, { how: 'stopped-waiting' })
    }
    watchTheCaller()
    const watch = setInterval(watchTheCaller, THE_CALLER_IS_ASKED_WHETHER_IT_STILL_WAITS_EVERY_MS)
    const answered = await answer
    clearTimeout(timer)
    clearInterval(watch)
    if (answered.how !== 'agreed') return ANSWER_TO_THE_AGENT[answered.how]
    const end = await written(write, answered.at)
    this.tell(id, end)
    if (end.how === 'write-failed') throw end.error
    return ANSWER_TO_THE_AGENT[end.how]
  }

  pendingAsk(id: string): InstructionAsk | undefined {
    return this.pending.get(id)?.ask
  }

  views(): InstructionAskView[] {
    return [...this.pending].map(([id, p]) => ({ ...p.ask, id }))
  }

  asking(tabId: string): boolean {
    return [...this.pending.values()].some((p) => p.ask.tabId === tabId)
  }

  answer(id: string, agreed: boolean, at: AnsweredAt = 'computer'): void {
    this.end(id, agreed ? { how: 'agreed', at } : { how: 'not-changed', at })
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
      if (p.ask.tabId === tabId) this.end(id, { how: 'tab-closed' })
  }

  private end(id: string, how: Given): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    this.d.show(this.views())
    if (!this.asking(p.ask.tabId)) this.d.owner.ownerAnswered(p.ask.tabId)
    if (how.how !== 'agreed') this.tell(id, how)
    p.settle(how)
  }

  private tell(id: string, end: InstructionAskEnd): void {
    if (end.how === 'changed-meanwhile') this.d.told(INSTRUCTIONS_CHANGED_MEANWHILE)
    if (end.how === 'write-failed') this.d.told(errorText(end.error))
    for (const l of this.listeners) l.ended(id, end)
  }
}

async function written(write: () => Promise<boolean>, at: AnsweredAt): Promise<InstructionAskEnd> {
  try {
    return { how: (await write()) ? 'changed' : 'changed-meanwhile', at }
  } catch (error) {
    return { how: 'write-failed', at, error }
  }
}
