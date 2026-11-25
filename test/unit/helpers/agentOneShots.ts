import type { AgentOneShot } from '../../../src/core/agent/agentsMain'
import type { AgentId } from '../../../src/core/agent/registry'
import { claudeOneShot } from '../../../src/agents/claude/main/claudeCatalog'
import { codexOneShot } from '../../../src/agents/codex/main/codexCatalog'
import { agyOneShot } from '../../../src/agents/agy/main/agyCatalog'

export const EVERY_AGENTS_ONE_SHOT: Record<AgentId, AgentOneShot> = {
  claude: claudeOneShot,
  codex: codexOneShot,
  agy: agyOneShot
}
