import path from 'path'
import { isRemoteKey } from '@shared/remoteKey'
import { realpathSafe } from './projectInfo'
import type { TreeRemovals } from './treeRemovals'

export type WorktreesBeingPrepared = Map<string, Promise<unknown>>

export function preparedKeyOf(tree: string): string {
  return isRemoteKey(tree) ? tree : `${realpathSafe(path.dirname(tree))}/${path.basename(tree)}`
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
