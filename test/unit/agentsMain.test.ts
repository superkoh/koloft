import { describe, expect, it } from 'vitest'
import {
  AgentsMain,
  NO_SUCH_ACTION,
  type AgentAccounts,
  type AgentCatalog,
  type AgentTools,
  type OneShotTarget
} from '../../src/core/agent/agentsMain'
import {
  AGENT_IDS,
  accountKindFacts,
  agentManifest,
  type AccountKindId,
  type AgentId
} from '../../src/core/agent/registry'
import { ACCOUNT_KINDS_OF } from '../../src/shared/accountUsage'
import type { SignInNews, SignInProgress } from '../../src/shared/types'
import { accountsThatAreNeverAsked } from './helpers/agentAccounts'
import { EVERY_AGENTS_ONE_SHOT } from './helpers/agentOneShots'
import { NOTHING_TO_READ_OR_SEARCH } from './helpers/agentMainParts'

const targetOf = (binary: string): OneShotTarget => ({ binary, env: {}, done: () => {} })

const catalogOf = (id: AgentId): AgentCatalog => ({
  moreSkillFoldersEveryAccountReadsOnThisMac: () => [`/${id}/skills`],
  mcpServersOn: async (folders) =>
    folders.map((onlyIn) => ({ name: `${id}'s`, backend: id, onlyIn })),
  listedModels: async () => [{ id: `${id}'s model`, efforts: [] }],
  oneShot: EVERY_AGENTS_ONE_SHOT[id]
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
  },
  signIn: async (kind, name, again) => {
    asked.push(`${id} signs in ${kind} ${name}`)
    return { ok: true, progress: { kind, name, again, phase: 'starting' } }
  },
  cancelSignIn: (kind, name) => {
    asked.push(`${id} cancels ${kind} ${name}`)
  },
  act: async (kind, name, action) => {
    asked.push(`${id} does ${action} on ${kind} ${name}`)
    return `${id}'s answer`
  }
})

const progressOf = (
  kind: AccountKindId,
  name: string,
  phase: SignInProgress['phase']
): SignInProgress => ({ kind, name, again: false, phase })

