import { execFile } from 'child_process'
import { userShell } from './userShell'

const REASK_AFTER_UNSURE_OR_NO_MS = 60_000

let answer: Promise<{ found: boolean }> | undefined

// PLATFORM§1
export function probeClaude(env: NodeJS.ProcessEnv = process.env): Promise<{ found: boolean }> {
  if (env.KOLOFT_TEST_CLAUDE_PROBE === 'missing') return Promise.resolve({ found: false })
  answer ??= new Promise((resolve) => {
    const { shell, args } = userShell(env)
    execFile(shell, [...args, '-c', 'command -v claude'], { env, timeout: 8000 }, (err) => {
      const missing = !!err && typeof err.code === 'number'
      if (err) setTimeout(() => (answer = undefined), REASK_AFTER_UNSURE_OR_NO_MS).unref()
      resolve({ found: !missing })
    })
  })
  return answer
}
