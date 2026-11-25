// ADR-0054
import type { McpServer } from '@shared/types'
import { AGENT_IDS, agentManifest, type AgentId } from './registry'
import type { AgentUsage } from './usage'
import type { AgentSearch } from './search'

export interface OneShotTarget {
  binary: string
  env: NodeJS.ProcessEnv
  args?: string[]
  done(): void
}

export interface AgentCatalog {
  moreSkillFoldersEveryAccountReadsOnThisMac(): readonly string[]
  mcpServersOn(folders: readonly string[]): Promise<McpServer[]>
}

export interface AgentTools {
  shimScript(): string
}

export interface AgentShimScript {
  command: string
  script: string
}

export interface AgentMain {
  id: AgentId
  oneShotTarget(): Promise<OneShotTarget | null>
  catalog: AgentCatalog
  tools: AgentTools
  usage: AgentUsage
  search: AgentSearch
}

export class AgentsMain {
  private built = new Map<AgentId, AgentMain>()

  register(agent: AgentMain): void {
    this.built.set(agent.id, agent)
  }

  inListOrder(): AgentMain[] {
    return AGENT_IDS.flatMap((id) => this.built.get(id) ?? [])
  }

  async oneShotTarget(id: AgentId): Promise<OneShotTarget | null> {
    return (await this.built.get(id)?.oneShotTarget()) ?? null
  }

  moreSkillFoldersEveryAccountReadsOnThisMac(id: AgentId): readonly string[] {
    return this.built.get(id)?.catalog.moreSkillFoldersEveryAccountReadsOnThisMac() ?? []
  }

  shimScripts(): AgentShimScript[] {
    return this.inListOrder().map((agent) => ({
      command: agentManifest(agent.id).command,
      script: agent.tools.shimScript()
    }))
  }

  async mcpServersOn(folders: readonly string[]): Promise<McpServer[]> {
    const each = await Promise.all(
      this.inListOrder().map((agent) => agent.catalog.mcpServersOn(folders))
    )
    return each.flat()
  }
}
