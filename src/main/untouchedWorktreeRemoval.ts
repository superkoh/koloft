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
  const anotherNeedsIt = (id: BackendId): boolean =>
    preparing.has(tree) || sessionBackends.worktreeRecords.recordedByAnother(id, tree)
  if (sleeperTrees().includes(tree) || cronRunner?.tidiesFolder(tree)) return
  if (sessionBackends.occupantOf(tree)) return
  if (!owner || anotherNeedsIt(owner.id)) return
  if (!(await sessionBackends.worktreeRecords.untouched(owner.id, resource))) return
  if (anotherNeedsIt(owner.id) || sessionBackends.occupantOf(tree)) return
  if (treeRemovals.has(tree)) return
  const removal = treeRemovals.run(tree, () =>
    removeTree(hostGitOut, {
      root: resource.originalCwd,
      treeRoot: tree,
      worktreeName: resource.worktreeName,
      branches: [`worktree-${resource.worktreeName}`]
    })
  )
  const held = removal.catch(() => null)
  preparing.set(tree, held)
  let problem: string | null
  try {
    problem = await removal
  } finally {
    if (preparing.get(tree) === held) preparing.delete(tree)
  }
  if (problem && (await d.dirExists(tree))) d.toast(problem)
}