const watched = (
  agents: AgentsMain
): { news: SignInNews[]; heldChanges: (SignInProgress | null)[] } => {
  const seen = { news: [] as SignInNews[], heldChanges: [] as (SignInProgress | null)[] }
  agents.watchSignIns((news, heldFailureChanged) => {
    seen.news.push(news)
    if (heldFailureChanged) seen.heldChanges.push(news.heldFailure)
  })
  return seen
}

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
  it('asks the agent that was named, and no other, for its one-shot target, its one-shot command and its model list', async () => {
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

    for (const id of AGENT_IDS) {
      expect((await agents.oneShotTarget(id))?.binary).toBe(`the ${id} program`)
      expect(agents.oneShot(id)).toBe(EVERY_AGENTS_ONE_SHOT[id])
      expect(await agents.listedModels(id)).toEqual([{ id: `${id}'s model`, efforts: [] }])
    }
  })

  it('answers that an agent that was not built has no one-shot target, no one-shot command, no model list and no skill folders, without an error', async () => {
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
    expect(await agents.listedModels(AGENT_IDS[1])).toBeUndefined()
    expect(agents.oneShot(AGENT_IDS[1])).toBeUndefined()
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

  it('hands an action on an account to the agent whose manifest lists that kind of account, and no other, and passes its answer back', async () => {
    const asked: string[] = []
    const agents = agentsWithAccounts(AGENT_IDS, asked)

    for (const id of AGENT_IDS)
      for (const kind of ACCOUNT_KINDS_OF[id]) {
        asked.length = 0
        expect(await agents.act(kind, 'work', 'anAction')).toBe(`${id}'s answer`)
        expect(asked).toEqual([`${id} does anAction on ${kind} work`])
      }
  })

  it('answers that there is no such action on a kind of account no built agent lists, without asking any agent', async () => {
    const asked: string[] = []
    const agents = agentsWithAccounts([AGENT_IDS[0]], asked)

    expect(await agents.act(ACCOUNT_KINDS_OF[AGENT_IDS[1]][0], 'work', 'anAction')).toBe(
      NO_SUCH_ACTION
    )
    expect(asked).toEqual([])
  })

  it('starts a sign-in with the agent whose manifest lists that kind of account, and refuses a kind that does not sign in through a browser without asking any agent', async () => {
    const asked: string[] = []
    const agents = agentsWithAccounts(AGENT_IDS, asked)

    for (const id of AGENT_IDS)
      for (const kind of ACCOUNT_KINDS_OF[id]) {
        asked.length = 0
        const started = await agents.signIn(kind, 'work', false)
        if (accountKindFacts(kind).signsInThroughABrowser) {
          expect(started.ok).toBe(true)
          expect(asked).toEqual([`${id} signs in ${kind} work`])
        } else {
          expect(started).toEqual({ ok: false, error: 'invalid-name' })
          expect(asked).toEqual([])
        }
      }
  })

  it('does not hold the failure of a sign-in that was never handed to a terminal tab, as Claude Code’s in the background is not: its box lives in the window', () => {
    const agents = agentsWithAccounts(AGENT_IDS)
    const seen = watched(agents)
    const failed = progressOf('oauth', 'work', 'failed')

    agents.signInChanged(progressOf('oauth', 'work', 'starting'))
    agents.signInChanged(failed)

    expect(agents.heldSignInFailure()).toBeNull()
    expect(seen.news.at(-1)).toEqual({ progress: failed, heldFailure: null })
    expect(seen.heldChanges).toEqual([])
  })

  it('holds the failure of a sign-in that was handed to a terminal tab, and a newer one takes its place, from whichever agent it comes', () => {
    const agents = agentsWithAccounts(AGENT_IDS)
    const seen = watched(agents)
    const first = progressOf('codex-home', 'work', 'failed')
    const second = progressOf('agy-home', 'home', 'failed')

    agents.signInChanged(progressOf('codex-home', 'work', 'inATab'))
    agents.signInChanged(progressOf('agy-home', 'home', 'inATab'))
    agents.signInChanged(first)
    expect(agents.heldSignInFailure()).toBe(first)
    agents.signInChanged(second)

    expect(agents.heldSignInFailure()).toBe(second)
    expect(seen.heldChanges).toEqual([first, second])
    expect(seen.news.at(-1)).toEqual({ progress: second, heldFailure: second })
  })

  it('holds the failure of every terminal tab of one account, when two were open for it at once', () => {
    const agents = agentsWithAccounts(AGENT_IDS)
    const seen = watched(agents)
    const first = { ...progressOf('codex-home', 'work', 'failed'), tail: 'the first tab' }
    const second = { ...progressOf('codex-home', 'work', 'failed'), tail: 'the second tab' }

    agents.signInChanged(progressOf('codex-home', 'work', 'inATab'))
    agents.signInChanged(progressOf('codex-home', 'work', 'inATab'))
    agents.signInChanged(first)
    agents.signInChanged(second)

    expect(seen.heldChanges).toEqual([first, second])
  })

  it('ending a sign-in forgets the failure held for that account first, then asks the agent that keeps that kind of account to cancel it', () => {
    const asked: string[] = []
    const agents = agentsWithAccounts(AGENT_IDS, asked)
    agents.watchSignIns((news, heldFailureChanged) => {
      if (heldFailureChanged) asked.push(`held is now ${news.heldFailure?.name ?? 'nothing'}`)
    })
    agents.signInChanged(progressOf('codex-home', 'work', 'inATab'))
    agents.signInChanged(progressOf('codex-home', 'work', 'failed'))
    asked.length = 0

    agents.endSignIn('codex-home', 'work')

    expect(agents.heldSignInFailure()).toBeNull()
    expect(asked).toEqual(['held is now nothing', 'codex cancels codex-home work'])
  })

  it('ending the sign-in of another account leaves the failure held as it is', () => {
    const asked: string[] = []
    const agents = agentsWithAccounts(AGENT_IDS, asked)
    const failed = progressOf('codex-home', 'work', 'failed')
    agents.signInChanged(progressOf('codex-home', 'work', 'inATab'))
    agents.signInChanged(failed)
    const seen = watched(agents)

    agents.endSignIn('oauth', 'home')

    expect(agents.heldSignInFailure()).toBe(failed)
    expect(seen.heldChanges).toEqual([])
    expect(asked).toEqual(['claude cancels oauth home'])
  })
})
