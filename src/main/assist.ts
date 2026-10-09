import { execFile } from 'node:child_process'
import os from 'node:os'
import type { AssistSetting } from '@shared/types'

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

export interface AssistTarget {
  binary: string
  env: NodeJS.ProcessEnv
}

export interface AssistDeps {
  setting(): AssistSetting
  claude(): Promise<AssistTarget | null>
  codex(): Promise<AssistTarget | null>
}

function runOnce(target: AssistTarget, argv: string[], input: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      target.binary,
      argv,
      { env: target.env, cwd: os.tmpdir(), timeout: ASSIST_TIMEOUT_MS },
      (err, stdout) => resolve(err ? null : stdout)
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}

export function koloftAssist(deps: AssistDeps): Assist {
  return async (job) => {
    const setting = deps.setting()
    if (!setting?.on) return null
    const target = await deps[setting.backend]()
    if (!target) return null
    return setting.backend === 'claude'
      ? runOnce(target, CLAUDE_ONE_SHOT(job.system), job.prompt)
      : runOnce(target, CODEX_ONE_SHOT, `${job.system}\n\n${job.prompt}`)
  }
}
