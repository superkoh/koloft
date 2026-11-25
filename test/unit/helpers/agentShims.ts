import {
  AgentsMain,
  type AgentShimScript,
  type AgentTools
} from '../../../src/core/agent/agentsMain'
import { AGENT_IDS, type AgentId } from '../../../src/core/agent/registry'
import { claudeTools } from '../../../src/agents/claude/main/claudeShim'
import { CODEX_SANDBOX_IS_READ_ONLY, codexTools } from '../../../src/agents/codex/main/codexShim'
import { COULD_NOT_REACH_KOLOFT } from '../../../src/core/command'
import { agyTools } from '../../../src/agents/agy/main/agyShim'
import { accountsThatAreNeverAsked } from './agentAccounts'

export const EVERY_AGENTS_TOOLS: Record<AgentId, AgentTools> = {
  claude: claudeTools,
  codex: codexTools,
  agy: agyTools
}

export const CANNOT_WRITE_THE_REQUEST = {
  codex: CODEX_SANDBOX_IS_READ_ONLY,
  agy: COULD_NOT_REACH_KOLOFT
}

export function everyAgentsShimScripts(): AgentShimScript[] {
  const agents = new AgentsMain()
  for (const id of AGENT_IDS)
    agents.register({
      id,
      oneShotTarget: async () => null,
      catalog: {
        moreSkillFoldersEveryAccountReadsOnThisMac: () => [],
        mcpServersOn: async () => []
      },
      tools: EVERY_AGENTS_TOOLS[id],
      accounts: accountsThatAreNeverAsked
    })
  return agents.shimScripts()
}
