import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { StatusLineSetting } from './statusline'
import { shq } from '@shared/shellQuote'
import { CONDUCTOR_GATE_SCRIPT, conductorGateCommand } from './conductorGate'

export interface HookPaths {
  hookScript: string
  gateScript: string
  settingsDir: string
  regDir: string
}

export const REPLY_LANGUAGE_REMINDER =
  "Reply in the language of the user's latest message, whatever language tool output, files or your earlier replies use."

// CC§16
const PROMPT_HOOK_OUTPUT = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: REPLY_LANGUAGE_REMINDER
  }
})

// CC§1
export const HOOK_SCRIPT = `#!/usr/bin/env bash
reg="$1"; tab="$2"; event="$3"
[ -z "$reg" ] && exit 0
[ -z "$tab" ] && exit 0
# CC§14
[ "$event" = "ask" ] && [ ! -f "$reg/$tab.answerable" ] && exit 0
input="$(cat | tr -d '\\n')"
mkdir -p "$reg" 2>/dev/null
tm=""
if [ "$KOLOFT_TMUX_FOLLOW" = "1" ] && [ -n "$TMUX" ]; then
  tm="$(tmux display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null | tr -d '"\\\\[:cntrl:]')"
fi
session_id() {
  printf '%s' "$input" |
    grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' |
    head -1 |
    sed 's/.*"\\([^"]*\\)"$/\\1/' |
    tr -d '"\\\\[:cntrl:]'
}
case "$event" in
  start|end)
    sid="$(session_id)"
    tp="$(printf '%s' "$input" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
    cwd="$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
    # CC§1
    reason="$(printf '%s' "$input" | sed -n 's/.*"reason"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
    # CC§1
    src="$(printf '%s' "$input" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
    # CC§5
    if [ "$event" = "start" ] && [ "$src" = "fork" ]; then exit 0; fi
    acct="$(printf '%s' "$ANT_ACCOUNT" | tr -d '"\\\\[:cntrl:]')"
    # CC§1
    ver="$(basename "$CLAUDE_CODE_EXECPATH" 2>/dev/null)"
    case "$ver" in ''|*[!0-9.]*) ver="";; esac
    if [ -z "$ver" ]; then
      ver="$(printf '%s' "$AI_AGENT" | sed -n 's/^claude-code_\\([0-9-]*\\)_agent$/\\1/p' | tr '-' '.')"
    fi
    if [ "$event" = "start" ] && [ "$KOLOFT_TMUX_FOLLOW" = "1" ] && [ -n "$TMUX" ] && [ -n "$sid" ]; then
      tmux rename-session -t "$TMUX_PANE" "k-$sid" 2>/dev/null
    fi
    printf '{"tabId":"%s","event":"%s","sessionId":"%s","transcriptPath":"%s","cwd":"%s","reason":"%s","source":"%s","account":"%s","ccVersion":"%s","tmux":"%s"}\\n' "$tab" "$event" "$sid" "$tp" "$cwd" "$reason" "$src" "$acct" "$ver" "$tm" > "$reg/$tab.json"
    # CC§1
    if [ "$event" = "start" ] && [ "$src" = "compact" ]; then
      printf '{"tabId":"%s","event":"compacted","sessionId":"%s","tmux":"%s"}\\n' "$tab" "$sid" "$tm" >> "$reg/$tab.status.jsonl"
    fi
    # CC§13
    if [ "$event" = "start" ] && [ -f "$reg/$tab.conductor" ]; then cat "$reg/$tab.conductor"; fi
    ;;
  compacting)
    # CC§1
    printf '{"tabId":"%s","event":"compacting","sessionId":"%s","tmux":"%s"}\\n' "$tab" "$(session_id)" "$tm" >> "$reg/$tab.status.jsonl"
    ;;
  ask)
    # CC§14
    ask="$reg/$tab.$$.ask.json"; answer="$reg/$tab.$$.answer.json"; tick="$reg/$tab.$$.tick"
    trap 'rm -f "$ask" "$answer" "$tick"' EXIT
    trap 'exit 143' TERM
    mkfifo "$tick" 2>/dev/null || exit 0
    printf '%s' "$input" > "$ask.tmp" && mv "$ask.tmp" "$ask"
    while [ ! -f "$answer" ]; do read -t 1 <> "$tick"; done
    cat "$answer"
    ;;
  asked)
    # CC§14
    printf '{"tabId":"%s","event":"ask","sessionId":"%s","tmux":"%s","ask":%s}\\n' "$tab" "$(session_id)" "$tm" "$input" >> "$reg/$tab.status.jsonl"
    ;;
  posttool)
    # PLATFORM§36
    printf '%s' "$input" | grep -qE 'gh pr (create|merge|close|reopen|ready|edit)' || exit 0
    for f in "$HOME/.cache/ccstatusline/git-review/"*.json; do
      [ -e "$f" ] && touch -t 200001010000 "$f" 2>/dev/null
    done
    ;;
  prompt|stop|notify)
    msg="$(printf '%s' "$input" | sed -n 's/.*"message"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | tr -d '"\\\\[:cntrl:]')"
    sid="$(session_id)"
    # CC§8
    bgl=""
    case "$input" in
      *'"background_tasks"'*)
        bgl="$(printf '%s' "$input" | awk '
          {
            key = "\\"background_tasks\\":["
            k = index($0, key)
            if (k == 0) exit
            s = substr($0, k + length(key))
            depth = 1; instr = 0; esc = 0; end = 0
            for (i = 1; i <= length(s); i++) {
              c = substr(s, i, 1)
              if (esc) { esc = 0; continue }
              if (c == "\\\\") { esc = 1; continue }
              if (c == "\\"") { instr = 1 - instr; continue }
              if (instr) continue
              if (c == "[") depth++
              else if (c == "]") { depth--; if (depth == 0) { end = i; break } }
            }
            if (end == 0) end = length(s)
            arr = substr(s, 1, end)
            list = ""
            depth = 0; instr = 0; esc = 0; start = 0
            for (i = 1; i <= length(arr); i++) {
              c = substr(arr, i, 1)
              if (esc) { esc = 0; continue }
              if (c == "\\\\") { esc = 1; continue }
              if (c == "\\"") { instr = 1 - instr; continue }
              if (instr) continue
              if (c == "{") { if (depth == 0) start = i; depth++ }
              else if (c == "}") {
                depth--
                if (depth == 0 && start > 0) {
                  obj = substr(arr, start, i - start + 1)
                  st = field(obj, "status")
                  if (st !~ /^(completed|failed|killed|stopped|cancelled|canceled)$/) {
                    id = field(obj, "id"); gsub(/[^A-Za-z0-9_-]/, "", id)
                    ty = tolower(field(obj, "type")); gsub(/ /, "-", ty); gsub(/[^a-z0-9-]/, "", ty)
                    list = list (list == "" ? "" : ",") id ":" ty
                  }
                }
              }
            }
            print ",\\"bgl\\":\\"" list "\\""
          }
          function field(o, name,    v) {
            if (!match(o, "\\"" name "\\"[ \\t]*:[ \\t]*\\"[^\\"]*\\"")) return ""
            v = substr(o, RSTART, RLENGTH)
            sub(/^"[a-z]*"[ \\t]*:[ \\t]*"/, "", v)
            sub(/"$/, "", v)
            return v
          }')"
        ;;
    esac
    # CC§8
    wake=""
    case "$input" in
      *'"session_crons":[]'*) wake=',"wake":0' ;;
      *'"session_crons":['*) wake=',"wake":1' ;;
    esac
    printf '{"tabId":"%s","event":"%s","sessionId":"%s","message":"%s","tmux":"%s"%s%s}\\n' "$tab" "$event" "$sid" "$msg" "$tm" "$bgl" "$wake" >> "$reg/$tab.status.jsonl"
    # CC§16
    if [ "$event" = "prompt" ]; then printf '%s\\n' ${shq(PROMPT_HOOK_OUTPUT)}; fi
    ;;
esac
exit 0
`

