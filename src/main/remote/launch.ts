import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { AccountKind } from '@shared/types'
import { shq } from '@shared/shellQuote'
import { REMOTE_PATH_LINE } from './install'

export function accountEnv(
  kind: AccountKind,
  name: string,
  secret: string,
  endpoint?: { baseUrl?: string; model?: string }
): Record<string, string> {
  const env: Record<string, string> = { ANT_ACCOUNT: name }
  if (kind === 'apikey') env.ANTHROPIC_API_KEY = secret
  else if (kind === 'custom') {
    env.ANTHROPIC_AUTH_TOKEN = secret
    if (endpoint?.baseUrl) env.ANTHROPIC_BASE_URL = endpoint.baseUrl
    // CC§7
    if (endpoint?.model) {
      for (const k of [
        'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'ANTHROPIC_DEFAULT_FABLE_MODEL',
        'CLAUDE_CODE_SUBAGENT_MODEL'
      ]) {
        env[k] = endpoint.model
      }
      env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1'
    }
  } else env.CLAUDE_CODE_OAUTH_TOKEN = secret
  return env
}

export interface MachinePackage {
  dir: string
  name: string
}

export const UTIL_BIN_DIR = 'util-bin/'

export function buildMachinePackage(
  base: string,
  files: Record<string, string | Buffer>
): MachinePackage {
  const h = crypto.createHash('sha256')
  for (const name of Object.keys(files).sort()) {
    h.update(name)
    h.update('\0')
    h.update(files[name])
    h.update('\0')
  }
  const name = `m-${h.digest('hex').slice(0, 16)}`
  const dir = path.join(base, name)
  if (!fs.existsSync(path.join(dir, '.complete'))) {
    fs.rmSync(dir, { recursive: true, force: true })
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      const executable = rel.endsWith('.sh') || rel.startsWith(UTIL_BIN_DIR)
      fs.writeFileSync(full, content, { mode: executable ? 0o755 : 0o644 })
    }
    fs.writeFileSync(path.join(dir, '.complete'), '')
  }
  return { dir, name }
}

const NEEDS_NO_QUOTING_RE = /^[A-Za-z0-9._=-]+$/

export function tmuxSessionName(sessionId: string): string {
  return `k-${sessionId}`
}

export function sessionIdOfTmux(name: string): string | null {
  return name.startsWith('k-') ? name.slice(2) : null
}

export interface TabSpec {
  tabId: string
  tmuxName: string
  machineName: string
  cwd: string
  fallbackCwd?: string
  banner: string
  env?: Record<string, string>
  settings: Record<string, unknown>
  claudeArgs: string[]
}

export const POSIX_SHELL_FOR_REMOTE_LAUNCH_LINE = '/bin/zsh'

export function tabScript(spec: TabSpec): string {
  if (
    !NEEDS_NO_QUOTING_RE.test(spec.tabId) ||
    !NEEDS_NO_QUOTING_RE.test(spec.tmuxName) ||
    !NEEDS_NO_QUOTING_RE.test(spec.machineName)
  ) {
    throw new Error('unsafe tab/session name')
  }
  const T = `$HOME/.koloft/tabs/${spec.tabId}`
  const H = `$HOME/.koloft/hook-sessions/${spec.tabId}`
  // PLATFORM§35
  return `#!/bin/sh
M="$HOME/.koloft/${spec.machineName}"
${REMOTE_PATH_LINE}
[ "$1" = attach ] && exec tmux -L koloft attach -d -t '${spec.tmuxName}'
if [ "$1" = run ]; then
  KOLOFT_TMUX_FOLLOW=1; export KOLOFT_TMUX_FOLLOW
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
  E="${T}.env"; [ -f "$E" ] && { set -a; . "$E"; set +a; rm -f "$E"; }
  exec claude --settings "${T}.json" ${spec.claudeArgs.map(shq).join(' ')}
fi
sh "$M/ensure.sh" || exit $?
cd ${shq(spec.cwd)}${spec.fallbackCwd ? ` || cd ${shq(spec.fallbackCwd)}` : ''} || exit 3
echo ${shq(spec.banner)}
rm -f "${H}.json" "${H}.status.jsonl"
# CC§10
CJ="$HOME/.claude.json"
if [ -f "${T}.env" ]; then
  if [ ! -f "$CJ" ]; then printf '{"hasCompletedOnboarding":true}\\n' > "$CJ"
  elif ! grep -q hasCompletedOnboarding "$CJ" && [ "$(head -n1 "$CJ")" = "{" ]; then
    sed -i.koloft-bak '1s/^{/{"hasCompletedOnboarding":true,/' "$CJ" && rm -f "$CJ.koloft-bak"
  fi
  # CC§10
  if ! grep -q cachedGrowthBookFeatures "$CJ"; then
    echo '[Koloft] first run on this machine: fetching Claude settings (a few seconds)'
    ( set -a; . "${T}.env"; set +a
      if command -v timeout >/dev/null 2>&1; then timeout 60 claude -p ok --max-turns 1; else claude -p ok --max-turns 1; fi ) >/dev/null 2>&1
  fi
fi
tmux -L koloft -f "$M/tmux.conf" new-session -A -D -s '${spec.tmuxName}' 'sh "${T}.sh" run'
c=$?
rm -f "${T}.env"
exit $c
`
}

