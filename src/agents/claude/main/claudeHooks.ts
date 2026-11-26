import fs from 'fs'
import path from 'path'
import type { StatusLineSetting } from '../../../main/statuslineParts'
import { shq } from '@shared/shellQuote'
import { BUTLER_SAYS_OPENING } from '@shared/agentGuide'
import { DISCORD_PREFIX } from '@plugins/discord/api'
import { A_HELPER_HAS_IT } from '@plugins/sessions/main/messageOpenings'
import {
  NOT_FROM_THE_RELAY,
  NOT_SENT_BY_KOLOFT,
  OPENINGS_ONLY_KOLOFT_SENDS
} from '@plugins/sessions/main/hooks'
import {
  languageFns,
  opensLike,
  QUOTE_PROMPT_FN,
  QUOTE_UNLESS_KOLOFT_SAVED_THE_OWNERS_WORDS,
  REMIND_AFTER_A_TOOL,
  REMIND_REPLY_LANGUAGE_FN,
  SHELL_WRITES_FNS,
  SHELL_WROTE_EVENT,
  shellCall,
  STALE_PR_STATUS_FN,
  type WhatTheUserReads
} from '@agents/kit/main/hookScriptParts'
import {
  NOTICE_SUFFIX,
  SENT_IDS_SUFFIX,
  STATUS_LOG_SUFFIX,
  statusLogOf
} from '../../../main/hookFiles'

export interface ClaudeHookPaths {
  hookScript: string
  settingsDir: string
  regDir: string
}

// CC§25
const NOTES_COMMAND_TITLES_AND_REPLY: WhatTheUserReads = {
  all: 'the short notes between tool calls, the description of each Bash command, and your final reply',
  next: 'the next note, the description of each Bash command and everything else'
}
const FROM_DISCORD = `${DISCORD_PREFIX} `
const WORDS_THAT_ASK_NOTHING = shq(A_HELPER_HAS_IT)

export const START_IN_STATUS_LOG = 'inStatusLog'
export const FROM_SESSION_FIELD = 'fromSession'
export const TO_SESSION_FIELD = 'toSession'
export const SENT_TO_A_SESSION_EVENT = 'sent'

const ASK_WAITS_UP_TO_AN_HOUR_S = 3600
const ASK_GIVES_UP_A_MINUTE_BEFORE_CLAUDE_ENDS_IT_S = ASK_WAITS_UP_TO_AN_HOUR_S - 60

