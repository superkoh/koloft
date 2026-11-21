import { describe, expect, it } from 'vitest'
import {
  HeldSteps,
  type StepClaim,
  type StepHolder
} from '../../../../src/plugins/sessions/main/heldSteps'

function holder(name: string, heard: string[]): StepHolder & { says: StepClaim } {
  const h = {
    says: undefined as StepClaim,
    claims: () => h.says,
    judged: (tabId: string) => void heard.push(`${name} ${tabId}`)
  }
  return h
}

describe('HeldSteps — which plugin holds a step', () => {
  it('the first holder to claim a step gets it, and the verdict goes to the one that held the turn even after the answers change', () => {
    const heard: string[] = []
    const steps = new HeldSteps()
    const first = holder('first', heard)
    const second = holder('second', heard)
    steps.hold(first)
    steps.hold(second)
    second.says = 'hold'
    expect(steps.reached('tab-A', 'turn-done')).toBe('hold')
    first.says = 'take'
    second.says = undefined
    steps.judged('tab-A', { news: false })
    expect(steps.reached('tab-B', 'turn-done')).toBe('take')
    steps.judged('tab-B', { news: false })
    expect(heard).toEqual(['second tab-A'])
    expect(steps.askClaimed('tab-C')).toBe(true)
  })
})
