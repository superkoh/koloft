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

export function agentsThatSay(flag: keyof AgentFlags, answer = true): AgentId[] {
  return AGENT_IDS.filter((id) => agentManifest(id).flags[flag] === answer)
}

export const AGENT_PICKED_ON_FIRST_OPEN: AgentId = PICKED_ON_FIRST_OPEN.id

export const AGENT_OF_UNNAMED_OLD_DATA: AgentId = OWNER_OF_UNNAMED_OLD_DATA
