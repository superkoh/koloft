import { expect, it } from 'vitest'
import { liftedWhen } from '../../src/main/agentLift'

it('starts an agent through taskpolicy -a on a Mac that has it, and exactly as before on one that does not', () => {
  const agent = ['claude', '--resume', 'abc']
  expect(liftedWhen(true, agent)).toEqual(['/usr/sbin/taskpolicy', '-a', ...agent])
  expect(liftedWhen(false, agent)).toEqual(agent)
})
