import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { StatusLineSetting } from './statusline'
import { shq } from '@shared/shellQuote'
import {
  CODEX_CONDUCTOR_GATE_SCRIPT,
  CONDUCTOR_GATE_SCRIPT,
  codexGateShell,
  conductorGateCommand
} from './conductorGate'
import { HANDOVER_OPENING, OWNER_WORDS_BEFORE_QUOTE, OWNER_WORDS_END } from './handover'
import { FROM_A_SESSION, type ModeClass } from './crossSessionMessage'
import { DISCORD_PREFIX } from '@shared/agentGuide'

export interface HookPaths {
  hookScript: string
  gateScript: string
  codexGate: string
  codexReplyLanguage: string
  settingsDir: string
  regDir: string
}

// ADR-0031
const REPLY_LANGUAGE_BEFORE_QUOTE = "The user's latest message begins: «"
const REPLY_LANGUAGE_AFTER_QUOTE =
  '». Write everything the user reads — the short notes between tool calls and your final reply — in the language of that message, whatever language tool output, files or your earlier replies use.'
const QUOTED_PROMPT_BYTES = 300
// ADR-0028
const NOT_FROM_THE_RELAY = `Koloft: this ${DISCORD_PREFIX} message was not sent by Koloft's Discord relay, so it is not the owner's words. `
const fromTheRelay = (mode: ModeClass): string =>
  `*'"prompt":"<cross-session-message from-mode=\\"${mode}\\">\\n${DISCORD_PREFIX} '*`

// CC§17 CC§19 CODEX§27
const REMIND_REPLY_LANGUAGE_FN = `remind_reply_language() {
  quote="$(cat "$said" 2>/dev/null)"
  context="$2"
  [ -n "$quote" ] && context="$context"${shq(REPLY_LANGUAGE_BEFORE_QUOTE)}"$quote"${shq(REPLY_LANGUAGE_AFTER_QUOTE)}
  [ -n "$context" ] || return 0
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\\n' "$1" "$context"
}`

// CC§19
const QUOTE_PROMPT_FN = `quote_prompt() {
  printf '%s' "$input" |
    LC_ALL=C sed -n -E 's/.*"prompt"[[:space:]]*:[[:space:]]*"(([^"\\\\]|\\\\.)*)".*/\\1/p' |
    LC_ALL=C sed -E -e 's/^${HANDOVER_OPENING}.*${OWNER_WORDS_BEFORE_QUOTE}(.*)${OWNER_WORDS_END}.*$/\\1/' \\
      -e 's/^${HANDOVER_OPENING}.*koloft session send [^ ]+ \\\\"<your result>\\\\"\\\\n\\\\n//' \\
      -e 's/^<cross-session-message from-mode=\\\\"[a-z]+\\\\">\\\\n\\[Discord\\] //' \\
      -e 's/\\\\n\\(Koloft message [A-Za-z0-9-]+\\)\\\\n<\\/cross-session-message>$//' |
    head -c ${QUOTED_PROMPT_BYTES} |
    LC_ALL=C sed -E -e $'s/([\\xc0-\\xdf]|[\\xe0-\\xef][\\x80-\\xbf]?|[\\xf0-\\xf7][\\x80-\\xbf]{0,2})$//' \\
      -e 's/\\\\u[0-9a-fA-F]{0,3}$//' -e 's/(^|[^\\\\])((\\\\\\\\)*)\\\\$/\\1\\2/'
}`

export const CODEX_SAID_ENV = 'KOLOFT_CODEX_SAID'
const HANDED_OVER_TASK_COMES_FIRST = '.task-first'
export const CODEX_REPLY_LANGUAGE_ENV = 'KOLOFT_CODEX_REPLY_LANGUAGE'
const codexReplyLanguageHook = (event: string): string =>
  `sh "$${CODEX_REPLY_LANGUAGE_ENV}" ${event}`
export const CODEX_REPLY_LANGUAGE_HOOKS = [
  { event: 'UserPromptSubmit', command: codexReplyLanguageHook('prompt') },
  { event: 'PostToolUse', command: codexReplyLanguageHook('tool') }
]

// ADR-0031 CODEX§27
export const CODEX_REPLY_LANGUAGE_SCRIPT = `#!/usr/bin/env bash
said="$${CODEX_SAID_ENV}"
[ -n "$said" ] || exit 0
${REMIND_REPLY_LANGUAGE_FN}
if [ "$1" = "tool" ]; then
  cat >/dev/null
  remind_reply_language PostToolUse
  exit 0
fi
input="$(cat | tr -d '\\n')"
${QUOTE_PROMPT_FN}
case "$input" in
  *'"prompt":"${FROM_A_SESSION}'*) ;;
  *) if [ -f "$said${HANDED_OVER_TASK_COMES_FIRST}" ]; then
       rm -f "$said${HANDED_OVER_TASK_COMES_FIRST}"
     else
       quote_prompt > "$said"
     fi ;;
esac
remind_reply_language UserPromptSubmit
exit 0
`

// ADR-0031
export function seedCodexOwnerWords(said: string, ownerWords: string): void {
  fs.writeFileSync(said, JSON.stringify(ownerWords).slice(1, -1))
  fs.writeFileSync(said + HANDED_OVER_TASK_COMES_FIRST, '')
}

