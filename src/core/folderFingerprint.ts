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

export async function folderFingerprint(git: GitOut, dir: string): Promise<string | null> {
  const [toTop, head, refs, status] = await Promise.all([
    git(dir, ['rev-parse', '--show-cdup']),
    git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    git(dir, [
      'for-each-ref',
      '--format=%(objectname) %(refname)',
      'refs/heads',
      'refs/tags',
      'refs/stash'
    ]),
    git(dir, [
      '--no-optional-locks',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules'
    ])
  ])
  if (toTop === null || refs === null || status === null) return null
  const top = toTop.trim()
  const present = entriesOf(status)
    .filter(hasContentToHash)
    .map((e) => `${top}${e.path}`)
  const contents = await contentHashes(git, dir, present)
  return createHash('sha256')
    .update([head ?? NO_COMMIT_YET, refs, status, contents].join('\0'))
    .digest('hex')
}
