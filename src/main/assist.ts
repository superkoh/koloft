import { execFile } from 'node:child_process'
import os from 'node:os'
import type { AssistSetting, BackendId } from '@shared/types'
import { ASSIST_BACKENDS, assistBackendOf, assistBackendsFrom } from '@shared/sessionBackend'

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

// MUSE§1
export function museAnswer(stdout: string): string | null {
  let answer: string | null = null
  for (const line of stdout.split('\n')) {
    try {
      const rec = JSON.parse(line)
      if (rec.payload_type === 'run.terminal.completed' && typeof rec.payload?.text === 'string')
        answer = rec.payload.text
    } catch {
      continue
    }
  }
  return answer
}

export interface AssistTarget {
  binary: string
  env: NodeJS.ProcessEnv
}

export interface AssistDeps {
  setting(): AssistSetting
  enabled(backend: BackendId): boolean
  claude(): Promise<AssistTarget | null>
  codex(): Promise<AssistTarget | null>
  muse(): Promise<AssistTarget | null>
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
    const preferred = assistBackendOf(setting.backend) ?? ASSIST_BACKENDS[0]
    for (const backend of assistBackendsFrom(preferred)) {
      if (!deps.enabled(backend)) continue
      const target = await deps[backend]()
      if (job.signal?.aborted) return null
      if (!target) continue
      const task = `${job.system}\n\n${job.prompt}`
      if (backend === 'claude')
        return runOnce(target, CLAUDE_ONE_SHOT(job.system), job.prompt, job.signal)
      if (backend === 'codex') return runOnce(target, CODEX_ONE_SHOT, task, job.signal)
      const out = await runOnce(target, MUSE_ONE_SHOT(task), '', job.signal)
      return out === null ? null : museAnswer(out)
    }
    return null
  }
}
