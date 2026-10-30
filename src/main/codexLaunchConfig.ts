import fs from 'fs'
import path from 'path'
import type { CreateTabOptions, LaunchPermission } from '@shared/types'
import { record } from './codexObservation'
import { playwrightMcpEnv } from './browserControlEnv'

// CODEX§27 CODEX§30
const codexHookGroup = ({ command, matcher, timeout }: KoloftHook): string =>
  `{${matcher ? `matcher=${JSON.stringify(matcher)},` : ''}hooks=[{type="command",command=${JSON.stringify(command)}${timeout ? `,timeout=${timeout}` : ''}}]}`

// CODEX§20
export const CODEX_ASKS_AND_WAITS = 'features.default_mode_request_user_input=true'

// CODEX§8
export const STATUS_LINE_CONFIG = `tui.status_line=${JSON.stringify([
  'context-used',
  'five-hour-limit',
  'weekly-limit',
  'git-branch',
  'codex-version',
  'model-with-reasoning',
  'estimated-thread-cost',
  'pull-request-number',
  'current-dir'
])}`

// CODEX§17
export function developerInstructions(lines: string[]): string {
  return `developer_instructions=${JSON.stringify(lines.join('\n\n'))}`
}

// CODEX§1
export const NO_UPDATE_NOTICE_AT_START = 'check_for_update_on_startup=false'

const stringList = (raw: unknown): string[] =>
  (Array.isArray(raw) ? raw : []).filter((v): v is string => typeof v === 'string')

const mergedList = (own: unknown, ours: string[]): string =>
  JSON.stringify([...new Set([...stringList(own), ...ours])])

// CODEX§26
export function browserSandboxOverrides(sandbox: unknown, cacheDir: string): string[] {
  return [
    'sandbox_workspace_write.network_access=true',
    `sandbox_workspace_write.writable_roots=${mergedList(record(sandbox).writable_roots, [cacheDir])}`
  ]
}

const runsPlaywrightMcp = (word: string): boolean =>
  word.includes('@playwright/mcp') || path.basename(word) === 'playwright-mcp'

const KEY_THE_CODEX_FLAG_PARSER_TAKES = /^[A-Za-z0-9_-]+$/

// CODEX§26
export function playwrightEnvOverrides(mcpServers: unknown): string[] {
  return Object.entries(record(mcpServers)).flatMap(([name, raw]) => {
    const entry = record(raw)
    const words = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])]
    if (!KEY_THE_CODEX_FLAG_PARSER_TAKES.test(name)) return []
    if (!words.some((w) => typeof w === 'string' && runsPlaywrightMcp(w))) return []
    return [
      `mcp_servers.${name}.env_vars=${mergedList(entry.env_vars, Object.keys(playwrightMcpEnv('')))}`
    ]
  })
}

const ASSIST_MEMORY = `# Assist memory

This file is your memory folder. When the owner asks you to remember something, add it here as one short line. Keep everything already here.
`

// CODEX§17
export function seedAssistMemory(folder: string): void {
  try {
    fs.writeFileSync(path.join(folder, 'AGENTS.md'), ASSIST_MEMORY, { flag: 'wx' })
  } catch {}
}

export interface KoloftHook {
  event: string
  command: string
  matcher?: string
  timeout?: number
}

// CODEX§27
export const trustedInPlace = (hooks: KoloftHook[], trusted: Set<string>): KoloftHook[] =>
  hooks.filter((h, i) =>
    hooks.slice(0, i + 1).every((o) => o.event !== h.event || trusted.has(o.command))
  )

// CODEX§27
export const hookOverrides = (hooks: KoloftHook[]): string[] =>
  [...new Set(hooks.map((h) => h.event))].map(
    (event) =>
      `hooks.${event}=[${hooks
        .filter((h) => h.event === event)
        .map(codexHookGroup)
        .join(',')}]`
  )

interface Permissions {
  approval: 'never' | 'on-request'
  sandbox: 'workspace-write' | 'danger-full-access'
}

// CODEX§11
export const PERMISSIONS: Record<LaunchPermission, Permissions | undefined> = {
  default: undefined,
  acceptEdits: { approval: 'on-request', sandbox: 'workspace-write' },
  bypass: { approval: 'never', sandbox: 'danger-full-access' }
}

// CODEX§11 CODEX§16
export function machineTrustedFolderFlags(ownConfig: Record<string, unknown>): string[] {
  return [
    ...(ownConfig.approval_policy ? [] : ['-a', 'on-request']),
    ...(ownConfig.sandbox_mode ? [] : ['-s', 'workspace-write'])
  ]
}

// CODEX§11
export function permissionFlags(p: Permissions | undefined): string[] {
  return p ? ['-a', p.approval, '-s', p.sandbox] : []
}

// CODEX§11
export function permissionConfig(p: Permissions | undefined): string[] {
  return p
    ? [`approval_policy=${JSON.stringify(p.approval)}`, `sandbox_mode=${JSON.stringify(p.sandbox)}`]
    : []
}

// CODEX§14
export function launchChoiceArgs(opts: CreateTabOptions): string[] {
  return [
    ...(opts.model ? ['-m', opts.model] : []),
    ...(opts.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(opts.effort)}`] : [])
  ]
}
