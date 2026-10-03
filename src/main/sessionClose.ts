import path from 'path'
import type { ProjectInfo } from '@shared/types'
import { gitProbes, type GitOut } from './resumePlan'

export type ClosingTree = ProjectInfo & { branches: string[] }

const MOST_COMMITS_LISTED = 20

export async function closingTree(git: GitOut, info: ProjectInfo): Promise<ClosingTree | null> {
  if (!info.worktreeName) return null
  const head = (await git(info.treeRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim()
  const named = `worktree-${path.basename(info.treeRoot)}`
  const branches = new Set<string>()
  if (head) branches.add(head)
  if (await gitProbes(git).branchExists(info.root, named)) branches.add(named)
  return { ...info, branches: [...branches] }
}

export async function whatIsLeft(git: GitOut, tree: ClosingTree): Promise<string[]> {
  const status = await git(tree.treeRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status === null) return [`git could not read ${tree.treeRoot}.`]
  const left: string[] = []
  if (status.trim()) left.push(`Changes not committed:\n${status.trimEnd()}`)
  const unpushed = await git(tree.treeRoot, [
    'log',
    '--oneline',
    `--max-count=${MOST_COMMITS_LISTED}`,
    'HEAD',
    ...tree.branches,
    '--not',
    '--remotes'
  ])
  if (unpushed === null) return [...left, `git could not list the commits in ${tree.treeRoot}.`]
  if (unpushed.trim()) left.push(`Commits on no remote branch:\n${unpushed.trimEnd()}`)
  return left
}

// PLATFORM§30
export async function removeTree(git: GitOut, tree: ClosingTree): Promise<string | null> {
  await git(tree.root, ['worktree', 'unlock', tree.treeRoot])
  if ((await git(tree.root, ['worktree', 'remove', tree.treeRoot])) === null)
    return `git could not remove the worktree ${tree.treeRoot}.`
  for (const branch of tree.branches) await git(tree.root, ['branch', '-D', branch])
  return null
}
