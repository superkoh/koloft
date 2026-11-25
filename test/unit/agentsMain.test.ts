import { describe, expect, it } from 'vitest'
import { AgentsMain, type AgentCatalog, type OneShotTarget } from '../../src/core/agent/agentsMain'
import { AGENT_IDS, type AgentId } from '../../src/core/agent/registry'

const targetOf = (binary: string): OneShotTarget => ({ binary, env: {}, done: () => {} })

const catalogOf = (id: AgentId): AgentCatalog => ({
  mcpServersOn: async (folders) =>
    folders.map((onlyIn) => ({ name: `${id}'s`, backend: id, onlyIn }))
})

describe('the agents registered with their main-process side', () => {
  it('asks the agent that was named, and no other, for its one-shot target', async () => {
    const agents = new AgentsMain()
    for (const id of AGENT_IDS)
      agents.register({
        id,
        oneShotTarget: async () => targetOf(`the ${id} program`),
        catalog: catalogOf(id)
      })

    for (const id of AGENT_IDS)
      expect((await agents.oneShotTarget(id))?.binary).toBe(`the ${id} program`)
  })

  it('answers that an agent that was not built has no one-shot target, without an error', async () => {
    const agents = new AgentsMain()
    agents.register({
      id: AGENT_IDS[0],
      oneShotTarget: async () => targetOf('built'),
      catalog: catalogOf(AGENT_IDS[0])
    })

    expect(await agents.oneShotTarget(AGENT_IDS[1])).toBeNull()
  })

  it('lists the MCP servers of every agent that was built, in the order of the list of agents, whatever order they were registered in', async () => {
    const agents = new AgentsMain()
    const built = AGENT_IDS.filter((_, i) => i !== 1)
    for (const id of [...built].reverse())
      agents.register({ id, oneShotTarget: async () => null, catalog: catalogOf(id) })

    expect((await agents.mcpServersOn(['/w'])).map((s) => s.backend)).toEqual(built)
  })
})
