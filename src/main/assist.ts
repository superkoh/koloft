import { execFile } from 'node:child_process'
import os from 'node:os'
import type { AssistSetting, BackendId } from '@shared/types'
import { backendsFrom } from '@shared/sessionBackend'
import { lastCompletedText } from './museSessionLog'

export interface AssistJob {
  system: string
  prompt: string
  signal?: AbortSignal
}

export type Assist = (job: AssistJob) => Promise<string | null>

const ASSIST_TIMEOUT_MS = 15_000

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
  }
> = {
  claude: {
    argv: (job) => CLAUDE_ONE_SHOT(job.system),
    stdin: (job) => job.prompt,
    answer: (out) => out
  },
  codex: { argv: () => CODEX_ONE_SHOT, stdin: withSystemFirst, answer: (out) => out },
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

function runOnce(
  target: AssistTarget,
  argv: string[],
  input: string,
  signal?: AbortSignal
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      target.binary,
      argv,
      { env: target.env, cwd: os.tmpdir(), timeout: ASSIST_TIMEOUT_MS, signal },
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
      const out = await runOnce(target, argv, shot.stdin(job), job.signal).finally(() =>
        target.done?.()
      )
      return out === null ? null : shot.answer(out)
    }
    return null
  }
}
