import path from 'path'
import { formatRemoteKey, parseRemoteKey } from '@shared/remoteKey'
import { realpathSafe } from './projectInfo'
import { worktreeHomeRoot } from './resumePlan'
import type { TreeRemovals } from './treeRemovals'

export type WorktreesBeingPrepared = Map<string, Promise<unknown>>

function worktreeFolderAround(dir: string): string {
  for (let d = dir; path.dirname(d) !== d; d = path.dirname(d)) if (worktreeHomeRoot(d)) return d
  return dir
}

export function preparedKeyOf(dir: string): string {
  const remote = parseRemoteKey(dir)
  const tree = worktreeFolderAround(remote ? remote.path : dir)
  if (remote) return formatRemoteKey(remote.host, tree)
  return `${realpathSafe(path.dirname(tree))}/${path.basename(tree)}`
}

export async function whenNobodyPrepares(
  preparing: WorktreesBeingPrepared,
  key: string
): Promise<void> {
  for (let p = preparing.get(key); p; p = preparing.get(key)) await p.catch(() => undefined)
}

export async function holdingTheFolder<T>(
  preparing: WorktreesBeingPrepared,
  key: string,
  work: () => Promise<T>
): Promise<T> {
  for (let p = preparing.get(key); p; p = preparing.get(key)) await p.catch(() => undefined)
  let release = (): void => {}
  const held = new Promise<void>((r) => (release = r))
  preparing.set(key, held)
  try {
    return await work()
  } finally {
    if (preparing.get(key) === held) preparing.delete(key)
    release()
  }
}

export function removingTheWorktree<T>(
  d: { preparing: WorktreesBeingPrepared; treeRemovals: Pick<TreeRemovals, 'run'> },
  tree: string,
  work: () => Promise<T>
): Promise<T> {
  return holdingTheFolder(d.preparing, preparedKeyOf(tree), () => d.treeRemovals.run(tree, work))
}
