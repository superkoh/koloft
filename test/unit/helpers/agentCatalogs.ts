import {
  AgentsMain,
  type AgentAccounts,
  type AgentCatalog
} from '../../../src/core/agent/agentsMain'
import type { AgentId } from '../../../src/core/agent/registry'
import { isGitCheckoutAsync } from '../../../src/main/projectInfo'
import { claudeCatalog } from '../../../src/agents/claude/main/claudeCatalog'
import { codexCatalog } from '../../../src/agents/codex/main/codexCatalog'
import { agyCatalog } from '../../../src/agents/agy/main/agyCatalog'

export interface OwnersSettings {
  codexConfig: string
  ownersGemini: string
}

const asked = (): never => {
  throw new Error('these accounts are never asked')
}

export const accountsThatAreNeverAsked: AgentAccounts = {
  pickForThisStart: asked,
  probeAll: asked,
  addSecret: asked,
  forget: asked,
  folderSaysItRunsOnAKey: asked
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
      accounts: accountsThatAreNeverAsked
    })
  return agents
}
