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

function commitsOnlyOn(git: GitOut, dir: string, tips: string[], branches: string[]) {
  return git(dir, [
    'log',
    '--oneline',
    `--max-count=${MOST_COMMITS_LISTED}`,
    ...tips,
    '--not',
    ...branches.map((b) => `--exclude=${b}`),
    '--branches',
    '--remotes'
  ])
}

function commitsLeft(dir: string, onlyHere: string | null): string[] {
  if (onlyHere === null) return [`git could not list the commits in ${dir}.`]
  return onlyHere.trim()
    ? [`Commits on no other branch and no remote branch:\n${onlyHere.trimEnd()}`]
    : []
}

export async function whatIsLeft(git: GitOut, tree: ClosingTree): Promise<string[]> {
  const [status, onlyHere] = await Promise.all([
    git(tree.treeRoot, ['status', '--porcelain=v1', '--untracked-files=all']),
    commitsOnlyOn(git, tree.treeRoot, ['HEAD', ...tree.branches], tree.branches)
  ])
  if (status === null) return [`git could not read ${tree.treeRoot}.`]
  const left: string[] = []
  if (status.trim()) left.push(`Changes not committed:\n${status.trimEnd()}`)
  return [...left, ...commitsLeft(tree.treeRoot, onlyHere)]
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
  await deleteBranches(git, tree.root, tree.branches)
  return null
}

async function deleteBranches(git: GitOut, root: string, branches: string[]): Promise<boolean> {
  let deleted = false
  for (const branch of branches)
    if ((await git(root, ['branch', '-D', branch])) !== null) deleted = true
  return deleted
}

const MACHINE_UNREACHABLE = 'machine unreachable'

export interface TidyResult {
  removed: boolean
  kept: string[]
  unreachable?: true
}

export function machineUnreachable(why?: string): TidyResult {
  const kept = why ? `${MACHINE_UNREACHABLE}: ${why}` : MACHINE_UNREACHABLE
  return { removed: false, kept: [kept], unreachable: true }
}

const NOTHING_THERE: TidyResult = { removed: false, kept: [] }
const REMOVED: TidyResult = { removed: true, kept: [] }

export async function tidyTree(
  git: GitOut,
  info: ProjectInfo,
  dirExists: (dir: string) => Promise<boolean>
): Promise<TidyResult> {
  let there: boolean
  try {
    there = await dirExists(info.treeRoot)
  } catch (error) {
    return machineUnreachable((error as Error).message)
  }
  const tree = await closingTree(git, info)
  if (!tree) return NOTHING_THERE
  if (!there) {
    if (!tree.branches.length) return NOTHING_THERE
    const kept = commitsLeft(
      tree.root,
      await commitsOnlyOn(git, tree.root, tree.branches, tree.branches)
    )
    if (kept.length) return { removed: false, kept }
    return (await deleteBranches(git, tree.root, tree.branches))
      ? REMOVED
      : { removed: false, kept: [`git could not delete ${tree.branches.join(', ')}.`] }
  }
  const left = await whatIsLeft(git, tree)
  const problem = left.length ? null : await removeTree(git, tree)
  const kept = problem ? [problem] : left
  if (!kept.length) return REMOVED
  const anotherRemoverWon =
    kept.some((k) => k.startsWith('git could not')) &&
    !(await dirExists(info.treeRoot).catch(() => true))
  return anotherRemoverWon ? REMOVED : { removed: false, kept }
}
