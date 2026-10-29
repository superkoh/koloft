import { shq } from '@shared/shellQuote'
import { record } from '../codexObservation'
import { AGY_APP_DIR, TOP_LEVEL_ROWS } from '../agyStore'
import { SHARED_FILES, SHARED_FOLDERS } from '../agyAccounts'
import { AGY_LOG_ENV, AGY_LOG_POINTER_SUFFIX, AGY_START_ENV } from '../agyHooks'
import { NOTICE_ENV, remoteNoticeFile } from '../hooks'
import { remoteShCommand } from './install'
import { koloftSkillLine, machineToolProgram, type TabProgram } from './launch'
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
  env: Record<string, string>
  portOffset?: number
  program: TabProgram
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
  banner?: string
  args: string[]
  settings: string
  hooks: string
  onboarding?: string
  token?: string
  start?: string
  skillFromMachine?: string
}

// AGY§31
export const AGY_SKILLS = `${AGY_APP_DIR}/skills`

// AGY§4 AGY§5 AGY§6
export function agyTab(s: AgyTabSpec): TabProgram {
  const own = `$A/${AGY_APP_DIR}`
  const link = (rel: string): string =>
    `[ "$(readlink "$A/${rel}")" = "$G/${rel}" ] || { rm -rf "$A/${rel}"; ln -s "$G/${rel}" "$A/${rel}"; }`
  const seed = (file: string, target: string): string =>
    `[ -f "$T.${file}" ] && { [ -f "${target}" ] || mv "$T.${file}" "${target}"; rm -f "$T.${file}"; }`
  const exported = [AGY_LOG_ENV, NOTICE_ENV, ...(s.start ? [AGY_START_ENV] : [])]
  const run = [
    // PLATFORM§35
    ...(s.banner ? [`printf '%s\\n' ${shq(s.banner)}`] : []),
    `A=${remoteAgyHome(s.account)}; G="${REMOTE_GEMINI}"`,
    `mkdir -p "${own}/cache" "$A/config" "${REMOTE_HOOK_DIR}" && chmod 700 "${REMOTE_HOME}/agy"`,
    ...SHARED_FOLDERS.map((d) => `mkdir -p "$G/${d}"; ${link(d)}`),
    ...SHARED_FILES.map((f) => `mkdir -p "$(dirname "$G/${f}")"; ${link(f)}`),
    `mv -f "$T.settings.json" "${own}/settings.json" && mv -f "$T.hooks.json" "$A/config/hooks.json"`,
    seed('onboarding.json', `${own}/cache/onboarding.json`),
    seed('auth.json', `${own}/antigravity-oauth-token`),
    koloftSkillLine(`$A/${AGY_SKILLS}`, s.skillFromMachine && remoteMachineDir(s.skillFromMachine)),
    `unset ${AGY_KEY_ENV}; [ -n "$${AGY_KEY_FROM_KOLOFT}" ] && { ${AGY_KEY_ENV}="$${AGY_KEY_FROM_KOLOFT}"; export ${AGY_KEY_ENV}; }; unset ${AGY_KEY_FROM_KOLOFT}`,
    `${AGY_LOG_ENV}="${REMOTE_HOOK_DIR}/${agyLogName(s.tabId)}"`,
    `${NOTICE_ENV}="${remoteNoticeFile(s.tabId)}"`,
    ...(s.start ? [`${AGY_START_ENV}="$T.start.json"`] : []),
    `export ${exported.join(' ')}`,
    `exec agy --gemini_dir=${remoteAgyHome(s.account)} ${s.args.map(shq).join(' ')}`
  ]
  const file = (name: string): string => `${s.tabId}.${name}`
  return machineToolProgram('agy', run.map((line) => `  ${line}\n`).join(''), {
    [file('settings.json')]: s.settings,
    [file('hooks.json')]: s.hooks,
    ...(s.onboarding ? { [file('onboarding.json')]: s.onboarding } : {}),
    ...(s.token ? { [file('auth.json')]: s.token } : {}),
    ...(s.start ? { [file('start.json')]: s.start } : {})
  })
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
    `[ -x "${REMOTE_NODE}" ] && [ -f "${script}" ] || { echo "Koloft's files are not on this machine yet." >&2; exit 1; }
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

// AGY§16 AGY§29
const AGY_SEND_JS = `import fs from 'fs'
import http from 'http'
import { execFileSync } from 'child_process'
const [tmuxName, cascadeId] = process.argv.slice(1)
const text = fs.readFileSync(0, 'utf8')
const out = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}
const pane = out('tmux', ['-L', 'koloft', 'list-panes', '-t', tmuxName, '-F', '#{pane_pid}']).trim().split('\\n')[0]
const procs = out('ps', ['-A', '-ww', '-o', 'pid=,ppid=,args=']).split('\\n').flatMap((line) => {
  const m = /^\\s*(\\d+)\\s+(\\d+)\\s+(.*)$/.exec(line)
  return m ? [{ pid: m[1], ppid: m[2], args: m[3] }] : []
})
const tree = new Set([pane])
for (let size = 0; size !== tree.size; ) {
  size = tree.size
  for (const p of procs) if (tree.has(p.ppid)) tree.add(p.pid)
}
const agy = procs.find((p) => tree.has(p.pid) && /--csrf_token=\\S+/.test(p.args))
if (!pane || !agy) process.exit(1)
const token = /--csrf_token=(\\S+)/.exec(agy.args)[1]
function ports() {
  const listed = out('lsof', ['-nP', '-a', '-p', agy.pid, '-iTCP', '-sTCP:LISTEN', '-Fn'])
    .split('\\n')
    .flatMap((l) => (l.startsWith('n') ? [Number(/:(\\d+)$/.exec(l)?.[1])] : []))
  if (listed.length) return listed
  const inodes = new Set()
  try {
    for (const fd of fs.readdirSync('/proc/' + agy.pid + '/fd')) {
      try {
        const m = /^socket:\\[(\\d+)\\]$/.exec(fs.readlinkSync('/proc/' + agy.pid + '/fd/' + fd))
        if (m) inodes.add(m[1])
      } catch {}
    }
  } catch {}
  return ['/proc/net/tcp', '/proc/net/tcp6'].flatMap((f) => {
    let table = ''
    try {
      table = fs.readFileSync(f, 'utf8')
    } catch {}
    return table.split('\\n').flatMap((l) => {
      const c = l.trim().split(/\\s+/)
      return c.length > 9 && c[3] === '0A' && inodes.has(c[9]) ? [parseInt(c[1].split(':')[1], 16)] : []
    })
  })
}
const post = (port, method, body) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/exa.language_server_pb.LanguageServerService/' + method,
        method: 'POST',
        timeout: 15000,
        headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': token }
      },
      (res) => {
        let t = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (t += c))
        res.on('end', () => (res.statusCode === 200 ? resolve(t ? JSON.parse(t) : {}) : reject(new Error(t))))
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
for (const port of new Set(ports().filter((p) => p > 0))) {
  try {
    await post(port, 'GetStatus', {})
  } catch {
    continue
  }
  const steps = (await post(port, 'GetCascadeTrajectory', { cascadeId })).trajectory?.steps ?? []
  const cascadeConfig = steps.map((s) => s?.userInput?.userConfig).filter(Boolean).pop()
  if (!cascadeConfig) process.exit(1)
  await post(port, 'SendUserCascadeMessage', { cascadeId, items: [{ text }], cascadeConfig })
  process.exit(0)
}
process.exit(1)
`

// AGY§16 AGY§29
export function agySendCmd(tmuxName: string, conversationId: string): string {
  return remoteShCommand(
    `[ -x "${REMOTE_NODE}" ] || exit 1\nexec "${REMOTE_NODE}" --input-type=module -e ${shq(AGY_SEND_JS)} "$1" "$2"`,
    [tmuxName, conversationId]
  )
}

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
