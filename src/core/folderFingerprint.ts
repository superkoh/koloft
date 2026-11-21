import { createHash } from 'node:crypto'
import type { GitOut } from './worktree'

const PATHS_HASHED_PER_CALL = 100

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

const stillInTheFolder = (e: Entry): boolean => !e.code.includes('D')

async function contentHashes(git: GitOut, dir: string, paths: string[]): Promise<string | null> {
  const hashes: string[] = []
  for (let at = 0; at < paths.length; at += PATHS_HASHED_PER_CALL) {
    const out = await git(dir, [
      'hash-object',
      '--',
      ...paths.slice(at, at + PATHS_HASHED_PER_CALL)
    ])
    if (out === null) return null
    hashes.push(out)
  }
  return hashes.join('')
}

export async function folderFingerprint(git: GitOut, dir: string): Promise<string | null> {
  const [toTop, head, refs, status] = await Promise.all([
    git(dir, ['rev-parse', '--show-cdup']),
    git(dir, ['rev-parse', '--verify', 'HEAD']),
    git(dir, [
      'for-each-ref',
      '--format=%(objectname) %(refname)',
      'refs/heads',
      'refs/tags',
      'refs/stash'
    ]),
    git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules'])
  ])
  if (toTop === null || head === null || refs === null || status === null) return null
  const top = toTop.trim()
  const present = entriesOf(status)
    .filter(stillInTheFolder)
    .map((e) => `${top}${e.path}`)
  const contents = await contentHashes(git, dir, present)
  if (contents === null) return null
  return createHash('sha256').update([head, refs, status, contents].join('\0')).digest('hex')
}
