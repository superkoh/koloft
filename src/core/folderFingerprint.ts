import { createHash } from 'node:crypto'
import { mapAtMost } from './mapAtMost'
import type { GitOut } from './worktree'

const PATHS_HASHED_PER_CALL = 100
const GIT_CALLS_AT_ONCE_UNDER_SSHS_CHANNEL_LIMIT = 4
const NO_COMMIT_YET = ''
const CANNOT_HASH = '-\n'

interface Entry {
  code: string
  path: string
}

function entriesOf(status: string): Entry[] {
  const fields = status.split('\0').filter(Boolean)
  const entries: Entry[] = []
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i].slice(0, 2)
    entries.push({ code, path: fields[i].slice(3) })
    if (/[RC]/.test(code)) i++
  }
  return entries
}

const conflictKeepsTheFile = (code: string): boolean => code.includes('U') && code !== 'DD'

const hasContentToHash = (e: Entry): boolean =>
  !e.path.endsWith('/') && (conflictKeepsTheFile(e.code) || !e.code.includes('D'))

const hashOf = (git: GitOut, dir: string, paths: string[]): Promise<string | null> =>
  git(dir, ['hash-object', '--no-filters', '--', ...paths])

async function contentHashes(git: GitOut, dir: string, paths: string[]): Promise<string> {
  const batches: string[][] = []
  for (let at = 0; at < paths.length; at += PATHS_HASHED_PER_CALL)
    batches.push(paths.slice(at, at + PATHS_HASHED_PER_CALL))
  const hashed = await mapAtMost(
    batches,
    GIT_CALLS_AT_ONCE_UNDER_SSHS_CHANNEL_LIMIT,
    async (batch) => {
      const all = await hashOf(git, dir, batch)
      if (all !== null) return all
      const each = await mapAtMost(batch, 1, (p) => hashOf(git, dir, [p]))
      return each.map((h) => h ?? CANNOT_HASH).join('')
    }
  )
  return hashed.join('')
}

const READS: readonly (readonly string[])[] = [
  ['rev-parse', '--show-cdup'],
  ['rev-parse', '--verify', '--quiet', 'HEAD'],
  ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags'],
  ['stash', 'list', '--format=%H'],
  [
    '--no-optional-locks',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules'
  ],
  ['--no-optional-locks', 'diff', '--cached', '--raw', '-z', '--no-abbrev', '--ignore-submodules'],
  ['--no-optional-locks', 'diff', '--raw', '-z', '--no-abbrev', '--ignore-submodules']
]

export async function folderFingerprint(git: GitOut, dir: string): Promise<string | null> {
  const [toTop, head, refs, stashes, status, staged, modes] = await mapAtMost(
    [...READS],
    GIT_CALLS_AT_ONCE_UNDER_SSHS_CHANNEL_LIMIT,
    (args) => git(dir, [...args])
  )
  const read = [toTop, refs, stashes, status, staged, modes]
  if (read.some((out) => out === null)) return null
  if (head === null && refs!.includes('refs/heads/')) return null
  const top = toTop!.trim()
  const present = entriesOf(status!)
    .filter(hasContentToHash)
    .map((e) => `${top}${e.path}`)
  const contents = await contentHashes(git, dir, present)
  return createHash('sha256')
    .update([head ?? NO_COMMIT_YET, ...read.slice(1), contents].join('\0'))
    .digest('hex')
}
