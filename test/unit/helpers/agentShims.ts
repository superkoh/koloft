import {
  AgentsMain,
  type AgentMachinePackage,
  type AgentShimScript,
  type AgentTools
} from '../../../src/core/agent/agentsMain'
import { AGENT_IDS, type AgentId } from '../../../src/core/agent/registry'
import { claudeTools } from '../../../src/agents/claude/main/claudeShim'
import { CODEX_SANDBOX_IS_READ_ONLY, codexTools } from '../../../src/agents/codex/main/codexShim'
import { COULD_NOT_REACH_KOLOFT } from '../../../src/core/command'
import { agyTools } from '../../../src/agents/agy/main/agyShim'
import { claudeMachinePackage } from '../../../src/agents/claude/main/claudeMachinePackage'
import { codexMachinePackage } from '../../../src/agents/codex/main/codexMachine'
import { agyMachinePackage } from '../../../src/agents/agy/main/agyMachinePackage'
import { accountsThatAreNeverAsked } from './agentAccounts'
import { EVERY_AGENTS_ONE_SHOT } from './agentOneShots'
import { PARTS_THE_TEST_DOES_NOT_USE } from './agentMainParts'

export const EVERY_AGENTS_TOOLS: Record<AgentId, AgentTools> = {
  claude: claudeTools,
  codex: codexTools,
  agy: agyTools
}

export const EVERY_AGENTS_MACHINE_PACKAGE: Record<AgentId, AgentMachinePackage> = {
  claude: claudeMachinePackage,
  codex: codexMachinePackage,
  agy: agyMachinePackage
}

export const CANNOT_WRITE_THE_REQUEST = {
  codex: CODEX_SANDBOX_IS_READ_ONLY,
  agy: COULD_NOT_REACH_KOLOFT
}

export function everyAgentWithItsOwnTools(): AgentsMain {
  const agents = new AgentsMain()
  for (const id of AGENT_IDS)
    agents.register({
      id,
      oneShotTarget: async () => null,
      catalog: {
        moreSkillFoldersEveryAccountReadsOnThisMac: () => [],
        mcpServersOn: async () => [],
        listedModels: async () => undefined,
        oneShot: EVERY_AGENTS_ONE_SHOT[id]
      },
      tools: EVERY_AGENTS_TOOLS[id],
      accounts: accountsThatAreNeverAsked,
      ...PARTS_THE_TEST_DOES_NOT_USE,
      machinePackage: EVERY_AGENTS_MACHINE_PACKAGE[id]
    })
  return agents
}

export function everyAgentsShimScripts(): AgentShimScript[] {
  return everyAgentWithItsOwnTools().shimScripts()
}
