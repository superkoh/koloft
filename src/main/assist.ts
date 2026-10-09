import { execFile } from 'node:child_process'
import os from 'node:os'
import type { AssistSetting, BackendId } from '@shared/types'

export interface AssistJob {
  system: string
  prompt: string
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

interface AssistRun {
  binary: string
  argv: string[]
  env: NodeJS.ProcessEnv
  input: string
}

export interface AssistTarget {
  binary: string
  env: NodeJS.ProcessEnv
}

export interface AssistDeps {
  setting(): AssistSetting
  claude(): Promise<AssistTarget | null>
  codex(): Promise<AssistTarget | null>
}

function runOnce({ binary, argv, env, input }: AssistRun): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      binary,
      argv,
      { env, cwd: os.tmpdir(), timeout: ASSIST_TIMEOUT_MS },
      (err, stdout) => resolve(err ? null : stdout)
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}

function runFor(backend: BackendId, job: AssistJob, target: AssistTarget): AssistRun {
  return backend === 'claude'
    ? { ...target, argv: CLAUDE_ONE_SHOT(job.system), input: job.prompt }
    : { ...target, argv: CODEX_ONE_SHOT, input: `${job.system}\n\n${job.prompt}` }
}

export function koloftAssist(deps: AssistDeps): Assist {
  return async (job) => {
    const setting = deps.setting()
    if (!setting?.on) return null
    const target = await deps[setting.backend]()
    if (!target) return null
    return runOnce(runFor(setting.backend, job, target))
  }
}
