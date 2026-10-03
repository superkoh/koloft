import path from 'path'
import type { ProjectInfo } from '@shared/types'

export type GitOut = (cwd: string, args: string[]) => Promise<string | null>

export interface ClosingTree {
  root: string
  dir: string
  branches: string[]
}

const MOST_COMMITS_LISTED = 20

export async function closingTree(git: GitOut, info: ProjectInfo): Promise<ClosingTree | null> {
  if (!info.worktreeName) return null
  const head = (await git(info.treeRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim()
  const named = `worktree-${path.basename(info.treeRoot)}`
  const namedExists =
    (await git(info.root, ['show-ref', '--verify', '--quiet', `refs/heads/${named}`])) !== null
  const branches = new Set<string>()
  if (head) branches.add(head)
  if (namedExists) branches.add(named)
  return { root: info.root, dir: info.treeRoot, branches: [...branches] }
}

export async function whatIsLeft(git: GitOut, tree: ClosingTree): Promise<string[]> {
  const status = await git(tree.dir, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status === null) return [`git could not read ${tree.dir}.`]
  const left: string[] = []
  if (status.trim()) left.push(`Changes not committed:\n${status.trimEnd()}`)
  const unpushed = await git(tree.dir, [
    'log',
    '--oneline',
    `--max-count=${MOST_COMMITS_LISTED}`,
    'HEAD',
    ...tree.branches,
    '--not',
    '--remotes'
  ])
  if (unpushed === null) return [...left, `git could not list the commits in ${tree.dir}.`]
  if (unpushed.trim()) left.push(`Commits on no remote branch:\n${unpushed.trimEnd()}`)
  return left
}

// PLATFORM§30
export async function removeTree(git: GitOut, tree: ClosingTree): Promise<string | null> {
  await git(tree.root, ['worktree', 'unlock', tree.dir])
  if ((await git(tree.root, ['worktree', 'remove', tree.dir])) === null)
    return `git could not remove the worktree ${tree.dir}.`
  for (const branch of tree.branches) await git(tree.root, ['branch', '-D', branch])
  return null
}
