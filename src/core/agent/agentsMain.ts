// ADR-0054
import type { AgentId } from './registry'

export interface OneShotTarget {
  binary: string
  env: NodeJS.ProcessEnv
  args?: string[]
  done(): void
}

export interface AgentMain {
  id: AgentId
  oneShotTarget(): Promise<OneShotTarget | null>
}

export class AgentsMain {
  private built = new Map<AgentId, AgentMain>()

  register(agent: AgentMain): void {
    this.built.set(agent.id, agent)
  }

  async oneShotTarget(id: AgentId): Promise<OneShotTarget | null> {
    return (await this.built.get(id)?.oneShotTarget()) ?? null
  }
}