// CC§1
export const HOOK_SCRIPT = `#!/usr/bin/env bash
SECONDS=0
reg="$1"; tab="$2"; event="$3"
[ -z "$reg" ] && exit 0
[ -z "$tab" ] && exit 0
# CC§14
[ "$event" = "ask" ] && { [ ! -f "$reg/$tab.answerable" ] || [ -f "$reg/$tab.typed" ]; } && event="asked"
said="$reg/$tab.said"
notice="$reg/$tab${NOTICE_SUFFIX}"
log="$reg/$tab${STATUS_LOG_SUFFIX}"
${languageFns(NOTES_COMMAND_TITLES_AND_REPLY)}
${REMIND_REPLY_LANGUAGE_FN}
if [ "$event" = "tool" ]; then
  ${REMIND_AFTER_A_TOOL}
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
# CC§11 CC§13
session_taking_messages() {
  hit=""
  for f in "$HOME"/.claude/sessions/*.json; do
    p="\${f##*/}"
    kill -0 "\${p%.json}" 2>/dev/null || continue
    grep -qF -- "$1" "$f" 2>/dev/null || continue
    s="$(sed -n 's/.*"sessionId"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$f" | tr -cd 'A-Za-z0-9-')"
    [ -n "$hit" ] && [ "$s" != "$hit" ] && return 0
    hit="$s"
  done
  printf '%s' "$hit"
}
${QUOTE_PROMPT_FN}
${STALE_PR_STATUS_FN}
${SHELL_WRITES_FNS}
log_ask() {
  printf '{"tabId":"%s","event":"ask","sessionId":"%s","tmux":"%s","ask":%s}\\n' "$tab" "$(session_id)" "$tm" "$input" >> "$log"
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
    if [ "$event" = "start" ] && [ "$KOLOFT_TMUX_FOLLOW" = "1" ] && [ -n "$TMUX" ] && [ -n "$sid" ]; then
      # ADR-0044
      nf="$HOME/.koloft/tabs/$tab.tmux"
      was="$(cat "$nf" 2>/dev/null)"
      printf 'k-%s' "$sid" > "$nf"
      if ! tmux rename-session -t "$TMUX_PANE" "k-$sid" 2>/dev/null; then
        if [ -n "$was" ]; then printf '%s' "$was" > "$nf"; else rm -f "$nf"; fi
      fi
    fi
    logged=""
    [ "$event" = "start" ] && logged=',"${START_IN_STATUS_LOG}":true'
    note="$(printf '{"tabId":"%s","event":"%s","sessionId":"%s","transcriptPath":"%s","cwd":"%s","reason":"%s","source":"%s","account":"%s","tmux":"%s"%s}' "$tab" "$event" "$sid" "$tp" "$cwd" "$reason" "$src" "$acct" "$tm" "$logged")"
    printf '%s\\n' "$note" > "$reg/$tab.json"
    # CC§1
    [ "$event" = "start" ] && printf '%s\\n' "$note" >> "$log"
    # CC§1
    if [ "$event" = "start" ] && [ "$src" = "compact" ]; then
      printf '{"tabId":"%s","event":"compacted","sessionId":"%s","tmux":"%s"}\\n' "$tab" "$sid" "$tm" >> "$log"
    fi
    # CC§13
    if [ "$event" = "start" ] && [ -f "$reg/$tab.conductor" ]; then cat "$reg/$tab.conductor"; fi
    ;;
  compacting)
    # CC§1
    trigger="$(printf '%s' "$input" | sed -n 's/.*"trigger"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | tr -d '"\\\\[:cntrl:]')"
    printf '{"tabId":"%s","event":"compacting","sessionId":"%s","trigger":"%s","tmux":"%s"}\\n' "$tab" "$(session_id)" "$trigger" "$tm" >> "$log"
    ;;
  ask)
    # CC§14
    ask="$reg/$tab.$$.ask.json"; answer="$reg/$tab.$$.answer.json"; tick="$reg/$tab.$$.tick"
    trap 'rm -f "$ask" "$answer" "$tick"' EXIT
    trap 'exit 143' TERM
    mkfifo "$tick" 2>/dev/null || exit 0
    printf '%s' "$input" > "$ask.tmp" && mv "$ask.tmp" "$ask"
    while [ ! -f "$answer" ]; do
      if [ "$SECONDS" -ge "\${KOLOFT_ASK_GIVES_UP_AFTER_S:-${ASK_GIVES_UP_A_MINUTE_BEFORE_CLAUDE_ENDS_IT_S}}" ]; then
        rm -f "$ask"
        read -t 1 <> "$tick"
        [ -f "$answer" ] && break
        log_ask
        exit 0
      fi
      read -t 1 <> "$tick"
    done
    cat "$answer"
    ;;
  asked)
    # CC§14
    log_ask
    ;;
  posttool) stale_pr_status "$input" ;;
  ${SENT_TO_A_SESSION_EVENT})
    # CC§13
    case "$input" in
      *'"tool_response":{"success":true'*) ;;
      *) exit 0 ;;
    esac
    to="$(printf '%s' "$input" | LC_ALL=C sed -n -E 's/.*"tool_input":\\{([^{}]*,)?"to":"([^"\\\\]*)".*/\\2/p')"
    to="\${to% \\[*\\]}"
    case "$to" in
      '') exit 0 ;;
      uds:*) key="\\"messagingSocketPath\\":\\"\${to#uds:}\\"" ;;
      *) key="\\"name\\":\\"$to\\"" ;;
    esac
    target="$(session_taking_messages "$key")"
    [ -n "$target" ] && printf '{"tabId":"%s","event":"${SENT_TO_A_SESSION_EVENT}","sessionId":"%s","tmux":"%s","${TO_SESSION_FIELD}":"%s"}\\n' "$tab" "$(session_id)" "$tm" "$target" >> "$log"
    ;;
  shell-before) ${shellCall('tool_use_id')}; shell_before "$where" "$key" ;;
  shell-after)
    ${shellCall('tool_use_id')}
    wrote="$(shell_wrote "$where" "$key")"
    [ -n "$wrote" ] && printf '{"tabId":"%s","event":"${SHELL_WROTE_EVENT}","sessionId":"%s","tmux":"%s"%s}\\n' "$tab" "$(session_id)" "$tm" "$wrote" >> "$log"
    ;;
  prompt|stop|notify)
    [ "$event" = "stop" ] && keep_going_for_the_notice && exit 0
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
    crons=""
    case "$input" in
      *[,{]'"session_crons":[]'*) crons=',"crons":[]' ;;
      *[,{]'"session_crons":['*)
        crons="$(printf '%s' "$input" | LC_ALL=C awk '
          {
            key = ",\\"session_crons\\":"
            k = index($0, key "[")
            if (k == 0) k = index($0, "{\\"session_crons\\":[")
            if (k == 0) exit
            s = substr($0, k + length(key))
            depth = 0; instr = 0; esc = 0; n = length(s)
            for (i = 1; i <= n; i++) {
              c = substr(s, i, 1)
              if (esc) { esc = 0; continue }
              if (c == "\\\\") { esc = 1; continue }
              if (c == "\\"") { instr = 1 - instr; continue }
              if (instr) continue
              if (c == "[") depth++
              else if (c == "]") { depth--; if (depth == 0) { print ",\\"crons\\":" substr(s, 1, i); exit } }
            }
          }')"
        ;;
    esac
    # CC§13
    from=""
    case "$input" in
      *'"prompt":"<cross-session-message from=\\"uds:'*)
        sock="$(printf '%s' "$input" | LC_ALL=C sed -n -E 's/.*"prompt":"<cross-session-message from=."uds:([^"\\\\]+).".*/\\1/p')"
        from="$(session_taking_messages "\\"messagingSocketPath\\":\\"$sock\\"")"
        [ -n "$from" ] && from=',"${FROM_SESSION_FIELD}":"'"$from"'"'
        ;;
    esac
    printf '{"tabId":"%s","event":"%s","sessionId":"%s","message":"%s","tmux":"%s"%s%s%s}\\n' "$tab" "$event" "$sid" "$msg" "$tm" "$bgl" "$crons" "$from" >> "$log"
    if [ "$event" = "prompt" ]; then
      # CC§13 CC§19 ADR-0028
      flag=""
      id="$(printf '%s' "$input" | LC_ALL=C sed -n -E 's/.*\\\\n\\(Koloft message ([A-Za-z0-9-]+)\\)\\\\n<\\/cross-session-message>".*/\\1/p')"
      sent=""
      case "$input" in
        *'"prompt":"<cross-session-message from-mode=\\"'*)
          [ -n "$id" ] && grep -qxF "$id" "$reg/$tab${SENT_IDS_SUFFIX}" 2>/dev/null && sent=1 ;;
      esac
      case "$(prompt_body | LC_ALL=C sed -E 's/^<cross-session-message( [a-z-]+=\\\\"[^"\\\\]*\\\\")*>\\\\n//')" in
        ${WORDS_THAT_ASK_NOTHING}) ;;
        ${opensLike(OPENINGS_ONLY_KOLOFT_SENDS)}) [ -n "$sent" ] || flag=${shq(NOT_SENT_BY_KOLOFT)} ;;
        ${opensLike([FROM_DISCORD])})
          if [ -n "$sent" ]; then save_quote; else flag=${shq(NOT_FROM_THE_RELAY)}; fi ;;
        *)
          case "$input" in
            *'"prompt":"<cross-session-message '*|*'"prompt":"<task-notification>'*|*'"prompt":"<agent-message '*) ;;
            *)
              ${QUOTE_UNLESS_KOLOFT_SAVED_THE_OWNERS_WORDS}
              [ -f "$reg/$tab.conductor" ] && : > "$reg/$tab.typed"
              ;;
          esac ;;
      esac
      remind_reply_language UserPromptSubmit "$flag"
    fi
    # CC§13 CC§14
    [ "$event" = "stop" ] && rm -f "$reg/$tab.typed"
    ;;
esac
exit 0
`

