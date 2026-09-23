import { execFile } from 'child_process'
import { userShell } from './userShell'

/** A "no" is trusted for a minute — long enough that opening a dialog never pays for a
 *  login shell, short enough to notice a fresh install (codexSessions.availability's rule);
 *  a "yes" is kept for good. */
const FAILURE_MS = 60_000

let answer: Promise<{ found: boolean }> | undefined

/**
 * is there a `claude` to run at all? Asked of the user's shell (the one a session
 * runs in), not of this process: a Finder-launched packaged app inherits launchd's
 * minimal PATH. The exit code is the answer; stdout also carries whatever the profile
 * prints.
 */
export function probeClaude(env: NodeJS.ProcessEnv = process.env): Promise<{ found: boolean }> {
  // test-only seam: the e2e suite needs the "no claude installed" branch without
  // touching PATH, which the fixture's own fake-claude depends on. Env-gated, so a
  // packaged run never reads anything but the real shell.
  if (env.KOLOFT_TEST_CLAUDE_PROBE === 'missing') return Promise.resolve({ found: false })
  answer ??= new Promise((resolve) => {
    const { shell, args } = userShell(env)
    execFile(shell, [...args, '-c', 'command -v claude'], { env, timeout: 8000 }, (err) => {
      // only the shell's own "no" (a numeric exit) is an answer. A timeout (a profile
      // that waits on a terminal) or a shell that failed to start says nothing about
      // claude, and a session may still work — so that is a yes, re-asked later.
      const missing = !!err && typeof err.code === 'number'
      if (err) setTimeout(() => (answer = undefined), FAILURE_MS).unref()
      resolve({ found: !missing })
    })
  })
  return answer
}
