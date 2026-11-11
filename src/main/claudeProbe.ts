import { agentsInLoginShell, forgetAgentsInLoginShell, LoginShellError } from './loginShell'

const REASK_AFTER_UNSURE_OR_NO_MS = 60_000

let answer: Promise<{ found: boolean }> | undefined

// PLATFORM§1
export function probeClaude(env: NodeJS.ProcessEnv = process.env): Promise<{ found: boolean }> {
  if (env.KOLOFT_TEST_CLAUDE_PROBE === 'missing') return Promise.resolve({ found: false })
  answer ??= agentsInLoginShell(env)
    .then(
      ({ commandV }) => ({ found: !!commandV.claude, sure: true }),
      (e) => ({ found: !(e instanceof LoginShellError && e.reason === 'exited'), sure: false })
    )
    .then(({ found, sure }) => {
      if (!found || !sure)
        setTimeout(() => (answer = undefined), REASK_AFTER_UNSURE_OR_NO_MS).unref()
      return { found }
    })
  return answer
}

export function forgetClaudeProbe(): void {
  answer = undefined
  forgetAgentsInLoginShell()
}