export function writeClaudeHookScript(hookDir: string): string {
  const hookScript = path.join(hookDir, 'sessionstart.sh')
  fs.writeFileSync(hookScript, HOOK_SCRIPT, { mode: 0o755 })
  fs.chmodSync(hookScript, 0o755)
  return hookScript
}

// CC§8
const NOTIFICATIONS_WAITING_ON_THE_PERSON = [
  'permission_prompt',
  'worker_permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog'
].join('|')

// CC§6 CC§9 CC§14
export function hookSettings(
  hookScript: string,
  regDir: string,
  tabId: string,
  {
    statusLine,
    quote = shq,
    dialogs = 'wait-for-answer'
  }: {
    statusLine?: StatusLineSetting
    quote?: (s: string) => string
    dialogs?: 'wait-for-answer' | 'record-only'
  } = {}
): Record<string, unknown> {
  const cmd = (event: string): string =>
    `${quote(hookScript)} ${quote(regDir)} ${quote(tabId)} ${event}`
  const shellAfter = { matcher: 'Bash', hooks: [{ type: 'command', command: cmd('shell-after') }] }
  const settings: Record<string, unknown> = {
    skipDangerousModePermissionPrompt: true,
    env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '' },
    hooks: {
      // CC§15
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: cmd('shell-before') }] }],
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
        shellAfter,
        // CC§13
        {
          matcher: 'SendMessage',
          hooks: [{ type: 'command', command: cmd(SENT_TO_A_SESSION_EVENT) }]
        },
        ...(statusLine
          ? [{ matcher: 'Bash', hooks: [{ type: 'command', command: cmd('posttool') }] }]
          : [])
      ],
      PostToolUseFailure: [shellAfter]
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

