import { describe, expect, it } from 'vitest'
import {
  AgentsMain,
  type AgentAccounts,
  type AgentCatalog,
  type AgentTools,
  type OneShotTarget
} from '../../src/core/agent/agentsMain'
import { AGENT_IDS, agentManifest, type AgentId } from '../../src/core/agent/registry'
import { ACCOUNT_KINDS_OF } from '../../src/shared/accountUsage'
import { accountsThatAreNeverAsked } from './helpers/agentAccounts'
import { NOTHING_TO_READ_OR_SEARCH } from './helpers/agentMainParts'

const targetOf = (binary: string): OneShotTarget => ({ binary, env: {}, done: () => {} })

const catalogOf = (id: AgentId): AgentCatalog => ({
  moreSkillFoldersEveryAccountReadsOnThisMac: () => [`/${id}/skills`],
  mcpServersOn: async (folders) =>
    folders.map((onlyIn) => ({ name: `${id}'s`, backend: id, onlyIn }))
})

const toolsOf = (id: AgentId): AgentTools => ({ shimScript: () => `the ${id} shim` })

const accountsThatSayWhoTheyAre = (id: AgentId, asked: string[]): AgentAccounts => ({
  pickForThisStart: async (ask) => ({ account: `${id}'s`, tabId: ask.tabId }),
  probeAll: async () => {
    asked.push(`${id} probes`)
  },
  addSecret: async (kind, name) => {
    asked.push(`${id} adds ${kind} ${name}`)
    return { ok: true }
  },
  forget: (kind, name) => {
    asked.push(`${id} forgets ${kind} ${name}`)
  },
  folderSaysItRunsOnAKey: (kind, name) => {
    asked.push(`${id} reads ${kind} ${name}`)
    return true
  }
})

const agentsWithAccounts = (ids: readonly AgentId[], asked: string[] = []): AgentsMain => {
  const agents = new AgentsMain()
  for (const id of ids)
    agents.register({
      id,
      oneShotTarget: async () => null,
      catalog: catalogOf(id),
      tools: toolsOf(id),
      accounts: accountsThatSayWhoTheyAre(id, asked),
      ...NOTHING_TO_READ_OR_SEARCH
    })
  return agents
}

describe('the agents registered with their main-process side', () => {
  it('asks the agent that was named, and no other, for its one-shot target', async () => {
    const agents = new AgentsMain()
    for (const id of AGENT_IDS)
      agents.register({
        id,
        oneShotTarget: async () => targetOf(`the ${id} program`),
        catalog: catalogOf(id),
        tools: toolsOf(id),
        accounts: accountsThatAreNeverAsked,
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
      accounts: accountsThatAreNeverAsked,
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
        accounts: accountsThatAreNeverAsked,
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
        accounts: accountsThatAreNeverAsked,
        ...NOTHING_TO_READ_OR_SEARCH
      })

    expect(agents.shimScripts()).toEqual(
      built.map((id) => ({ command: agentManifest(id).command, script: `the ${id} shim` }))
    )
  })

  it('asks the agent that was named which account this start gets, and answers an agent that was not built, or none, with an empty answer', async () => {
    const agents = agentsWithAccounts([AGENT_IDS[0]])

    expect(await agents.pickForThisStart(AGENT_IDS[0], { tabId: 't1' })).toEqual({
      account: `${AGENT_IDS[0]}'s`,
      tabId: 't1'
    })
    expect(await agents.pickForThisStart(AGENT_IDS[1], { tabId: 't1' })).toEqual({})
    expect(await agents.pickForThisStart(undefined, { tabId: 't1' })).toEqual({})
  })

  it('probes the accounts of every agent that was built', async () => {
    const asked: string[] = []
    const built = AGENT_IDS.filter((_, i) => i !== 1)

    await agentsWithAccounts(built, asked).probeAllAccounts()

    expect(asked).toEqual(built.map((id) => `${id} probes`))
  })

  it('adds a pasted secret to, forgets an account of, and reads the folder of the agent whose manifest lists that kind of account, and no other', async () => {
    const asked: string[] = []
    const agents = agentsWithAccounts(AGENT_IDS, asked)

    for (const id of AGENT_IDS)
      for (const kind of ACCOUNT_KINDS_OF[id]) {
        asked.length = 0
        await agents.addSecret(kind, 'work', 'secret')
        agents.forgetAccount(kind, 'work')
        expect(agents.folderSaysItRunsOnAKey(kind, 'work')).toBe(true)
        expect(asked).toEqual([
          `${id} adds ${kind} work`,
          `${id} forgets ${kind} work`,
          `${id} reads ${kind} work`
        ])
      }
  })

  it('for a kind of account no built agent lists: adding a secret fails, forgetting does nothing, and its folder says no key', async () => {
    const asked: string[] = []
    const agents = agentsWithAccounts([AGENT_IDS[0]], asked)
    const kind = ACCOUNT_KINDS_OF[AGENT_IDS[1]][0]

    expect(() => agents.addSecret(kind, 'work', 'secret')).toThrow()
    agents.forgetAccount(kind, 'work')
    expect(agents.folderSaysItRunsOnAKey(kind, 'work')).toBe(false)
    expect(asked).toEqual([])
  })
})
