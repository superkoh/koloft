import type { Verdict } from './turnNews'

export type HeldStep = 'approval' | 'turn-done'

export type StepClaim = 'hold' | 'take' | undefined

export interface StepHolder {
  claims(tabId: string, step: HeldStep): StepClaim
  judged?(tabId: string, verdict: Verdict): void
}

export class HeldSteps {
  private holders: StepHolder[] = []
  private heldBy = new Map<string, StepHolder>()

  hold(holder: StepHolder): void {
    this.holders.push(holder)
  }

  private claimer(tabId: string, step: HeldStep): [StepHolder, StepClaim] | undefined {
    for (const holder of this.holders) {
      const claim = holder.claims(tabId, step)
      if (claim) return [holder, claim]
    }
    return undefined
  }

  reached(tabId: string, step: HeldStep): StepClaim {
    const [holder, claim] = this.claimer(tabId, step) ?? []
    if (holder && claim === 'hold') this.heldBy.set(tabId, holder)
    else this.heldBy.delete(tabId)
    return claim
  }

  askClaimed(tabId: string): boolean {
    return this.claimer(tabId, 'approval') !== undefined
  }

  judged(tabId: string, verdict: Verdict): void {
    this.heldBy.get(tabId)?.judged?.(tabId, verdict)
  }
}