export const KOLOFT_ALLOW_RULE = { allow: ['Bash(koloft *)'] }

// CC§24
const toolNamePartOf = (server: string): string => server.replace(/[^A-Za-z0-9_-]/g, '_')
// ADR-0048 CC§24
const allowEveryToolOf = (server: string): string => `mcp__${toolNamePartOf(server)}`

// CC§6
export function writeTabHookSettings(
  paths: ClaudeHookPaths,
  tabId: string,
  statusLine?: StatusLineSetting,
  allowKoloft = false,
  conductor = false,
  playwrightServers: string[] = []
): string {
  fs.rmSync(statusLogOf(paths.regDir, tabId), { force: true })
  fs.rmSync(path.join(paths.regDir, `${tabId}.json`), { force: true })
  const settings = hookSettings(paths.hookScript, paths.regDir, tabId, { statusLine })
  // CC§13 ADR-0048 CC§24
  const allow = [
    ...(allowKoloft ? KOLOFT_ALLOW_RULE.allow : []),
    ...playwrightServers.map(allowEveryToolOf)
  ]
  if (allow.length) settings.permissions = { allow }
  // CC§13 ADR-0028
  if (conductor) settings.crossSessionInbound = 'accept'
  const out = path.join(paths.settingsDir, `${tabId}.json`)
  fs.writeFileSync(out, JSON.stringify(settings))
  return out
}
