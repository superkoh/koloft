// ADR-0054
import { AGENTS, OWNER_OF_UNNAMED_OLD_DATA, PICKED_ON_FIRST_OPEN } from '@agents/list'
import type { AgentManifest } from './manifest'

export type AgentId = (typeof AGENTS)[number]['id']

export const AGENT_MANIFESTS: readonly AgentManifest[] = AGENTS

export const AGENT_IDS: readonly AgentId[] = AGENTS.map((agent) => agent.id)

const MANIFEST_OF = new Map<AgentId, AgentManifest>(AGENTS.map((agent) => [agent.id, agent]))

export function agentManifest(id: AgentId): AgentManifest {
  return MANIFEST_OF.get(id)!
}

export const AGENT_PICKED_ON_FIRST_OPEN: AgentId = PICKED_ON_FIRST_OPEN.id

export const AGENT_OF_UNNAMED_OLD_DATA: AgentId = OWNER_OF_UNNAMED_OLD_DATA