export function pruneStale(dir: string, maxAgeMs = 12 * 60 * 60 * 1000, everyEntry = false): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    if (!everyEntry && !name.endsWith('.json') && !name.endsWith('.jsonl')) continue
    const full = path.join(dir, name)
    try {
      if (now - fs.statSync(full).mtimeMs > maxAgeMs)
        fs.rmSync(full, { recursive: everyEntry, force: true })
    } catch {}
  }
}

const TAB_MARKER = /^(.+)\.(answerable|conductor)$/

// ADR-0004
function pruneMarkersOfDeadTabs(regDir: string, peerOwnsTab: (tabId: string) => boolean): void {
  let names: string[]
  try {
    names = fs.readdirSync(regDir)
  } catch {
    return
  }
  for (const name of names) {
    const tabId = TAB_MARKER.exec(name)?.[1]
    if (tabId && !peerOwnsTab(tabId)) fs.rmSync(path.join(regDir, name), { force: true })
  }
}

export function setupHooks(peerOwnsTab: (tabId: string) => boolean): HookPaths {
  const base = app.getPath('userData')
  const hookDir = path.join(base, 'hooks')
  const settingsDir = path.join(hookDir, 'settings')
  const regDir = path.join(base, 'hook-sessions')

  fs.mkdirSync(settingsDir, { recursive: true })
  fs.mkdirSync(regDir, { recursive: true })
  pruneStale(regDir)
  pruneStale(settingsDir)
  pruneMarkersOfDeadTabs(regDir, peerOwnsTab)

  const hookScript = path.join(hookDir, 'sessionstart.sh')
  fs.writeFileSync(hookScript, HOOK_SCRIPT, { mode: 0o755 })
  fs.chmodSync(hookScript, 0o755)
  const gateScript = path.join(hookDir, 'conductor-gate.js')
  fs.writeFileSync(gateScript, CONDUCTOR_GATE_SCRIPT)

  return { hookScript, gateScript, settingsDir, regDir }
}

