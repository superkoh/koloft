import path from 'path'
import { parseRemoteKey } from '@shared/remoteKey'
import type { ProjectInfo } from '@shared/types'
import { gitProbes, type GitOut } from './resumePlan'

export type ClosingTree = ProjectInfo & { branches: string[] }

const MOST_COMMITS_LISTED = 20
const DELETING_HUNDREDS_OF_THOUSANDS_OF_IGNORED_FILES_MS = 10 * 60_000

export async function closingTree(git: GitOut, info: ProjectInfo): Promise<ClosingTree | null> {
  if (!info.worktreeName) return null
  const named = `worktree-${path.basename(info.treeRoot)}`
  const [head, hasNamed] = await Promise.all([
    git(info.treeRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    gitProbes(git).branchExists(info.root, named)
  ])
  const branches = new Set<string>()
  if (head?.trim()) branches.add(head.trim())
  if (hasNamed) branches.add(named)
  return { ...info, branches: [...branches] }
}

export async function whatIsLeft(git: GitOut, tree: ClosingTree): Promise<string[]> {
  const [status, onlyHere] = await Promise.all([
    git(tree.treeRoot, ['status', '--porcelain=v1', '--untracked-files=all']),
    git(tree.treeRoot, [
      'log',
      '--oneline',
      `--max-count=${MOST_COMMITS_LISTED}`,
      'HEAD',
      ...tree.branches,
      '--not',
      ...tree.branches.map((b) => `--exclude=${b}`),
      '--branches',
      '--remotes'
    ])
  ])
  if (status === null) return [`git could not read ${tree.treeRoot}.`]
  const left: string[] = []
  if (status.trim()) left.push(`Changes not committed:\n${status.trimEnd()}`)
  if (onlyHere === null) return [...left, `git could not list the commits in ${tree.treeRoot}.`]
  if (onlyHere.trim())
    left.push(`Commits on no other branch and no remote branch:\n${onlyHere.trimEnd()}`)
  return left
}

// PLATFORM§30
export async function removeTree(git: GitOut, tree: ClosingTree): Promise<string | null> {
  const onItsHost = parseRemoteKey(tree.treeRoot)?.path ?? tree.treeRoot
  await git(tree.root, ['worktree', 'unlock', onItsHost])
  const removed = await git(
    tree.root,
    ['worktree', 'remove', onItsHost],
    DELETING_HUNDREDS_OF_THOUSANDS_OF_IGNORED_FILES_MS
  )
  if (removed === null) return `git could not remove the worktree ${tree.treeRoot}.`
  for (const branch of tree.branches) await git(tree.root, ['branch', '-D', branch])
  return null
}
