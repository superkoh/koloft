import { execFile } from 'node:child_process'
import os from 'node:os'
import type { AccountKind } from '@shared/types'

const NAME_MAX_CHARS = 40
const TASK_MAX_CHARS_SENT_FOR_A_TITLE = 4000
const TITLE_TIMEOUT_MS = 10_000

const TITLE_INSTRUCTIONS =
  'Give the task below a very short title, so a person sees at a glance what this session is doing. ' +
  'Write it in the language of the task: at most 16 characters in Chinese or Japanese, at most 6 words otherwise. ' +
  'Leave out background, rules and filler such as "research a question". ' +
  'Reply with the title alone, no quotes, no full stop.\n\nTask:\n'

// CC§9
const TITLE_ARGV = [
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
  'You write short titles.',
  '--tools',
  ''
]

export function firstLineName(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  return (line ?? '')
    .replace(/^-+\s*/, '')
    .slice(0, NAME_MAX_CHARS)
    .trim()
}

export function nameFromReply(reply: string): string {
  return firstLineName(reply)
    .replace(/^["'“‘「『]+|["'”’」』。.!！]+$/g, '')
    .trim()
}

export function distinctName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  let n = 2
  while (taken.has(`${name} ${n}`)) n++
  return `${name} ${n}`
}

export type TitleModel = (prompt: string) => Promise<string | null>

export async function nameForTask(
  task: string,
  model: TitleModel,
  taken: Set<string>
): Promise<string> {
  const reply = await model(TITLE_INSTRUCTIONS + task.slice(0, TASK_MAX_CHARS_SENT_FOR_A_TITLE))
  return distinctName((reply && nameFromReply(reply)) || firstLineName(task), taken)
}

export function accountAuthEnv(
  kind: AccountKind,
  secret: string,
  endpoint?: { baseUrl?: string; model?: string }
): NodeJS.ProcessEnv {
  if (kind === 'oauth') return { CLAUDE_CODE_OAUTH_TOKEN: secret }
  if (kind === 'apikey') return { ANTHROPIC_API_KEY: secret }
  // CC§7
  return {
    ANTHROPIC_AUTH_TOKEN: secret,
    ...(endpoint?.baseUrl ? { ANTHROPIC_BASE_URL: endpoint.baseUrl } : {}),
    ...(endpoint?.model ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: endpoint.model } : {})
  }
}

const AUTH_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']

export function claudeTitleModel(
  claude: () => string,
  auth: () => Promise<NodeJS.ProcessEnv>
): TitleModel {
  return async (prompt) => {
    const picked = await auth().catch(() => ({}))
    const env = { ...process.env }
    if (Object.keys(picked).some((k) => AUTH_VARS.includes(k))) {
      for (const k of AUTH_VARS) delete env[k]
    }
    return new Promise((resolve) => {
      const child = execFile(
        claude(),
        TITLE_ARGV,
        { env: { ...env, ...picked }, cwd: os.tmpdir(), timeout: TITLE_TIMEOUT_MS },
        (err, stdout) => resolve(err ? null : stdout)
      )
      child.stdin?.on('error', () => {})
      child.stdin?.end(prompt)
    })
  }
}