export function writeTabPackage(dir: string, spec: TabSpec): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, `${spec.tabId}.json`), JSON.stringify(spec.settings), {
    mode: 0o600
  })
  fs.writeFileSync(path.join(dir, `${spec.tabId}.sh`), tabScript(spec), { mode: 0o700 })
  if (spec.env) {
    const lines = Object.entries(spec.env).map(([k, v]) => `${k}=${shq(v)}`)
    fs.writeFileSync(path.join(dir, `${spec.tabId}.env`), lines.join('\n') + '\n', { mode: 0o600 })
  }
}

export interface LaunchLineSpec {
  host: string
  sshOptions: string[]
  machine: MachinePackage
  tabDir: string
  tabId: string
  mode: 'start' | 'attach'
}

const SSH_LINK_BROKE_EXIT = 255

const TURN_OFF_MOUSE_PASTE_AND_ALT_SCREEN = `printf '\\033[?1000l\\033[?1002l\\033[?1003l\\033[?1006l\\033[?2004l\\033[?25h\\033[?1049l'`

function machineReady(s: {
  host: string
  sshOptions: string[]
  machine: MachinePackage
  tabId: string
}): string {
  const opts = s.sshOptions.join(' ')
  const host = shq(s.host)
  const m = s.machine.name
  const tmp = `m.tmp.${s.tabId}`
  const probe = `ssh -n ${opts} ${host} 'test -d "$HOME/.koloft/${m}" && echo ok'`
  const pushMachine =
    `COPYFILE_DISABLE=1 tar cf - -C ${shq(s.machine.dir)} . | ssh ${opts} ${host} ` +
    `'umask 077; mkdir -p "$HOME/.koloft" && cd "$HOME/.koloft" && rm -rf ${tmp} && mkdir ${tmp} ` +
    `&& tar xf - -C ${tmp} && sh -c "test -d ${m} || mv ${tmp} ${m}; rm -rf ${tmp}"'`
  return `h=$(${probe}); { [ "$h" = ok ] || ${pushMachine}; }`
}

const COULD_NOT_CONNECT = `echo '[Koloft] could not connect or push files — see the error above'`

// PLATFORM§33
export function launchLine(s: LaunchLineSpec): string {
  const opts = s.sshOptions.join(' ')
  const host = shq(s.host)
  const pushTab =
    `COPYFILE_DISABLE=1 tar cf - -C ${shq(s.tabDir)} . | ssh ${opts} ${host} ` +
    `'umask 077; mkdir -p "$HOME/.koloft/tabs" && tar xf - -C "$HOME/.koloft/tabs"'`
  const run = `ssh -tt ${opts} ${host} "sh \\"\\$HOME/.koloft/tabs/${s.tabId}.sh\\" $a"`
  return (
    `${machineReady(s)} && ${pushTab} ` +
    `|| { ${COULD_NOT_CONNECT}; rm -rf ${shq(s.tabDir)}; exit 4; }; ` +
    `rm -rf ${shq(s.tabDir)}; a=${s.mode}; while :; do ${run}; c=$?; [ "$c" = ${SSH_LINK_BROKE_EXIT} ] || { ` +
    `[ "$c" = 0 ] || { echo "[Koloft] the session did not start (exit $c) — see above; press Enter to close"; read -r _; }; exit "$c"; }; ` +
    `a=attach; ${TURN_OFF_MOUSE_PASTE_AND_ALT_SCREEN}; clear; ` +
    `echo '[Koloft] connection lost, reconnecting in 2s…'; sleep 2; done`
  )
}

export interface UtilShellLineSpec {
  host: string
  sshOptions: string[]
  machine: MachinePackage
  tabId: string
  dir: string
}

// PLATFORM§33
export function utilShellLine(s: UtilShellLineSpec): string {
  const run = `sh "$HOME/.koloft/${s.machine.name}/util.sh" ${shq(s.dir)}`
  return (
    `${machineReady(s)} || { ${COULD_NOT_CONNECT}; exit 4; }; ` +
    `clear; ssh -t ${s.sshOptions.join(' ')} ${shq(s.host)} ${shq(run)}; exit`
  )
}

// PLATFORM§33
export function killSessionCmd(tmuxName: string): string {
  return `sh -c '${REMOTE_PATH_LINE}; tmux -L koloft kill-session -t ${tmuxName}'`
}
