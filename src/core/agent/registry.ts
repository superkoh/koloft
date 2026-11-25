// ADR-0054
import { AGENTS, OWNER_OF_UNNAMED_OLD_DATA, PICKED_ON_FIRST_OPEN } from '@agents/list'
import type { AccountKindFacts, AgentFlags, AgentManifest } from './manifest'

type ListedAgent = (typeof AGENTS)[number]

export type AgentId = ListedAgent['id']

export type AgentCommand = ListedAgent['command']

export type AccountKindId = ListedAgent['accountKinds'][number]['id']

type SignInFolderKindOf<Agent extends ListedAgent> = Extract<
  Agent['accountKinds'][number],
  { isASignInFolder: true }
>['id']

export type SignInFolderOf = {
  [
    Agent in ListedAgent as [SignInFolderKindOf<Agent>] extends [never] ? never : Agent['id']
  ]: SignInFolderKindOf<Agent>
}

export const AGENT_MANIFESTS: readonly AgentManifest[] = AGENTS

export const AGENT_IDS: readonly AgentId[] = AGENTS.map((agent) => agent.id)

export const AGENT_COMMANDS: readonly AgentCommand[] = AGENTS.map((agent) => agent.command)

export function agentManifest(id: AgentId): AgentManifest {
  return AGENT_MANIFESTS.find((agent) => agent.id === id)!
}

const ACCOUNT_KIND_FACTS: readonly AccountKindFacts[] = AGENT_MANIFESTS.flatMap(
  (agent) => agent.accountKinds
)

export const ACCOUNT_KIND_IDS = ACCOUNT_KIND_FACTS.map((kind) => kind.id) as AccountKindId[]

export function accountKindFacts(id: AccountKindId): AccountKindFacts {
  return ACCOUNT_KIND_FACTS.find((kind) => kind.id === id)!
}

export function agentOfAccountKind(kind: AccountKindId): AgentId | undefined {
  return AGENT_IDS.find((id) => agentManifest(id).accountKinds.some((own) => own.id === kind))
}

export function ofEachAgent<T>(value: (id: AgentId) => T): Record<AgentId, T> {
  return Object.fromEntries(AGENT_IDS.map((id) => [id, value(id)])) as Record<AgentId, T>
}

export const A_COMMAND_WITH_ITS_CHOICE_AFTER_IT: string | undefined = AGENT_MANIFESTS.find(
  (agent) => agent.commandWithItsChoiceAfterIt
)?.commandWithItsChoiceAfterIt

export function agentsThatSay(flag: keyof AgentFlags): AgentId[] {
  return AGENT_IDS.filter((id) => agentManifest(id).flags[flag])
}

const ENV_THAT_MISLEADS_WHAT_STARTS_INSIDE = AGENT_MANIFESTS.map(
  (agent) => agent.envOfItsSessionThatMisleadsWhatStartsInside
)

export function misleadsWhatStartsInsideAnAgentsSession(name: string): boolean {
  return ENV_THAT_MISLEADS_WHAT_STARTS_INSIDE.some(
    ({ named, startingWith }) =>
      named.includes(name) || startingWith.some((start) => name.startsWith(start))
  )
}

type OwnSettingNamesOf<Agent> = Agent extends { ownSettings: infer Own } ? keyof Own : never

export type AgentSettingValues = Record<OwnSettingNamesOf<(typeof AGENTS)[number]>, boolean>

const OWN_SETTINGS = AGENT_MANIFESTS.flatMap((agent) => Object.entries(agent.ownSettings))

export const AGENT_SETTING_DEFAULTS = Object.fromEntries(
  OWN_SETTINGS.map(([name, own]) => [name, own.default])
) as AgentSettingValues

export const AGENT_SETTINGS_KEPT_ON_RESET: readonly string[] = OWN_SETTINGS.filter(
  ([, own]) => own.keptOnReset
).map(([name]) => name)

export const AGENT_PICKED_ON_FIRST_OPEN: AgentId = PICKED_ON_FIRST_OPEN.id

export const AGENT_OF_UNNAMED_OLD_DATA: AgentId | undefined = AGENT_IDS.find(
  (id) => id === OWNER_OF_UNNAMED_OLD_DATA
)
