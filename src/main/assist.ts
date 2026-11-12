import { execFile } from 'node:child_process'
import os from 'node:os'
import type { AssistJobId, BackendId } from '@shared/types'
import {
  assistBackendsFor,
  assistLaunchOn,
  EVERY_ACCOUNT_TAKES,
  type ModelAndEffort
} from '@shared/assistPicks'
import { lastCompletedText } from './museSessionLog'
import { envMs } from './sessionRuntime'

export interface AssistJob {
  row: AssistJobId
  system: string
  prompt: string
  signal?: AbortSignal
}

export type Assist = (job: AssistJob) => Promise<string | null>

const ASSIST_TIMEOUT_MS = envMs('KOLOFT_ASSIST_TIMEOUT_MS', 15_000)
export const ASSIST_ANSWERS_WITHIN_MS = 2 * ASSIST_TIMEOUT_MS

// CC§9
const CLAUDE_ONE_SHOT = (system: string, launch: ModelAndEffort): string[] => [
  '-p',
  ...(launch.model ? ['--model', launch.model] : []),
  ...(launch.effort ? ['--effort', launch.effort] : []),
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
const CODEX_ONE_SHOT = (launch: ModelAndEffort): string[] => [
  'exec',
  '--skip-git-repo-check',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '-s',
  'read-only',
  ...(launch.model ? ['-m', launch.model] : []),
  ...(launch.effort ? ['-c', `model_reasoning_effort="${launch.effort}"`] : []),
  '-C',
  os.tmpdir(),
  '-'
]

// MUSE§1
const MUSE_ONE_SHOT = (task: string, launch: ModelAndEffort): string[] => [
  'exec',
  '--json',
  '--no-session-log',
  '--disable-reminders',
  ...(launch.model ? ['--model', launch.model] : []),
  ...(launch.effort ? ['--reasoning-effort', launch.effort] : []),
  task
]

// AGY§20 AGY§21
const AGY_ONE_SHOT = (task: string, launch: ModelAndEffort): string[] => [
  '-p',
  task,
  '--output-format',
  'json',
  ...(launch.model ? ['--model', launch.model] : []),
  ...(launch.effort ? ['--effort', launch.effort] : [])
]

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
    argv(job: AssistJob, launch: ModelAndEffort): string[]
    stdin(job: AssistJob): string
    answer(out: string): string | null
    secondTryWhenLate?: true
    saysItHasNoSuchModel?: RegExp
  }
> = {
  // CC§9
  claude: {
    argv: (job, launch) => CLAUDE_ONE_SHOT(job.system, launch),
    stdin: (job) => job.prompt,
    answer: (out) => out,
    saysItHasNoSuchModel: /issue with the selected model/
  },
  // CODEX§15
  codex: {
    argv: (_job, launch) => CODEX_ONE_SHOT(launch),
    stdin: withSystemFirst,
    answer: (out) => out,
    secondTryWhenLate: true,
    saysItHasNoSuchModel: /model is not supported/
  },
  muse: {
    argv: (job, launch) => MUSE_ONE_SHOT(withSystemFirst(job), launch),
    stdin: () => '',
    answer: lastCompletedText
  },
  agy: {
    argv: (job, launch) => AGY_ONE_SHOT(withSystemFirst(job), launch),
    stdin: () => '',
    answer: agyResponse,
    // AGY§21
    saysItHasNoSuchModel: /invalid model selection/
  }
}

export interface AssistTarget {
  binary: string
  env: NodeJS.ProcessEnv
  args?: string[]
  done?(): void
}

export interface AssistDeps {
  picks(): Parameters<typeof assistBackendsFor>[1]
  enabled(backend: BackendId): boolean
  target(backend: BackendId): Promise<AssistTarget | null>
}

type OneRun = (signal: AbortSignal | undefined, timeoutMs: number) => Promise<string | null>

function runOnce(
  target: AssistTarget,
  argv: string[],
  input: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  quitSaying?: (said: string) => void
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
        if (err && !err.killed && typeof err.code === 'number') quitSaying?.(stdout + stderr)
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
    const first = run(both.signal, ASSIST_ANSWERS_WITHIN_MS)
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

const WORTH_ANOTHER_RUN_MS = 2_000

export function koloftAssist(deps: AssistDeps): Assist {
  return async (job) => {
    const picks = deps.picks()
    for (const backend of assistBackendsFor(job.row, picks)) {
      if (!deps.enabled(backend)) continue
      const target = await deps.target(backend)
      if (job.signal?.aborted) return null
      if (!target) continue
      const shot = ONE_SHOT[backend]
      const launch = assistLaunchOn(job.row, backend, picks)
      const limitMs = shot.secondTryWhenLate ? ASSIST_ANSWERS_WITHIN_MS : ASSIST_TIMEOUT_MS
      const started = Date.now()
      const safe = EVERY_ACCOUNT_TAKES[backend]
      let modelRefused = false
      const runWith =
        (with_: ModelAndEffort): OneRun =>
        (signal, timeoutMs) =>
          runOnce(
            target,
            [...(target.args ?? []), ...shot.argv(job, with_)],
            shot.stdin(job),
            signal,
            timeoutMs,
            (said) => (modelRefused = !!shot.saysItHasNoSuchModel?.test(said))
          )
      const answered = async (): Promise<string | null> => {
        const first = await (shot.secondTryWhenLate
          ? withASecondTryWhenLate(runWith(launch), job.signal)
          : runWith(launch)(job.signal, ASSIST_TIMEOUT_MS))
        const leftMs = limitMs - (Date.now() - started)
        const tableModelRefused =
          first === null && modelRefused && launch.modelFromTheTable && launch.model !== safe.model
        if (!tableModelRefused || leftMs < WORTH_ANOTHER_RUN_MS || job.signal?.aborted) return first
        const effort = launch.effortFromTheTable ? safe.effort : launch.effort
        return runWith({ ...safe, ...(effort && { effort }) })(job.signal, leftMs)
      }
      const out = await answered().finally(() => target.done?.())
      return out === null ? null : shot.answer(out)
    }
    return null
  }
}
