import { describe, expect, it } from 'vitest'
import {
  AgentsMain,
  type AgentCatalog,
  type AgentTools,
  type OneShotTarget
} from '../../src/core/agent/agentsMain'
import { AGENT_IDS, agentManifest, type AgentId } from '../../src/core/agent/registry'
import { NOTHING_TO_READ_OR_SEARCH } from './helpers/agentMainParts'

const targetOf = (binary: string): OneShotTarget => ({ binary, env: {}, done: () => {} })

const catalogOf = (id: AgentId): AgentCatalog => ({
  moreSkillFoldersEveryAccountReadsOnThisMac: () => [`/${id}/skills`],
  mcpServersOn: async (folders) =>
    folders.map((onlyIn) => ({ name: `${id}'s`, backend: id, onlyIn }))
})

const toolsOf = (id: AgentId): AgentTools => ({ shimScript: () => `the ${id} shim` })

describe('the agents registered with their main-process side', () => {
  it('asks the agent that was named, and no other, for its one-shot target', async () => {
    const agents = new AgentsMain()
    for (const id of AGENT_IDS)
      agents.register({
        id,
        oneShotTarget: async () => targetOf(`the ${id} program`),
        catalog: catalogOf(id),
        tools: toolsOf(id),
        ...NOTHING_TO_READ_OR_SEARCH
      })

    for (const id of AGENT_IDS)
      expect((await agents.oneShotTarget(id))?.binary).toBe(`the ${id} program`)
  })

  it('answers that an agent that was not built has no one-shot target and no skill folders, without an error', async () => {
    const agents = new AgentsMain()
    agents.register({
      id: AGENT_IDS[0],
      oneShotTarget: async () => targetOf('built'),
      catalog: catalogOf(AGENT_IDS[0]),
      tools: toolsOf(AGENT_IDS[0]),
      ...NOTHING_TO_READ_OR_SEARCH
    })

    expect(await agents.oneShotTarget(AGENT_IDS[1])).toBeNull()
    expect(agents.moreSkillFoldersEveryAccountReadsOnThisMac(AGENT_IDS[0])).toEqual([
      `/${AGENT_IDS[0]}/skills`
    ])
    expect(agents.moreSkillFoldersEveryAccountReadsOnThisMac(AGENT_IDS[1])).toEqual([])
  })

  it('lists the MCP servers of every agent that was built, in the order of the list of agents, whatever order they were registered in', async () => {
    const agents = new AgentsMain()
    const built = AGENT_IDS.filter((_, i) => i !== 1)
    for (const id of [...built].reverse())
      agents.register({
        id,
        oneShotTarget: async () => null,
        catalog: catalogOf(id),
        tools: toolsOf(id),
        ...NOTHING_TO_READ_OR_SEARCH
      })

    expect((await agents.mcpServersOn(['/w'])).map((s) => s.backend)).toEqual(built)
  })

  it('hands over the shim script of every agent that was built, named by its program, in the order of the list of agents, whatever order they were registered in', () => {
    const agents = new AgentsMain()
    const built = AGENT_IDS.filter((_, i) => i !== 1)
    for (const id of [...built].reverse())
      agents.register({
        id,
        oneShotTarget: async () => null,
        catalog: catalogOf(id),
        tools: toolsOf(id),
        ...NOTHING_TO_READ_OR_SEARCH
      })

    expect(agents.shimScripts()).toEqual(
      built.map((id) => ({ command: agentManifest(id).command, script: `the ${id} shim` }))
    )
  })
})
