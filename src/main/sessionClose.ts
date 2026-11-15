import path from 'path'
import { barePath, parseRemoteKey } from '@shared/remoteKey'
import { shq } from '@shared/shellQuote'
import type { ProjectInfo } from '@shared/types'
import { gitProbes, type GitOut } from './resumePlan'

export type ClosingTree = ProjectInfo & { branches: string[]; gitFileGone?: true }

const MOST_COMMITS_LISTED = 20
const DELETING_HUNDREDS_OF_THOUSANDS_OF_IGNORED_FILES_MS = 10 * 60_000

// PLATFORM§30
async function headOfItsOwn(
  git: GitOut,
  info: ProjectInfo
): Promise<{ head: string | null; gitFileGone?: true }> {
  const insideAnotherCheckout = async () =>
    !!(await git(info.treeRoot, ['rev-parse', '--show-prefix']))?.trim()
  const headOf = () => git(info.treeRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const [inside, head] = await Promise.all([insideAnotherCheckout(), headOf()])
  if (!inside) return { head }
  await git(info.root, ['worktree', 'repair', barePath(info.treeRoot)])
  if (await insideAnotherCheckout()) return { head: null, gitFileGone: true }
  return { head: await headOf() }
}

export async function closingTree(git: GitOut, info: ProjectInfo): Promise<ClosingTree | null> {
  if (!info.worktreeName) return null
  const named = `worktree-${path.basename(info.treeRoot)}`
  const [{ head, gitFileGone }, hasNamed] = await Promise.all([
    headOfItsOwn(git, info),
    gitProbes(git).branchExists(info.root, named)
  ])
  const branches = new Set<string>()
  if (head?.trim()) branches.add(head.trim())
  if (hasNamed) branches.add(named)
  return { ...info, branches: [...branches], ...(gitFileGone && { gitFileGone }) }
}

export type MergedHeads = (dir: string, branch: string) => Promise<string[] | null>

function commitsOnlyOn(
  git: GitOut,
  dir: string,
  tips: string[],
  branches: string[],
  heldElsewhere: string[] = []
) {
  return git(dir, [
    'log',
    '--oneline',
    ...(heldElsewhere.length ? ['--ignore-missing'] : []),
    `--max-count=${MOST_COMMITS_LISTED}`,
    ...tips,
    '--not',
    ...branches.map((b) => `--exclude=${b}`),
    '--branches',
    '--remotes',
    ...heldElsewhere
  ])
}

export const GITHUB_NOT_ASKED =
  'Koloft could not ask GitHub whether a merged pull request holds them. If one does, nothing is lost, and pushing would only bring back the branch GitHub deleted.'

function commitsLeft(dir: string, onlyHere: string | null, githubNotAsked = false): string[] {
  if (onlyHere === null) return [`git could not list the commits in ${dir}.`]
  if (!onlyHere.trim()) return []
  const commits = `Commits on no other branch and no remote branch:\n${onlyHere.trimEnd()}`
  return [githubNotAsked ? `${commits}\n${GITHUB_NOT_ASKED}` : commits]
}

// PLATFORM§30 PLATFORM§32
async function commitsNotHeld(
  git: GitOut,
  dir: string,
  tips: string[],
  branches: string[],
  merged?: MergedHeads
): Promise<string[]> {
  const onlyHere = await commitsOnlyOn(git, dir, tips, branches)
  if (!onlyHere?.trim() || !merged || !branches.length) return commitsLeft(dir, onlyHere)
  const heads = await Promise.all(branches.map((b) => merged(dir, b)))
  const held = heads.flatMap((h) => h ?? [])
  const rest = held.length ? await commitsOnlyOn(git, dir, tips, branches, held) : onlyHere
  return commitsLeft(dir, rest, heads.includes(null))
}

const DELETED_FROM_THE_FOLDER_ONLY = ' D '

async function whatIsLeftIn(
  git: GitOut,
  tree: ClosingTree,
  merged: MergedHeads | undefined,
  deletedFilesLoseNothing: boolean
): Promise<{ left: string[]; onlyDeletedFiles: boolean }> {
  if (tree.gitFileGone)
    return {
      left: [`git could not read ${tree.treeRoot}: its .git file is gone.`],
      onlyDeletedFiles: false
    }
  const [status, commits] = await Promise.all([
    git(tree.treeRoot, ['status', '--porcelain=v1', '--untracked-files=all']),
    commitsNotHeld(git, tree.treeRoot, ['HEAD', ...tree.branches], tree.branches, merged)
  ])
  if (status === null)
    return { left: [`git could not read ${tree.treeRoot}.`], onlyDeletedFiles: false }
  const changes = status.split('\n').filter(Boolean)
  const onlyDeletedFiles =
    changes.length > 0 && changes.every((l) => l.startsWith(DELETED_FROM_THE_FOLDER_ONLY))
  const lost = changes.length > 0 && !(deletedFilesLoseNothing && onlyDeletedFiles)
  return {
    left: [...(lost ? [`Changes not committed:\n${status.trimEnd()}`] : []), ...commits],
    onlyDeletedFiles
  }
}

export async function whatIsLeft(
  git: GitOut,
  tree: ClosingTree,
  merged?: MergedHeads
): Promise<string[]> {
  return (await whatIsLeftIn(git, tree, merged, false)).left
}

// PLATFORM§30
export async function removeTree(
  git: GitOut,
  tree: ClosingTree,
  force = false
): Promise<string | null> {
  const onItsHost = barePath(tree.treeRoot)
  await git(tree.root, ['worktree', 'unlock', onItsHost])
  let gitSaid = ''
  const removed = await git(
    tree.root,
    ['worktree', 'remove', ...(force ? ['--force'] : []), onItsHost],
    DELETING_HUNDREDS_OF_THOUSANDS_OF_IGNORED_FILES_MS,
    (stderr) => (gitSaid = stderr.trim())
  )
  if (removed === null) return couldNotRemove(tree, onItsHost, gitSaid)
  await deleteBranches(git, tree.root, tree.branches)
  return null
}

const GIT_LET_GO_OF_THE_TREE_BUT_LEFT_FILES = 'failed to delete'

// PLATFORM§30
function couldNotRemove(tree: ClosingTree, onItsHost: string, gitSaid: string): string {
  const said = `git could not remove the worktree ${tree.treeRoot}${gitSaid ? `:\n${gitSaid}` : '.'}`
  if (!gitSaid.includes(GIT_LET_GO_OF_THE_TREE_BUT_LEFT_FILES)) return said
  const host = parseRemoteKey(tree.treeRoot)?.host
  const branches = tree.branches.length
    ? ` && git -C ${shq(barePath(tree.root))} branch -D ${tree.branches.map(shq).join(' ')}`
    : ''
  return `${said}\nTo finish by hand, run${host ? ` on ${host}` : ''}: chmod -R u+w ${shq(onItsHost)} && rm -rf ${shq(onItsHost)}${branches}`
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
  dirExists: (dir: string) => Promise<boolean>,
  merged?: MergedHeads
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
    const kept = await commitsNotHeld(git, tree.root, tree.branches, tree.branches, merged)
    if (kept.length) return { removed: false, kept }
    return (await deleteBranches(git, tree.root, tree.branches))
      ? REMOVED
      : { removed: false, kept: [`git could not delete ${tree.branches.join(', ')}.`] }
  }
  const { left, onlyDeletedFiles } = await whatIsLeftIn(git, tree, merged, true)
  const problem = left.length ? null : await removeTree(git, tree, onlyDeletedFiles)
  const kept = problem ? [problem] : left
  if (!kept.length) return REMOVED
  const anotherRemoverWon =
    kept.some((k) => k.startsWith('git could not')) &&
    !(await dirExists(info.treeRoot).catch(() => true))
  return anotherRemoverWon ? REMOVED : { removed: false, kept }
}
