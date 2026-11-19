import { randomUUID } from 'crypto'
import type { OwnerWaits } from '@core/ownerWaits'
import type { InstructionAskView } from '../shared/instructionAsks'

export type OwnersAnswer = 'agreed' | 'declined' | 'timeout' | 'closed'

export type InstructionAsk = Omit<InstructionAskView, 'id'>

export interface InstructionAskDeps {
  show(asks: InstructionAskView[]): void
  owner: OwnerWaits
}

interface Pending {
  ask: InstructionAsk
  settle(answer: OwnersAnswer): void
}

export class InstructionAsks {
  private pending = new Map<string, Pending>()

  constructor(private d: InstructionAskDeps) {}

  async ask(ask: InstructionAsk, waitMs: number): Promise<OwnersAnswer> {
    const id = randomUUID()
    let settle!: (answer: OwnersAnswer) => void
    const answer = new Promise<OwnersAnswer>((resolve) => (settle = resolve))
    this.pending.set(id, { ask, settle })
    this.d.show(this.views())
    this.d.owner.waitsOnTheOwner(ask.tabId)
    const timer = setTimeout(() => this.end(id, 'timeout'), waitMs)
    const given = await answer
    clearTimeout(timer)
    return given
  }

  views(): InstructionAskView[] {
    return [...this.pending].map(([id, p]) => ({ ...p.ask, id }))
  }

  answer(id: string, agreed: boolean): void {
    this.end(id, agreed ? 'agreed' : 'declined')
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
    const { tabId } = p.ask
    if (![...this.pending.values()].some((q) => q.ask.tabId === tabId))
      this.d.owner.ownerAnswered(tabId)
  }
}
