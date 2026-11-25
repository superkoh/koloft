import { execFile } from 'node:child_process'
import os from 'node:os'
import type { BackendId } from '@shared/types'
import { assistBackendsFor, assistLaunchOn } from '@shared/assistPicks'
import { EVERY_ACCOUNT_TAKES, type Assist, type ModelAndEffort } from '@core/assistModels'
import { takenEffort } from '@shared/cronModels'
import { envMs } from '@core/agent/sessionRuntime'
import type { AgentOneShot, OneShotTarget } from '@core/agent/agentsMain'

const ASSIST_TIMEOUT_MS = envMs('KOLOFT_ASSIST_TIMEOUT_MS', 15_000)
export const ASSIST_ANSWERS_WITHIN_MS = 2 * ASSIST_TIMEOUT_MS

export interface AssistDeps {
  picks(): Parameters<typeof assistBackendsFor>[1]
  enabled(backend: BackendId): boolean
  target(backend: BackendId): Promise<OneShotTarget | null>
  oneShot(backend: BackendId): AgentOneShot
  onThisAccount(backend: BackendId, asked: ModelAndEffort): Promise<ModelAndEffort>
}

type OneRun = (signal: AbortSignal | undefined, timeoutMs: number) => Promise<string | null>

function runOnce(
  target: OneShotTarget,
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
      const target = await deps.target(backend).catch((err: unknown) => {
        console.error('[koloft] Assist could not make its one-shot target:', backend, err)
        return null
      })
      if (job.signal?.aborted) {
        target?.done()
        return null
      }
      if (!target) continue
      const shot = deps.oneShot(backend)
      const launch = assistLaunchOn(job.row, backend, picks)
      const limitMs = shot.sometimesAnswersLate ? ASSIST_ANSWERS_WITHIN_MS : ASSIST_TIMEOUT_MS
      const started = Date.now()
      const spentMs = (): number => Date.now() - started
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
            (said) => (modelRefused ||= shot.saysItHasNoSuchModel.test(said))
          )
      const answered = async (): Promise<string | null> => {
        const theAccountHas = await deps.onThisAccount(backend, launch)
        if (job.signal?.aborted) return null
        const first = await (shot.sometimesAnswersLate
          ? withASecondTryWhenLate(runWith(theAccountHas), job.signal)
          : runWith(theAccountHas)(job.signal, Math.max(1, ASSIST_TIMEOUT_MS - spentMs())))
        const leftMs = limitMs - spentMs()
        const tableModelRefused =
          first === null && modelRefused && launch.modelFromTheTable && launch.model !== safe.model
        if (!tableModelRefused || leftMs < WORTH_ANOTHER_RUN_MS || job.signal?.aborted) return first
        const effort = launch.effortFromTheTable
          ? safe.effort
          : takenEffort(backend, safe.model, launch.effort)
        return runWith({ ...safe, ...(effort && { effort }) })(job.signal, leftMs)
      }
      const out = await answered().finally(() => target.done())
      return out === null ? null : shot.answerFrom(out)
    }
    return null
  }
}