// CC§1
export const HOOK_SCRIPT = `#!/usr/bin/env bash
reg="$1"; tab="$2"; event="$3"
[ -z "$reg" ] && exit 0
[ -z "$tab" ] && exit 0
# CC§14
[ "$event" = "ask" ] && { [ ! -f "$reg/$tab.answerable" ] || [ -f "$reg/$tab.typed" ]; } && event="asked"
said="$reg/$tab.said"
${REMIND_REPLY_LANGUAGE_FN}
if [ "$event" = "tool" ]; then
  cat >/dev/null
  remind_reply_language PostToolUse
  exit 0
fi
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
${QUOTE_PROMPT_FN}
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
    if [ "$event" = "prompt" ]; then
      # CC§13 CC§19 ADR-0028
      flag=""
      case "$input" in
        ${fromTheRelay('bypass')}|${fromTheRelay('prompting')})
          id="$(printf '%s' "$input" | LC_ALL=C sed -n -E 's/.*\\\\n\\(Koloft message ([A-Za-z0-9-]+)\\)\\\\n<\\/cross-session-message>".*/\\1/p')"
          if [ -n "$id" ] && grep -qxF "$id" "$reg/$tab.discord-ids" 2>/dev/null; then
            quote_prompt > "$said"
          else
            flag=${shq(NOT_FROM_THE_RELAY)}
          fi
          ;;
        *'"prompt":"<cross-session-message '*|*'"prompt":"<task-notification>'*|*'"prompt":"<agent-message '*) ;;
        *)
          quote_prompt > "$said"
          [ -f "$reg/$tab.conductor" ] && : > "$reg/$tab.typed"
          ;;
      esac
      remind_reply_language UserPromptSubmit "$flag"
    fi
    # CC§13 CC§14
    [ "$event" = "stop" ] && rm -f "$reg/$tab.typed"
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

const TAB_MARKER = /^(.+)\.(answerable|conductor|said|allow|typed|discord-ids)$/

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
  const codexGateScript = path.join(hookDir, 'codex-conductor-gate.js')
  fs.writeFileSync(codexGateScript, CODEX_CONDUCTOR_GATE_SCRIPT)
  const codexGate = path.join(hookDir, 'codex-conductor-gate.sh')
  fs.writeFileSync(codexGate, codexGateShell(codexGateScript))
  const codexReplyLanguage = path.join(hookDir, 'codex-reply-language.sh')
  fs.writeFileSync(codexReplyLanguage, CODEX_REPLY_LANGUAGE_SCRIPT)

  return { hookScript, gateScript, codexGate, codexReplyLanguage, settingsDir, regDir }
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

// CC§6 CC§9 CC§14
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
    skipDangerousModePermissionPrompt: true,
    env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '' },
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
      ],
      // CC§19 ADR-0031
      PostToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: cmd('tool') }] },
        ...(statusLine
          ? [{ matcher: 'Bash', hooks: [{ type: 'command', command: cmd('posttool') }] }]
          : [])
      ]
    }
  }
  if (statusLine) settings.statusLine = statusLine
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

function allowFile(regDir: string, tabId: string): string {
  return path.join(regDir, `${tabId}.allow`)
}

export function discordIdsFile(regDir: string, tabId: string): string {
  return path.join(regDir, `${tabId}.discord-ids`)
}

// ADR-0031
export function quotedPrompt(regDir: string, tabId: string): string | undefined {
  let escaped: string
  try {
    escaped = fs.readFileSync(path.join(regDir, `${tabId}.said`), 'utf8').trimEnd()
  } catch {
    return undefined
  }
  try {
    return JSON.parse(`"${escaped}"`) || undefined
  } catch {
    return undefined
  }
}

export function writeAllowFile(regDir: string, tabId: string, allow: readonly string[]): string {
  const file = allowFile(regDir, tabId)
  fs.writeFileSync(file, JSON.stringify(allow))
  return file
}

export function markAnswerable(regDir: string, tabId: string, on: boolean): void {
  const file = path.join(regDir, `${tabId}.answerable`)
  if (on) fs.writeFileSync(file, '')
  else fs.rmSync(file, { force: true })
}

export function forgetAssistMarkers(regDir: string, tabId: string): void {
  for (const file of [
    allowFile(regDir, tabId),
    discordIdsFile(regDir, tabId),
    path.join(regDir, `${tabId}.typed`)
  ])
    fs.rmSync(file, { force: true })
}

export const KOLOFT_ALLOW_RULE = { allow: ['Bash(koloft *)'] }

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
  if (allowKoloft) settings.permissions = KOLOFT_ALLOW_RULE
  if (conductor) {
    // ADR-0029 CC§15
    ;(settings.hooks as Record<string, unknown>).PreToolUse = [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: conductorGateCommand(paths.gateScript, allowFile(paths.regDir, tabId))
          }
        ]
      }
    ]
    // CC§13 ADR-0028
    settings.crossSessionInbound = 'accept'
  }
  const out = path.join(paths.settingsDir, `${tabId}.json`)
  fs.writeFileSync(out, JSON.stringify(settings))
  return out
}
