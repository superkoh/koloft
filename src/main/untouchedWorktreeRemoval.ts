import type { BackendId } from '@shared/types'
import type { GitOut } from '@core/worktree'
import type { WorktreeRecordsOfEveryAgent, WorktreeResource } from '@core/agent/worktreeRecords'
import type { TreeRemovals } from './treeRemovals'

export interface UntouchedWorktreeRemovalDeps {
  sleeperTrees(): string[]
  cronRunner: { tidiesFolder(tree: string): boolean } | null | undefined
  sessionBackends: {
    occupantOf(dir: string): string | null
    readonly worktreeRecords: Pick<WorktreeRecordsOfEveryAgent, 'untouched' | 'recordedByAnother'>
  }
  worktreesOfEveryAgent: { readonly preparing: Map<string, Promise<unknown>> }
  treeRemovals: Pick<TreeRemovals, 'has' | 'run'>
  removeTree(
    git: GitOut,
    tree: { root: string; treeRoot: string; worktreeName: string; branches: string[] }
  ): Promise<string | null>
  hostGitOut: GitOut
  dirExists(dir: string): Promise<boolean>
  toast(text: string): void
}

export async function removeUntouchedWorktreeWith(
  d: UntouchedWorktreeRemovalDeps,
  owner: { readonly id: BackendId } | null | undefined,
  resource: WorktreeResource
): Promise<void> {
  const { sleeperTrees, cronRunner, sessionBackends, treeRemovals, removeTree, hostGitOut } = d
  const { preparing } = d.worktreesOfEveryAgent
  const tree = resource.worktreePath
  const someoneElseIsIn = (id: BackendId): boolean =>
    sleeperTrees().includes(tree) ||
    !!cronRunner?.tidiesFolder(tree) ||
    !!sessionBackends.occupantOf(tree) ||
    sessionBackends.worktreeRecords.recordedByAnother(id, tree)
  if (!owner || preparing.has(tree) || someoneElseIsIn(owner.id)) return
  if (treeRemovals.has(tree)) return
  let release = (): void => {}
  const held = new Promise<void>((r) => (release = r))
  preparing.set(tree, held)
  let problem: string | null = null
  try {
    if (!(await sessionBackends.worktreeRecords.untouched(owner.id, resource))) return
    if (someoneElseIsIn(owner.id)) return
    problem = await treeRemovals.run(tree, () =>
      removeTree(hostGitOut, {
        root: resource.originalCwd,
        treeRoot: tree,
        worktreeName: resource.worktreeName,
        branches: [`worktree-${resource.worktreeName}`]
      })
    )
  } finally {
    if (preparing.get(tree) === held) preparing.delete(tree)
    release()
  }
  if (problem && (await d.dirExists(tree))) d.toast(problem)
}
