import { shq } from '@shared/shellQuote'
import { AGY_APP_DIR, TOP_LEVEL_ROWS } from '../agyStore'
import { SHARED_FILES, SHARED_FOLDERS } from '../agyAccounts'
import { AGY_LOG_ENV, AGY_START_ENV } from '../agyHooks'
import { remoteShCommand } from './install'
import { tabFilePrefix, type AgyTab } from './launch'
import { REMOTE_HOOK_DIR, REMOTE_HOME, remoteMachineDir } from './paths'

export const AGY_HOOK_FILE = 'agy-hook.sh'
export const AGY_TITLE_FILE = 'agy-title.sh'
export const AGY_LIST_FILE = 'agy-list.mjs'
export const AGY_STATUSLINE_FILE = 'statusline/agy.sh'

const REMOTE_GEMINI = '$HOME/.gemini'
const REMOTE_NODE = `${REMOTE_HOME}/node/bin/node`

// AGY§4
export function remoteAgyHome(account: string): string {
  return `"${REMOTE_HOME}/agy"/${shq(account)}`
}

export function agyLogName(tabId: string): string {
  return `${tabId}.agy.jsonl`
}

// AGY§11
export function agyLogPointer(conversationId: string): string {
  return `k-${conversationId}.agy-log`
}

export function runMachineScript(machineName: string, file: string): string {
  return `/bin/sh "${remoteMachineDir(machineName)}/${file}"`
}

export interface AgyRemoteLaunch {
  tabId: string
  cwd: string
  resumeId?: string
  banner: string
  env: Record<string, string>
  agy: AgyTab
  portOffset?: number
}

export interface AgyRemotePlan {
  attach: boolean
  spawnCwd: string
  shell: string
  launchCommand(): string
  resized(id: string, cols: number, rows: number): void
}

export interface AgyTabSpec {
  tabId: string
  account: string
  args: string[]
  settings: string
  hooks: string
  onboarding?: string
  token?: string
  start?: string
  worktree?: { root: string; path: string; branch: string }
}

// AGY§4 AGY§5 AGY§6
export function agyTab(s: AgyTabSpec): AgyTab {
  const T = tabFilePrefix(s.tabId)
  const own = `$A/${AGY_APP_DIR}`
  const link = (rel: string): string =>
    `[ "$(readlink "$A/${rel}")" = "$G/${rel}" ] || { rm -rf "$A/${rel}"; ln -s "$G/${rel}" "$A/${rel}"; }`
  const seed = (file: string, target: string): string =>
    `[ -f "${T}.${file}" ] && { [ -f "${target}" ] || mv "${T}.${file}" "${target}"; rm -f "${T}.${file}"; }`
  const prepare = [
    `A=${remoteAgyHome(s.account)}; G="${REMOTE_GEMINI}"`,
    `mkdir -p "${own}/cache" "$A/config" "${REMOTE_HOOK_DIR}" && chmod 700 "${REMOTE_HOME}/agy" || exit 3`,
    ...SHARED_FOLDERS.map((d) => `mkdir -p "$G/${d}"; ${link(d)}`),
    ...SHARED_FILES.map((f) => `mkdir -p "$(dirname "$G/${f}")"; ${link(f)}`),
    `mv -f "${T}.settings.json" "${own}/settings.json" && mv -f "${T}.hooks.json" "$A/config/hooks.json" || exit 3`,
    seed('onboarding.json', `${own}/cache/onboarding.json`),
    seed('token', `${own}/antigravity-oauth-token`),
    ...(s.worktree
      ? [
          `[ -d ${shq(s.worktree.path)} ] || git -C ${shq(s.worktree.root)} worktree add -b ${shq(s.worktree.branch)} ${shq(s.worktree.path)} >/dev/null || exit 3`
        ]
      : [])
  ].join('\n')
  const env = [
    `${AGY_LOG_ENV}="${REMOTE_HOOK_DIR}/${agyLogName(s.tabId)}"`,
    ...(s.start ? [`${AGY_START_ENV}="${T}.start.json"`] : [])
  ]
  const run = `${env.join('; ')}; export ${[AGY_LOG_ENV, ...(s.start ? [AGY_START_ENV] : [])].join(' ')}
  exec agy --gemini_dir=${remoteAgyHome(s.account)} ${s.args.map(shq).join(' ')}`
  return {
    prepare,
    run,
    files: {
      'settings.json': s.settings,
      'hooks.json': s.hooks,
      ...(s.onboarding ? { 'onboarding.json': s.onboarding } : {}),
      ...(s.token ? { token: s.token } : {}),
      ...(s.start ? { 'start.json': s.start } : {})
    }
  }
}

const CONFIG_SPLIT = '\u0001'

// AGY§4 AGY§5
export function readAgyConfigCmd(account: string): string {
  const f = (p: string): string => `cat "${p}" 2>/dev/null; printf '${CONFIG_SPLIT}'`
  return remoteShCommand(
    [
      `A=${remoteAgyHome(account)}`,
      f(`${REMOTE_GEMINI}/${AGY_APP_DIR}/settings.json`),
      f(`${REMOTE_GEMINI}/config/hooks.json`),
      f(`$A/${AGY_APP_DIR}/settings.json`)
    ].join('\n')
  )
}

export interface RemoteAgyConfig {
  ownersSettings: Record<string, unknown>
  ownersHooks: Record<string, unknown>
  ownSettings: Record<string, unknown>
}

export function parseAgyConfig(stdout: string): RemoteAgyConfig {
  const [ownersSettings, ownersHooks, ownSettings] = stdout.split(CONFIG_SPLIT).map((text) => {
    try {
      const v: unknown = JSON.parse(text)
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  })
  return {
    ownersSettings: ownersSettings ?? {},
    ownersHooks: ownersHooks ?? {},
    ownSettings: ownSettings ?? {}
  }
}

// AGY§8
export function listAgyCmd(machineName: string): string {
  const script = `${REMOTE_HOME}/$1/${AGY_LIST_FILE}`
  return remoteShCommand(
    `[ -x "${REMOTE_NODE}" ] && [ -f "${script}" ] || { printf '[]'; exit 0; }
exec "${REMOTE_NODE}" --no-warnings --experimental-sqlite "${script}" "${REMOTE_GEMINI}/${AGY_APP_DIR}/conversation_summaries.db" "$2" "${REMOTE_GEMINI}/${AGY_APP_DIR}/conversations"`,
    [machineName, TOP_LEVEL_ROWS]
  )
}

// AGY§9 AGY§24
export function agyHeldCmd(conversationId: string): string {
  return remoteShCommand(
    `l="${REMOTE_GEMINI}/${AGY_APP_DIR}/presence/$1.lock"
[ -f "$l" ] && command -v flock >/dev/null 2>&1 || exit 0
flock -n "$l" true || exit 1`,
    [conversationId]
  )
}

export const AGY_HELD_ELSEWHERE_EXIT = 1

// AGY§11 AGY§29
export function agyStatuslineScript(): string {
  return `#!/bin/sh
D="$(cd "$(dirname "$0")" && pwd)"
node="${REMOTE_NODE}"
[ -x "$node" ] || exit 0
[ -n "$COLUMNS" ] && export CCSTATUSLINE_WIDTH="$COLUMNS"
exec "$node" "$D/agy.cjs" "$D/ccstatusline.js" "$D/theme.json"
`
}
