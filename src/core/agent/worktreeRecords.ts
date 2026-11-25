import type { BackendId } from '@shared/types'

export interface WorktreeResource {
  id: string
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch: string | null
  originalHeadCommit: string
  state: 'creating' | 'ready' | 'failed'
  managed: boolean
  error?: string
}

export interface KeepsWorktreeRecords {
  readonly id: BackendId
  readonly store: {
    listResources(): WorktreeResource[]
    removeUnusedResourcesAt(worktreePath: string): void
  }
  readonly worktrees: {
    recorded(worktreePath: string): boolean
    untouched(record: WorktreeResource): Promise<boolean>
  }
}

export interface WorktreeRecordOfAgent {
  backendId: BackendId
  record: WorktreeResource
}

export interface WorktreeRecordsOfEveryAgent {
  recorded(dir: string): boolean
  at(backendId: BackendId, dir: string): WorktreeResource | undefined
  untouched(backendId: BackendId, record: WorktreeResource): Promise<boolean>
  forgetUnusedAt(treeRoot: string): void
  of(workspace: string): WorktreeRecordOfAgent[]
}

export function worktreeRecordsOfEveryAgent(
  keepers: () => readonly KeepsWorktreeRecords[]
): WorktreeRecordsOfEveryAgent {
  const keeper = (backendId: BackendId): KeepsWorktreeRecords | undefined =>
    keepers().find((k) => k.id === backendId)
  return {
    recorded: (dir) => keepers().some((k) => k.worktrees.recorded(dir)),
    at: (backendId, dir) =>
      keeper(backendId)
        ?.store.listResources()
        .find((record) => record.worktreePath === dir),
    untouched: async (backendId, record) =>
      !!(await keeper(backendId)?.worktrees.untouched(record)),
    forgetUnusedAt: (treeRoot) => {
      for (const k of keepers()) k.store.removeUnusedResourcesAt(treeRoot)
    },
    of: (workspace) =>
      keepers().flatMap((k) =>
        k.store
          .listResources()
          .filter((record) => record.originalCwd === workspace)
          .map((record) => ({ backendId: k.id, record }))
      )
  }
}
