import type { GitStepResult, PrWorktreeResult } from '@shared/types'
import { pullErrorReason } from './gitFreshness'

export interface GitRunResult {
  code: number | null
  stdout: string
  stderr: string
}

export type GitRun = (args: string[], network?: boolean) => Promise<GitRunResult>

export const GIT_STEP_TIMEOUT_MS = 60_000

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

export async function pushBranch(run: GitRun): Promise<GitStepResult> {
  const r = await run(['push', '-u', 'origin', 'HEAD'], true)
  return r.code === 0 ? { ok: true } : refused(r, 'push')
}
