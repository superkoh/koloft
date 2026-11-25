// ADR-0054
import type { McpServer } from '@shared/types'
import { AGENT_IDS, type AgentId } from './registry'

export interface OneShotTarget {
  binary: string
  env: NodeJS.ProcessEnv
  args?: string[]
  done(): void
}

export interface AgentCatalog {
  mcpServersOn(folders: readonly string[]): Promise<McpServer[]>
}

export interface AgentMain {
  id: AgentId
  oneShotTarget(): Promise<OneShotTarget | null>
  catalog: AgentCatalog
}

export class AgentsMain {
  private built = new Map<AgentId, AgentMain>()

  register(agent: AgentMain): void {
    this.built.set(agent.id, agent)
  }

  private inListOrder(): AgentMain[] {
    return AGENT_IDS.flatMap((id) => this.built.get(id) ?? [])
  }

  async oneShotTarget(id: AgentId): Promise<OneShotTarget | null> {
    return (await this.built.get(id)?.oneShotTarget()) ?? null
  }

  async mcpServersOn(folders: readonly string[]): Promise<McpServer[]> {
    const each = await Promise.all(
      this.inListOrder().map((agent) => agent.catalog.mcpServersOn(folders))
    )
    return each.flat()
  }
}
