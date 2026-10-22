import { execFile } from 'node:child_process'
import os from 'node:os'
import type { AssistSetting, BackendId } from '@shared/types'
import { backendsFrom } from '@shared/sessionBackend'
import { lastCompletedText } from './museSessionLog'
import { envMs } from './sessionRuntime'

export interface AssistJob {
  system: string
  prompt: string
  signal?: AbortSignal
}

export type Assist = (job: AssistJob) => Promise<string | null>

const ASSIST_TIMEOUT_MS = envMs('KOLOFT_ASSIST_TIMEOUT_MS', 15_000)

// CC§9
const CLAUDE_ONE_SHOT = (system: string): string[] => [
  '-p',
  '--model',
  'haiku',
  '--no-session-persistence',
  '--setting-sources',
  '',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--system-prompt',
  system,
  '--tools',
  ''
]

// CODEX§15
const CODEX_ONE_SHOT = [
  'exec',
  '--skip-git-repo-check',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '-s',
  'read-only',
  '-m',
  'gpt-6-luna',
  '-C',
  os.tmpdir(),
  '-'
]

// MUSE§1
const MUSE_ONE_SHOT = (task: string): string[] => [
  'exec',
  '--json',
  '--no-session-log',
  '--disable-reminders',
  task
]

// AGY§20
const AGY_ONE_SHOT = (task: string): string[] => ['-p', task, '--output-format', 'json']

// AGY§20
function agyResponse(out: string): string | null {
  try {
    const result = JSON.parse(out) as { status?: unknown; response?: unknown }
    return result.status === 'SUCCESS' && typeof result.response === 'string'
      ? result.response
      : null
  } catch {
    return null
  }
}

const withSystemFirst = (job: AssistJob): string => `${job.system}\n\n${job.prompt}`

const ONE_SHOT: Record<
  BackendId,
  {
    argv(job: AssistJob): string[]
    stdin(job: AssistJob): string
    answer(out: string): string | null
    secondTryWhenLate?: true
  }
> = {
  claude: {
    argv: (job) => CLAUDE_ONE_SHOT(job.system),
    stdin: (job) => job.prompt,
    answer: (out) => out
  },
  // CODEX§15
  codex: {
    argv: () => CODEX_ONE_SHOT,
    stdin: withSystemFirst,
    answer: (out) => out,
    secondTryWhenLate: true
  },
  muse: {
    argv: (job) => MUSE_ONE_SHOT(withSystemFirst(job)),
    stdin: () => '',
    answer: lastCompletedText
  },
  agy: {
    argv: (job) => AGY_ONE_SHOT(withSystemFirst(job)),
    stdin: () => '',
    answer: agyResponse
  }
}

export interface AssistTarget {
  binary: string
  env: NodeJS.ProcessEnv
  args?: string[]
  done?(): void
}

export interface AssistDeps {
  setting(): AssistSetting
  enabled(backend: BackendId): boolean
  target(backend: BackendId): Promise<AssistTarget | null>
}

type OneRun = (signal: AbortSignal | undefined, timeoutMs: number) => Promise<string | null>

function runOnce(
  target: AssistTarget,
  argv: string[],
  input: string,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      target.binary,
      argv,
      { env: target.env, cwd: os.tmpdir(), timeout: timeoutMs, signal },
      (err, stdout, stderr) => {
        if (err && !signal?.aborted) {
          console.error(
            '[koloft] Assist one-shot failed:',
            target.binary,
            err.code ?? err.signal,
            stderr.slice(-2000)
          )
        }
        resolve(err ? null : stdout)
      }
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}

const STILL_RUNNING = Symbol('still running')

async function withASecondTryWhenLate(
  run: OneRun,
  signal: AbortSignal | undefined
): Promise<string | null> {
  const both = new AbortController()
  const stopBoth = (): void => both.abort()
  signal?.addEventListener('abort', stopBoth, { once: true })
  let timer: NodeJS.Timeout | undefined
  try {
    const first = run(both.signal, 2 * ASSIST_TIMEOUT_MS)
    const late = new Promise<typeof STILL_RUNNING>((resolve) => {
      timer = setTimeout(() => resolve(STILL_RUNNING), ASSIST_TIMEOUT_MS)
    })
    const early = await Promise.race([first, late])
    if (early !== STILL_RUNNING) return early
    const answered = (out: Promise<string | null>): Promise<string> =>
      out.then((text) => text ?? Promise.reject(new Error('no answer')))
    return await Promise.any([
      answered(first),
      answered(run(both.signal, ASSIST_TIMEOUT_MS))
    ]).catch(() => null)
  } finally {
    clearTimeout(timer)
    both.abort()
    signal?.removeEventListener('abort', stopBoth)
  }
}

export function koloftAssist(deps: AssistDeps): Assist {
  return async (job) => {
    const setting = deps.setting()
    if (!setting?.on) return null
    for (const backend of backendsFrom(setting.backend)) {
      if (!deps.enabled(backend)) continue
      const target = await deps.target(backend)
      if (job.signal?.aborted) return null
      if (!target) continue
      const shot = ONE_SHOT[backend]
      const argv = [...(target.args ?? []), ...shot.argv(job)]
      const run: OneRun = (signal, timeoutMs) =>
        runOnce(target, argv, shot.stdin(job), signal, timeoutMs)
      const out = await (
        shot.secondTryWhenLate
          ? withASecondTryWhenLate(run, job.signal)
          : run(job.signal, ASSIST_TIMEOUT_MS)
      ).finally(() => target.done?.())
      return out === null ? null : shot.answer(out)
    }
    return null
  }
}
