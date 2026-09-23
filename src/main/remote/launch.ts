import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { AccountKind } from '@shared/types'
import { shq } from '@shared/shellQuote'
import { REMOTE_PATH_LINE } from './install'

// Starting a remote session is one line typed into the tab's local shell — the same
// way a local session is `exec claude` typed into it. The line pushes two packages
// (the machine package once per content hash, the tab package every time) and then
// loops `ssh -tt … tabs/<tab>.sh` until it exits with anything but 255, ssh's own
// "link broke" code: only that reconnects, and a reconnect attaches instead of
// starting. Everything here is pure path/string work so it can run under a fake
// ssh; index.ts supplies the accounts, the tracker and the pty.
//
// Two shells run the strings below and both must accept them: the user's LOCAL
// login shell types the line (zsh/bash), and the user's REMOTE login shell runs each
// ssh command (which may be fish) — so the remote commands use no `{ }`, no `$$` and
// no `export`; anything needing sh syntax is wrapped in `sh -c` or lives in a script.

/** what a tab's `.env` carries per account kind — the same variables the local shim
 *  exports (shim.ts), so a remote claude authenticates exactly like a local one */
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
    if (endpoint?.model) {
      // the same model pins the local shim exports (src/main/shim.ts) — add to both
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
      // without FORCE the subagent model is only a default, and an agent whose
      // definition names a claude-* model id escapes the pin and 404s
      env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1'
    }
  } else env.CLAUDE_CODE_OAUTH_TOKEN = secret
  return env
}

export interface MachinePackage {
  dir: string
  /** `m-<hash>`: the folder name on the machine, so a changed file is a new folder
   *  and a running session never has its files rewritten under it */
  name: string
}

/** Lay the machine package out under `<base>/<m-hash>/` — the folder pushed to
 *  `~/.koloft/` on first contact. `files` are relative paths inside the package. */
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
      fs.writeFileSync(full, content, { mode: rel.endsWith('.sh') ? 0o755 : 0o644 })
    }
    fs.writeFileSync(path.join(dir, '.complete'), '')
  }
  return { dir, name }
}

/** tokens that go on claude's command line inside the tmux command string, which is
 *  single-quoted as a whole — so nothing quotable may pass */
const ARG_RE = /^[A-Za-z0-9._=-]+$/

/** tmux names a session after the claude session it is running, so the heartbeat's
 *  liveness, the kill and the restart all key off the CURRENT id — the hook renames
 *  the tmux session whenever an in-TUI /clear moves claude to a new one. */
export function tmuxSessionName(sessionId: string): string {
  return `k-${sessionId}`
}

/** the inverse; null for a name that is not one of ours */
export function sessionIdOfTmux(name: string): string | null {
  return name.startsWith('k-') ? name.slice(2) : null
}

export interface TabSpec {
  tabId: string
  /** `k-<session id>` at launch; the hook renames it after an in-TUI /clear, so the
   *  tracker's copy moves with the session (index.ts handleHookRegistration) */
  tmuxName: string
  machineName: string
  /** absolute path on the machine */
  cwd: string
  /** where to start instead when `cwd` is gone — the workspace root, for a resume
   *  into a worktree that was removed over there (claude then runs unisolated) */
  fallbackCwd?: string
  /** printed just before claude starts: which account, or that none was sent */
  banner: string
  /** credential variables; absent when the balancer is off or found nothing */
  env?: Record<string, string>
  /** the `--settings` document (hooks.ts hookSettings with the machine's paths) */
  settings: Record<string, unknown>
  /** claude's argv after `--settings <file>` */
  claudeArgs: string[]
}

export function tabScript(spec: TabSpec): string {
  for (const a of spec.claudeArgs) if (!ARG_RE.test(a)) throw new Error(`unsafe claude arg: ${a}`)
  if (!ARG_RE.test(spec.tabId) || !ARG_RE.test(spec.tmuxName) || !ARG_RE.test(spec.machineName)) {
    throw new Error('unsafe tab/session name')
  }
  const T = `$HOME/.koloft/tabs/${spec.tabId}`
  // the tmux command string: run by sh (tmux.conf default-shell), so `set -a;. file`
  // is safe even for a fish user. The .env is read once and removed at once — and
  // removed again after tmux returns, for the start that found the session already
  // running (-A attaches and never runs this command, so nothing else would).
  const H = `$HOME/.koloft/hook-sessions/${spec.tabId}`
  // the tmux session is renamed to follow claude's session id by the hook, which only
  // does it when this says so — a LOCAL claude must never rename anything
  const cmd =
    `KOLOFT_TMUX_FOLLOW=1; export KOLOFT_TMUX_FOLLOW; ` +
    `unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN; ` +
    `E="${T}.env"; [ -f "$E" ] && { set -a; . "$E"; set +a; rm -f "$E"; }; ` +
    `exec claude --settings "${T}.json" ${spec.claudeArgs.join(' ')}`
  return `#!/bin/sh
M="$HOME/.koloft/${spec.machineName}"
${REMOTE_PATH_LINE}
[ "$1" = attach ] && exec tmux -L koloft attach -d -t '${spec.tmuxName}'
sh "$M/ensure.sh" || exit $?
cd ${shq(spec.cwd)}${spec.fallbackCwd ? ` || cd ${shq(spec.fallbackCwd)}` : ''} || exit 3
echo ${shq(spec.banner)}
# tab ids are recycled across Koloft runs: a previous tab's leftover reports would be
# mirrored back here and replayed as this session's own
rm -f "${H}.json" "${H}.status.jsonl"
# a fresh claude shows its first-run "select login method" page even with the token in
# its environment (measured, CC 2.1.263); when Koloft brings the login that page has
# nothing to ask, and this is the flag that skips it (docs/claude-code-contract.md §10)
CJ="$HOME/.claude.json"
if [ -f "${T}.env" ]; then
  if [ ! -f "$CJ" ]; then printf '{"hasCompletedOnboarding":true}\\n' > "$CJ"
  elif ! grep -q hasCompletedOnboarding "$CJ" && [ "$(head -n1 "$CJ")" = "{" ]; then
    sed -i.koloft-bak '1s/^{/{"hasCompletedOnboarding":true,/' "$CJ" && rm -f "$CJ.koloft-bak"
  fi
  # claude's full-screen layout is switched on by server-side flags it caches in
  # ~/.claude.json; the very first process on a machine draws before they arrive and
  # keeps the old flow layout for its whole life (contract §10). One print-mode call
  # fetches and caches them (the interactive start parked on the trust question does
  # not), so the session the person sees starts with the flags in place.
  if ! grep -q cachedGrowthBookFeatures "$CJ"; then
    echo '[Koloft] first run on this machine: fetching Claude settings (a few seconds)'
    ( set -a; . "${T}.env"; set +a
      if command -v timeout >/dev/null 2>&1; then timeout 60 claude -p ok --max-turns 1; else claude -p ok --max-turns 1; fi ) >/dev/null 2>&1
  fi
fi
tmux -L koloft -f "$M/tmux.conf" new-session -A -D -s '${spec.tmuxName}' '${cmd}'
c=$?
rm -f "${T}.env"
exit $c
`
}

