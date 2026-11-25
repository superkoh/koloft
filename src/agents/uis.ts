// ADR-0054
import type { AgentUi } from '@core/agent/agentUi'
import type { AgentId } from '@core/agent/registry'
import { ui as claude } from './claude/renderer/ui'
import { ui as codex } from './codex/renderer/ui'
import { ui as agy } from './agy/renderer/ui'

export const AGENT_UIS: readonly AgentUi[] = [claude, codex, agy]

export function agentUi(id: AgentId): AgentUi {
  return AGENT_UIS.find((ui) => ui.id === id)!
}
