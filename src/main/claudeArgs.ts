import { isValidWorktreeName } from '@shared/worktreeName'
import { isValidModelName } from '@shared/cronNames'
import { isCronEffort, type CronEffort, type CronPermission } from '@shared/types'

export type ClaudeArgvResult = { ok: true; argv: string[] } | { ok: false; code: 'invalid-args' }

const SESSION_ID_RE = /^[a-zA-Z0-9-]+$/

// CC§9
export function claudeArgv(
  base: string,
  opts: {
    resumeSessionId?: string
    sessionId?: string
    worktree?: string
    model?: string
    effort?: CronEffort
    permission?: CronPermission
  }
): ClaudeArgvResult {
  const { resumeSessionId: sid, sessionId: newSid, worktree: wt, model, effort, permission } = opts
  if (sid !== undefined && !SESSION_ID_RE.test(sid)) return { ok: false, code: 'invalid-args' }
  if (newSid !== undefined && !SESSION_ID_RE.test(newSid))
    return { ok: false, code: 'invalid-args' }
  if (wt !== undefined && !isValidWorktreeName(wt)) return { ok: false, code: 'invalid-args' }
  if (model !== undefined && !isValidModelName(model)) return { ok: false, code: 'invalid-args' }
  if (effort !== undefined && !isCronEffort(effort)) return { ok: false, code: 'invalid-args' }
  const perm: string[] = []
  if (permission === 'acceptEdits') perm.push('--permission-mode', 'acceptEdits')
  else if (permission === 'skipAll') perm.push('--dangerously-skip-permissions')
  else if (permission !== undefined && permission !== 'same')
    return { ok: false, code: 'invalid-args' }
  return {
    ok: true,
    argv: [
      base,
      ...(sid ? ['--resume', sid] : []),
      ...(newSid ? ['--session-id', newSid] : []),
      ...(wt ? ['-w', wt] : []),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
      ...perm
    ]
  }
}
