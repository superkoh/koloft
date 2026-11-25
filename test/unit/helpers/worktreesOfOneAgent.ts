import type { SessionStore } from '../../../src/agents/kit/main/sessionStore'
import type { WorktreesOfEveryAgent } from '../../../src/agents/kit/main/sessionWorktrees'

export function worktreesOfOneAgent(store: () => SessionStore): WorktreesOfEveryAgent {
  return {
    recorded: (dir) =>
      store()
        .listResources()
        .some((r) => r.worktreePath === dir),
    preparing: new Set()
  }
}
