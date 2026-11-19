import type { GitHead, GitReadiness, GitStepResult, PrWorktreeResult } from '@shared/types'
import { pullErrorReason } from './gitFreshness'

export interface GitRunResult {
  code: number | null
  stdout: string
  stderr: string
}

export type GitRun = (args: string[], network?: boolean) => Promise<GitRunResult>

export const GIT_STEP_TIMEOUT_MS = 60_000

export const GIT_REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,120}$/

function refused(r: GitRunResult, what: string): { ok: false; reason: string } {
  return {
    ok: false,
    reason:
      r.code === null ? `${what} timed out` : pullErrorReason(r.stderr, r.stdout, `${what} failed`)
  }
}

export async function commitAll(run: GitRun, message: string): Promise<GitStepResult> {
  const text = message.trim()
  if (!text) return { ok: false, reason: 'Write a commit message first.' }
  const added = await run(['add', '-A'])
  if (added.code !== 0) return refused(added, 'commit')
  const made = await run(['commit', '-q', '-m', text])
  return made.code === 0 ? { ok: true } : refused(made, 'commit')
}

// CC§3 PLATFORM§32
export async function addPrWorktree(
  run: GitRun,
  pr: number,
  branch: string
): Promise<PrWorktreeResult> {
  const top = await run(['rev-parse', '--show-toplevel'])
  if (top.code !== 0) return refused(top, 'worktree add')
  const dir = `${top.stdout.trim()}/.claude/worktrees/pr-${pr}`
  const local = await run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
  if (local.code !== 0) {
    const fetched = await run(['fetch', 'origin', `pull/${pr}/head:${branch}`], true)
    if (fetched.code !== 0) return refused(fetched, 'fetch')
  }
  const added = await run(['worktree', 'add', dir, branch])
  return added.code === 0 ? { ok: true, dir } : refused(added, 'worktree add')
}

const PUSH_REMOTE = 'origin'

export async function pushBranch(run: GitRun): Promise<GitStepResult> {
  const r = await run(['push', '-u', PUSH_REMOTE, 'HEAD'], true)
  return r.code === 0 ? { ok: true } : refused(r, 'push')
}

const HEAD_IS_NOT_A_BRANCH = 1

export async function readHead(run: GitRun): Promise<GitHead | null> {
  const r = await run(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (r.code === 0) return { branch: r.stdout.trim() }
  return r.code === HEAD_IS_NOT_A_BRANCH ? { detached: true } : null
}

const BRANCH_HEAD_LINE = '# branch.head '
const DETACHED_IN_STATUS = '(detached)'

export async function readReadiness(run: GitRun): Promise<GitReadiness | null> {
  const [status, origin] = await Promise.all([
    run(['status', '--porcelain=v2', '--branch']),
    run(['config', '--get', `remote.${PUSH_REMOTE}.url`])
  ])
  if (status.code !== 0) return null
  const lines = status.stdout.split('\n').filter((l) => l !== '')
  const name = lines.find((l) => l.startsWith(BRANCH_HEAD_LINE))?.slice(BRANCH_HEAD_LINE.length)
  if (!name) return null
  return {
    head: name === DETACHED_IN_STATUS ? { detached: true } : { branch: name },
    commitable: lines.some((l) => !l.startsWith('# ')),
    hasPushRemote: origin.code === 0
  }
}