// CC§8
const NOTIFICATIONS_WAITING_ON_THE_PERSON = [
  'permission_prompt',
  'worker_permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog'
].join('|')

const ASK_WAITS_UP_TO_AN_HOUR_S = 3600

// CC§6 CC§14
export function hookSettings(
  hookScript: string,
  regDir: string,
  tabId: string,
  statusLine?: StatusLineSetting,
  quote: (s: string) => string = shq,
  dialogs: 'wait-for-answer' | 'record-only' = 'wait-for-answer'
): Record<string, unknown> {
  const cmd = (event: string): string =>
    `${quote(hookScript)} ${quote(regDir)} ${quote(tabId)} ${event}`
  const settings: Record<string, unknown> = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: cmd('start') }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: cmd('end') }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('prompt') }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: cmd('compacting') }] }],
      Stop: [{ hooks: [{ type: 'command', command: cmd('stop') }] }],
      Notification: [
        {
          matcher: NOTIFICATIONS_WAITING_ON_THE_PERSON,
          hooks: [{ type: 'command', command: cmd('notify') }]
        }
      ],
      PermissionRequest: [
        {
          matcher: '*',
          hooks: [
            dialogs === 'wait-for-answer'
              ? { type: 'command', command: cmd('ask'), timeout: ASK_WAITS_UP_TO_AN_HOUR_S }
              : { type: 'command', command: cmd('asked') }
          ]
        }
      ]
    }
  }
  if (statusLine) {
    settings.statusLine = statusLine
    ;(settings.hooks as Record<string, unknown>).PostToolUse = [
      { matcher: 'Bash', hooks: [{ type: 'command', command: cmd('posttool') }] }
    ]
  }
  return settings
}

function conductorMarker(regDir: string, tabId: string): string {
  return path.join(regDir, `${tabId}.conductor`)
}

// CC§13
export function writeConductorMarker(regDir: string, tabId: string, role: string): void {
  const output = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: role } }
  fs.writeFileSync(conductorMarker(regDir, tabId), JSON.stringify(output))
}

export function removeConductorMarker(regDir: string, tabId: string): void {
  fs.rmSync(conductorMarker(regDir, tabId), { force: true })
}

export function markAnswerable(regDir: string, tabId: string, on: boolean): void {
  const file = path.join(regDir, `${tabId}.answerable`)
  if (on) fs.writeFileSync(file, '')
  else fs.rmSync(file, { force: true })
}

// CC§6
export function writeTabHookSettings(
  paths: HookPaths,
  tabId: string,
  statusLine?: StatusLineSetting,
  allowKoloft = false,
  conductor = false
): string {
  fs.rmSync(path.join(paths.regDir, `${tabId}.status.jsonl`), { force: true })
  fs.rmSync(path.join(paths.regDir, `${tabId}.json`), { force: true })
  const settings = hookSettings(paths.hookScript, paths.regDir, tabId, statusLine)
  // CC§13
  if (allowKoloft) settings.permissions = { allow: ['Bash(koloft *)'] }
  // ADR-0029 CC§15
  if (conductor)
    (settings.hooks as Record<string, unknown>).PreToolUse = [
      {
        matcher: '*',
        hooks: [{ type: 'command', command: conductorGateCommand(paths.gateScript) }]
      }
    ]
  const out = path.join(paths.settingsDir, `${tabId}.json`)
  fs.writeFileSync(out, JSON.stringify(settings))
  return out
}
