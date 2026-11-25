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

export interface WorktreeRecords {
  of(workspace: string): WorktreeResource[]
  at(dir: string): WorktreeResource | undefined
  untouched(record: WorktreeResource): Promise<boolean>
  forgetUnusedAt(treeRoot: string): void
}

export const A_FOLDER_BEING_PREPARED = 'Worktree preparation is already in progress'

export const A_NAME_WITH_A_RECOVERY_RECORD =
  'This worktree name has a recovery record; recover it or choose a different name'

export const KEEPS_NO_WORKTREE_RECORDS: WorktreeRecords = {
  of: () => [],
  at: () => undefined,
  untouched: async () => false,
  forgetUnusedAt: () => {}
}

export interface KeepsWorktreeRecords {
  readonly id: BackendId
  readonly worktreeRecords: WorktreeRecords
}

export interface WorktreeRecordOfAgent {
  backendId: BackendId
  record: WorktreeResource
}

export interface WorktreeRecordsOfEveryAgent {
  recorded(dir: string): boolean
  recordedByAnother(backendId: BackendId, dir: string): boolean
  at(backendId: BackendId, dir: string): WorktreeResource | undefined
  untouched(backendId: BackendId, record: WorktreeResource): Promise<boolean>
  forgetUnusedAt(treeRoot: string): void
  of(workspace: string): WorktreeRecordOfAgent[]
}

export function worktreeRecordsOfEveryAgent(
  agents: () => readonly KeepsWorktreeRecords[]
): WorktreeRecordsOfEveryAgent {
  const recordsOf = (backendId: BackendId): WorktreeRecords | undefined =>
    agents().find((a) => a.id === backendId)?.worktreeRecords
  return {
    recorded: (dir) => agents().some((a) => a.worktreeRecords.at(dir) !== undefined),
    recordedByAnother: (backendId, dir) =>
      agents().some((a) => a.id !== backendId && a.worktreeRecords.at(dir) !== undefined),
    at: (backendId, dir) => recordsOf(backendId)?.at(dir),
    untouched: async (backendId, record) =>
      (await recordsOf(backendId)?.untouched(record)) ?? false,
    forgetUnusedAt: (treeRoot) => {
      for (const a of agents()) a.worktreeRecords.forgetUnusedAt(treeRoot)
    },
    of: (workspace) =>
      agents().flatMap((a) =>
        a.worktreeRecords.of(workspace).map((record) => ({ backendId: a.id, record }))
      )
  }
}
