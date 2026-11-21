import type { Verdict } from './turnNews'

export type HeldStep = 'approval' | 'turn-done'

export type StepClaim = 'hold' | 'take' | undefined

export interface StepHolder {
  claims(tabId: string, step: HeldStep): StepClaim
  judged?(tabId: string, verdict: Verdict): void
}

export class HeldSteps {
  private holders: StepHolder[] = []

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

  claim(tabId: string, step: HeldStep): StepClaim {
    return this.claimer(tabId, step)?.[1]
  }

  askClaimed(tabId: string): boolean {
    return this.claim(tabId, 'approval') !== undefined
  }

  judged(tabId: string, verdict: Verdict): void {
    const [holder, claim] = this.claimer(tabId, 'turn-done') ?? []
    if (claim === 'hold') holder?.judged?.(tabId, verdict)
  }
}