/** Write `<tab>.json` / `<tab>.sh` / `<tab>.env` into `dir` — the folder whose
 *  contents land in `~/.koloft/tabs/` on the machine. */
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
  /** the shared ssh options (remote/ssh.ts sshOptions), already split */
  sshOptions: string[]
  machine: MachinePackage
  /** the local tab package folder; removed by the line once pushed */
  tabDir: string
  tabId: string
  /** attach when the tmux session already runs (a Koloft restart, or a row the
   *  heartbeat lists as alive): no install, no new claude */
  mode: 'start' | 'attach'
}

/** The one line typed into the tab's local shell. */
export function launchLine(s: LaunchLineSpec): string {
  const opts = s.sshOptions.join(' ')
  const host = shq(s.host)
  const m = s.machine.name
  const tmp = `m.tmp.${s.tabId}`
  const probe = `ssh -n ${opts} ${host} 'test -d "$HOME/.koloft/${m}" && echo ok'`
  // the package is unpacked beside its final name and moved into place whole: a
  // second tab pushing the same hash at the same time loses the `test -d` race and
  // simply throws its copy away — no folder is ever half-written under a session
  // COPYFILE_DISABLE: macOS tar otherwise packs `._*` AppleDouble twins of every file
  const pushMachine =
    `COPYFILE_DISABLE=1 tar cf - -C ${shq(s.machine.dir)} . | ssh ${opts} ${host} ` +
    `'umask 077; mkdir -p "$HOME/.koloft" && cd "$HOME/.koloft" && rm -rf ${tmp} && mkdir ${tmp} ` +
    `&& tar xf - -C ${tmp} && sh -c "test -d ${m} || mv ${tmp} ${m}; rm -rf ${tmp}"'`
  const pushTab =
    `COPYFILE_DISABLE=1 tar cf - -C ${shq(s.tabDir)} . | ssh ${opts} ${host} ` +
    `'umask 077; mkdir -p "$HOME/.koloft/tabs" && tar xf - -C "$HOME/.koloft/tabs"'`
  const run = `ssh -tt ${opts} ${host} "sh \\"\\$HOME/.koloft/tabs/${s.tabId}.sh\\" $a"`
  return (
    `h=$(${probe}); { [ "$h" = ok ] || ${pushMachine}; } && ${pushTab} ` +
    `|| { echo '[Koloft] could not connect or push files — see the error above'; rm -rf ${shq(s.tabDir)}; exit 4; }; ` +
    // a failed start (install stopped, dir missing, session gone) keeps the tab open
    // until Enter — the reason is on screen and would vanish with the tab
    `rm -rf ${shq(s.tabDir)}; a=${s.mode}; while :; do ${run}; c=$?; [ "$c" = 255 ] || { ` +
    `[ "$c" = 0 ] || { echo "[Koloft] the session did not start (exit $c) — see above; press Enter to close"; read -r _; }; exit "$c"; }; ` +
    // the link died with claude's terminal modes still on (mouse reporting, bracketed
    // paste, alternate screen): turn them off or the local shell echoes every mouse
    // move as text, then start the notice on a clean screen — tmux redraws it all on
    // re-attach anyway
    `a=attach; printf '\\033[?1000l\\033[?1002l\\033[?1003l\\033[?1006l\\033[?2004l\\033[?25h\\033[?1049l'; clear; ` +
    `echo '[Koloft] connection lost, reconnecting in 2s…'; sleep 2; done`
  )
}

/** the background command that ends a session for good (⌘W, ⇧⌘R, workspace removal) */
export function killSessionCmd(tmuxName: string): string {
  return `sh -c '${REMOTE_PATH_LINE}; tmux -L koloft kill-session -t ${tmuxName}'`
}
