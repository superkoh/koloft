import { randomUUID } from 'crypto'
import type { OwnerWaits } from '@core/ownerWaits'
import type { InstructionAskView } from '../shared/instructionAsks'

export type OwnersAnswer = 'agreed' | 'declined' | 'timeout' | 'closed'

export type InstructionAsk = Omit<InstructionAskView, 'id'>

export interface InstructionAskDeps {
  show(asks: InstructionAskView[]): void
  owner: OwnerWaits
}

const A_CALLER_THAT_STOPPED_WAITING_IS_SEEN_WITHIN_MS = 2000

interface Pending {
  ask: InstructionAsk
  settle(answer: OwnersAnswer): void
}

export class InstructionAsks {
  private pending = new Map<string, Pending>()

  constructor(private d: InstructionAskDeps) {}

  async ask(
    ask: InstructionAsk,
    waitMs: number,
    stillWaiting: () => boolean = () => true
  ): Promise<OwnersAnswer> {
    const id = randomUUID()
    let settle!: (answer: OwnersAnswer) => void
    const answer = new Promise<OwnersAnswer>((resolve) => (settle = resolve))
    this.pending.set(id, { ask, settle })
    this.d.show(this.views())
    this.d.owner.waitsOnTheOwner(ask.tabId)
    const timer = setTimeout(() => this.end(id, 'timeout'), waitMs)
    const watch = setInterval(() => {
      if (!stillWaiting()) this.end(id, 'closed')
    }, A_CALLER_THAT_STOPPED_WAITING_IS_SEEN_WITHIN_MS)
    const given = await answer
    clearTimeout(timer)
    clearInterval(watch)
    return given
  }

  views(): InstructionAskView[] {
    return [...this.pending].map(([id, p]) => ({ ...p.ask, id }))
  }

  asking(tabId: string): boolean {
    return [...this.pending.values()].some((p) => p.ask.tabId === tabId)
  }

  answer(id: string, agreed: boolean): void {
    this.end(id, agreed ? 'agreed' : 'declined')
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
    for (const [id, p] of this.pending) if (p.ask.tabId === tabId) this.end(id, 'closed')
  }

  private end(id: string, how: OwnersAnswer): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.settle(how)
    this.d.show(this.views())
    if (!this.asking(p.ask.tabId)) this.d.owner.ownerAnswered(p.ask.tabId)
  }
}
