import { isValidWorktreeName } from '@shared/worktreeName'
import { isValidModelName } from '@shared/cronNames'
import { isCronEffort, type CronEffort, type CronPermission } from '@shared/types'

// The launch line every claude pty gets — new tabs and cold-row resumes alike. It is
// pure so it can be tested at all (index.ts cannot be loaded outside Electron), and
// it exists because D11 turned an unusable flag into a refusal: an illegal `-w` name
// used to be dropped, which started the session in the repo root instead of the
// isolated worktree the caller asked for.

export type ClaudeArgvResult = { ok: true; argv: string[] } | { ok: false; code: 'invalid-args' }

/** claude's own session ids; the value comes off a persisted transcript and lands in
 *  a shell command line, so anything but a plain token is refused. */
const SESSION_ID_RE = /^[a-zA-Z0-9-]+$/

// §4.7: a scheduled job's model comes off cron.json, which a person may have
// hand-edited, and every token here is joined with spaces into a line typed into a
// login shell — so the same refusal rule as the worktree name applies. The rule
// itself is `isValidModelName`, shared with the form, the save and the loader, so a
// model can never pass one of them and fail here. The aliases `fable`, `opus` and
// `sonnet` are what `claude --model` itself accepts (2.1.258).

export function claudeArgv(
  base: string,
  opts: {
    resumeSessionId?: string
    /** the id a NEW session is told to use — the remote launch mints it here because
     *  there is no shim on the machine to read it back out of (index.ts) */
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
