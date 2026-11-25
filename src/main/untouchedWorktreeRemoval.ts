import type { BackendId } from '@shared/types'
import type { GitOut } from '@core/worktree'
import type { WorktreeRecordsOfEveryAgent, WorktreeResource } from '@core/agent/worktreeRecords'
import type { TreeRemovals } from './treeRemovals'

export interface UntouchedWorktreeRemovalDeps {
  sleeperTrees(): string[]
  cronRunner: { tidiesFolder(tree: string): boolean } | null | undefined
  sessionBackends: {
    occupantOf(dir: string): string | null
    readonly worktreeRecords: Pick<WorktreeRecordsOfEveryAgent, 'untouched'>
  }
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
  const tree = resource.worktreePath
  if (sleeperTrees().includes(tree) || cronRunner?.tidiesFolder(tree)) return
  if (sessionBackends.occupantOf(tree)) return
  if (!owner || !(await sessionBackends.worktreeRecords.untouched(owner.id, resource))) return
  if (treeRemovals.has(tree)) return
  const problem = await treeRemovals.run(tree, () =>
    removeTree(hostGitOut, {
      root: resource.originalCwd,
      treeRoot: tree,
      worktreeName: resource.worktreeName,
      branches: [`worktree-${resource.worktreeName}`]
    })
  )
  if (problem && (await d.dirExists(tree))) d.toast(problem)
}
