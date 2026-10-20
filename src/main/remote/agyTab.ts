import { shq } from '@shared/shellQuote'
import { record } from '../codexObservation'
import { AGY_APP_DIR, TOP_LEVEL_ROWS } from '../agyStore'
import { SHARED_FILES, SHARED_FOLDERS } from '../agyAccounts'
import { AGY_LOG_ENV, AGY_LOG_POINTER_SUFFIX, AGY_START_ENV } from '../agyHooks'
import { NOTICE_ENV, remoteNoticeFile } from '../hooks'
import { remoteShCommand } from './install'
import type { TabSpec } from './launch'
import { REMOTE_HOOK_DIR, REMOTE_HOME, remoteMachineDir } from './paths'

const AGY_KEY_ENV = 'GEMINI_API_KEY'
export const AGY_KEY_FROM_KOLOFT = 'KOLOFT_AGY_KEY'

// AGY§8 AGY§19
export const AGY_BRAIN_FLAGS = [
  '--inplace',
  '-m',
  '--delete',
  '--include=/*/',
  '--include=/*/*.md.metadata.json',
  '--include=/*/.system_generated/',
  '--include=/*/.system_generated/logs/',
  '--include=/*/.system_generated/logs/transcript.jsonl',
  '--exclude=*'
]
export const AGY_REMOTE_BRAIN = `.gemini/${AGY_APP_DIR}/brain`

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
  return `k-${conversationId}${AGY_LOG_POINTER_SUFFIX}`
}

export function runMachineScript(machineName: string, file: string): string {
  return `/bin/sh "${remoteMachineDir(machineName)}/${file}"`
}

export interface AgyMachineLaunch {
  tabId: string
  cwd: string
  resumeId?: string
  banner: string
  env: Record<string, string>
  portOffset?: number
  program: AgyProgram
}

export interface AgyMachinePlan {
  attach: boolean
  tmuxName: string
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
}

export type AgyProgram = NonNullable<TabSpec['program']>

// AGY§4 AGY§5 AGY§6
export function agyTab(s: AgyTabSpec): AgyProgram {
  const own = `$A/${AGY_APP_DIR}`
  const link = (rel: string): string =>
    `[ "$(readlink "$A/${rel}")" = "$G/${rel}" ] || { rm -rf "$A/${rel}"; ln -s "$G/${rel}" "$A/${rel}"; }`
  const seed = (file: string, target: string): string =>
    `[ -f "$T.${file}" ] && { [ -f "${target}" ] || mv "$T.${file}" "${target}"; rm -f "$T.${file}"; }`
  const exported = [AGY_LOG_ENV, NOTICE_ENV, ...(s.start ? [AGY_START_ENV] : [])]
  const run = [
    `A=${remoteAgyHome(s.account)}; G="${REMOTE_GEMINI}"`,
    `mkdir -p "${own}/cache" "$A/config" "${REMOTE_HOOK_DIR}" && chmod 700 "${REMOTE_HOME}/agy"`,
    ...SHARED_FOLDERS.map((d) => `mkdir -p "$G/${d}"; ${link(d)}`),
    ...SHARED_FILES.map((f) => `mkdir -p "$(dirname "$G/${f}")"; ${link(f)}`),
    `mv -f "$T.settings.json" "${own}/settings.json" && mv -f "$T.hooks.json" "$A/config/hooks.json"`,
    seed('onboarding.json', `${own}/cache/onboarding.json`),
    seed('auth.json', `${own}/antigravity-oauth-token`),
    `unset ${AGY_KEY_ENV}; [ -n "$${AGY_KEY_FROM_KOLOFT}" ] && { ${AGY_KEY_ENV}="$${AGY_KEY_FROM_KOLOFT}"; export ${AGY_KEY_ENV}; }; unset ${AGY_KEY_FROM_KOLOFT}`,
    `${AGY_LOG_ENV}="${REMOTE_HOOK_DIR}/${agyLogName(s.tabId)}"`,
    `${NOTICE_ENV}="${remoteNoticeFile(s.tabId)}"`,
    ...(s.start ? [`${AGY_START_ENV}="$T.start.json"`] : []),
    `export ${exported.join(' ')}`,
    `exec agy --gemini_dir=${remoteAgyHome(s.account)} ${s.args.map(shq).join(' ')}`
  ]
  const file = (name: string): string => `${s.tabId}.${name}`
  return {
    name: 'agy',
    run: run.map((line) => `  ${line}\n`).join(''),
    files: {
      [file('settings.json')]: s.settings,
      [file('hooks.json')]: s.hooks,
      ...(s.onboarding ? { [file('onboarding.json')]: s.onboarding } : {}),
      ...(s.token ? { [file('auth.json')]: s.token } : {}),
      ...(s.start ? { [file('start.json')]: s.start } : {})
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
      return record(JSON.parse(text))
    } catch {
      return {}
    }
  })
  return {
    ownersSettings: record(ownersSettings),
    ownersHooks: record(ownersHooks),
    ownSettings: record(ownSettings)
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
