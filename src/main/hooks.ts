import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { StatusLineSetting } from './statusline'
import { shq } from '@shared/shellQuote'

export interface HookPaths {
  hookScript: string
  settingsDir: string
  regDir: string
}

// CC§1
export const HOOK_SCRIPT = `#!/usr/bin/env bash
reg="$1"; tab="$2"; event="$3"
[ -z "$reg" ] && exit 0
[ -z "$tab" ] && exit 0
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
    printf '{"tabId":"%s","event":"%s","sessionId":"%s","message":"%s","tmux":"%s"%s}\\n' "$tab" "$event" "$sid" "$msg" "$tm" "$bgl" >> "$reg/$tab.status.jsonl"
    ;;
esac
exit 0
`

function pruneStale(dir: string, maxAgeMs = 12 * 60 * 60 * 1000): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.jsonl')) continue
    const full = path.join(dir, name)
    try {
      if (now - fs.statSync(full).mtimeMs > maxAgeMs) fs.rmSync(full, { force: true })
    } catch {}
  }
}

export function setupHooks(): HookPaths {
  const base = app.getPath('userData')
  const hookDir = path.join(base, 'hooks')
  const settingsDir = path.join(hookDir, 'settings')
  const regDir = path.join(base, 'hook-sessions')

  fs.mkdirSync(settingsDir, { recursive: true })
  fs.mkdirSync(regDir, { recursive: true })
  pruneStale(regDir)
  pruneStale(settingsDir)

  const hookScript = path.join(hookDir, 'sessionstart.sh')
  fs.writeFileSync(hookScript, HOOK_SCRIPT, { mode: 0o755 })
  fs.chmodSync(hookScript, 0o755)

  return { hookScript, settingsDir, regDir }
}

// CC§6
export function hookSettings(
  hookScript: string,
  regDir: string,
  tabId: string,
  statusLine?: StatusLineSetting,
  quote: (s: string) => string = shq
): Record<string, unknown> {
  const cmd = (event: string): string =>
    `${quote(hookScript)} ${quote(regDir)} ${quote(tabId)} ${event}`
  const settings: Record<string, unknown> = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: cmd('start') }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: cmd('end') }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('prompt') }] }],
      Stop: [{ hooks: [{ type: 'command', command: cmd('stop') }] }],
      Notification: [{ hooks: [{ type: 'command', command: cmd('notify') }] }]
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

// CC§6
export function writeTabHookSettings(
  paths: HookPaths,
  tabId: string,
  statusLine?: StatusLineSetting
): string {
  fs.rmSync(path.join(paths.regDir, `${tabId}.status.jsonl`), { force: true })
  fs.rmSync(path.join(paths.regDir, `${tabId}.json`), { force: true })
  const settings = hookSettings(paths.hookScript, paths.regDir, tabId, statusLine)
  const out = path.join(paths.settingsDir, `${tabId}.json`)
  fs.writeFileSync(out, JSON.stringify(settings))
  return out
}
