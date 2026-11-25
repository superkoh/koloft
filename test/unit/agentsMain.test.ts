import { describe, expect, it } from 'vitest'
import { AgentsMain, type OneShotTarget } from '../../src/core/agent/agentsMain'
import { AGENT_IDS } from '../../src/core/agent/registry'

const targetOf = (binary: string): OneShotTarget => ({ binary, env: {}, done: () => {} })

describe('the agents registered with their main-process side', () => {
  it('asks the agent that was named, and no other, for its one-shot target', async () => {
    const agents = new AgentsMain()
    for (const id of AGENT_IDS)
      agents.register({ id, oneShotTarget: async () => targetOf(`the ${id} program`) })

    for (const id of AGENT_IDS)
      expect((await agents.oneShotTarget(id))?.binary).toBe(`the ${id} program`)
  })

  it('hands on that an agent has nothing to run a one-shot with right now', async () => {
    const agents = new AgentsMain()
    agents.register({ id: AGENT_IDS[0], oneShotTarget: async () => null })

    expect(await agents.oneShotTarget(AGENT_IDS[0])).toBeNull()
  })

  it('answers that an agent that was not built has no one-shot target, without an error', async () => {
    const agents = new AgentsMain()
    agents.register({ id: AGENT_IDS[0], oneShotTarget: async () => targetOf('built') })

    expect(await agents.oneShotTarget(AGENT_IDS[1])).toBeNull()
  })
})
