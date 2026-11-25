import { AgentsMain, type AgentCatalog } from '../../../src/core/agent/agentsMain'
import { accountsThatAreNeverAsked } from './agentAccounts'
import type { AgentId } from '../../../src/core/agent/registry'
import { isGitCheckoutAsync } from '../../../src/main/projectInfo'
import { claudeCatalog } from '../../../src/agents/claude/main/claudeCatalog'
import { codexCatalog } from '../../../src/agents/codex/main/codexCatalog'
import { agyCatalog } from '../../../src/agents/agy/main/agyCatalog'
import { EVERY_AGENTS_TOOLS } from './agentShims'

export interface OwnersSettings {
  codexConfig: string
  ownersGemini: string
}

export function agentsWithTheirCatalogs(owners: OwnersSettings): AgentsMain {
  const catalogs: Record<AgentId, AgentCatalog> = {
    claude: claudeCatalog,
    codex: codexCatalog(() => owners.codexConfig),
    agy: agyCatalog(() => owners.ownersGemini, isGitCheckoutAsync)
  }
  const agents = new AgentsMain()
  for (const [id, catalog] of Object.entries(catalogs) as [AgentId, AgentCatalog][])
    agents.register({
      id,
      oneShotTarget: async () => null,
      catalog,
      tools: EVERY_AGENTS_TOOLS[id],
      accounts: accountsThatAreNeverAsked
    })
  return agents
}
