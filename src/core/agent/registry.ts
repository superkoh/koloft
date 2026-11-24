// ADR-0054
import { AGENTS, OWNER_OF_UNNAMED_OLD_DATA, PICKED_ON_FIRST_OPEN } from '@agents/list'
import type { AgentFlags, AgentManifest } from './manifest'

export type AgentId = (typeof AGENTS)[number]['id']

export const AGENT_MANIFESTS: readonly AgentManifest[] = AGENTS

export const AGENT_IDS: readonly AgentId[] = AGENTS.map((agent) => agent.id)

export function agentManifest(id: AgentId): AgentManifest {
  return AGENT_MANIFESTS.find((agent) => agent.id === id)!
}

export function ofEachAgent<T>(value: (id: AgentId) => T): Record<AgentId, T> {
  return Object.fromEntries(AGENT_IDS.map((id) => [id, value(id)])) as Record<AgentId, T>
}

export function agentsThatSay(flag: keyof AgentFlags): AgentId[] {
  return AGENT_IDS.filter((id) => agentManifest(id).flags[flag])
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

export const AGENT_OF_UNNAMED_OLD_DATA: AgentId = OWNER_OF_UNNAMED_OLD_DATA
