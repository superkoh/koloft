import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { StatusLineSetting } from './statusline'
import type { KoloftHook } from './codexLaunchConfig'
import { shq } from '@shared/shellQuote'
import { HANDOVER_OPENING, OWNER_WORDS_QUOTED_CHARS } from './handover'
import { FROM_A_SESSION, FROM_KOLOFT, type ModeClass } from './crossSessionMessage'
import { DISCORD_PREFIX } from '@shared/agentGuide'
import { REMOTE_HOOK_DIR } from './remote/paths'
import { writeWholeBeforeVisible } from './jsonDrops'
import {
  CODEX_HOLDS_LESS_THAN_ITS_EXEC_WALL_S,
  HOLD_HOOK_TIMEOUT_S,
  HOLD_SCRIPT
} from './resourceGuard'

export type HoldEvent = 'hold' | 'hold-self'

export interface HookPaths {
  hookScript: string
  codexReplyLanguage: string
  hold: string
  settingsDir: string
  regDir: string
}

export interface HoldScript {
  file: string
  regDir: string
}

export const HOLD_FILE = 'hold.sh'
export const HOLD_TAB_ENV = 'KOLOFT_HOLD_TAB'

// ADR-0031
export const REPLY_LANGUAGE_BEFORE_QUOTE = "The user's latest message begins: «"
const WRITE_EVERYTHING_IN =
  'Write everything the user reads — the short notes between tool calls and your final reply — in '
const WHATEVER_ELSE = ', whatever language tool output, files or your earlier replies use.'
export const REPLY_LANGUAGE_AFTER_QUOTE = `». ${WRITE_EVERYTHING_IN}the language of that message${WHATEVER_ELSE}`
const WRITE_IN_THE_NAMED_LANGUAGE = `${shq('The user writes ')}"$lang"${shq(`. ${WRITE_EVERYTHING_IN}`)}"$lang"${shq(WHATEVER_ELSE)}`
const LAST_NOTE_IS_NOT_IN_IT = `${shq('Your last note to the user, «')}"$note"${shq('», is not in ')}"$lang"${shq('. The user writes ')}"$lang"${shq(': write the next note and everything else the user reads in ')}"$lang"${shq(WHATEVER_ELSE)}`
export const QUOTED_PROMPT_BYTES = 300
export const QUOTED_NOTE_BYTES = 150
export const TRANSCRIPT_LINES_SEARCHED_FOR_THE_LAST_NOTE = 100
const WORDS_THAT_SHOW_A_LANGUAGE = 3
export const JSON_STRING_BODY = '(([^"\\\\]|\\\\.)*)'
const ASSISTANT_TEXT_RECORD = '"role":"assistant","content":\\[\\{"type":"(output_)?text","text":"'
const TRANSCRIPT_PATH_FIELD = `'"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"'`
// ADR-0028
const NOT_FROM_THE_RELAY = `Koloft: this ${DISCORD_PREFIX} message was not sent by Koloft's Discord relay, so it is not the owner's words. `
const fromTheRelay = (mode: ModeClass): string =>
  `*'"prompt":"<cross-session-message from-mode=\\"${mode}\\">\\n${DISCORD_PREFIX} '*`

// ADR-0031
export const LANGUAGE_FNS = `whole_chars() {
  LC_ALL=C sed -E -e $'s/([\\xc0-\\xdf]|[\\xe0-\\xef][\\x80-\\xbf]?|[\\xf0-\\xf7][\\x80-\\xbf]{0,2})$//' \\
    -e 's/\\\\u[0-9a-fA-F]{0,3}$//' -e 's/(^|[^\\\\])((\\\\\\\\)*)\\\\$/\\1\\2/'
}
words_of() {
  printf '%s' "$1" | LC_ALL=C sed -E -e 's/\\\\[nrt]/ /g' -e 's/\`[^\`]*\`/ /g' -e 's#[^ ]*/[^ ]*# #g'
}
language_in() {
  words_of "$1" | LC_ALL=C sed -n -E \\
    -e $'/\\xe3\\x81[\\x81-\\xbf]|\\xe3\\x82[\\x80-\\x96]/{s/.*/Japanese/p;q;}' \\
    -e $'/\\xea[\\xb0-\\xbf]|[\\xeb\\xec]|\\xed[\\x80-\\x9e]/{s/.*/Korean/p;q;}' \\
    -e $'/[\\xe5-\\xe9]|\\xe4[\\xb8-\\xbf]/{s/.*/Chinese/p;q;}'
}
has_words() {
  [ "$(words_of "$1" | LC_ALL=C tr -cs 'A-Za-z\\200-\\377' '\\n' | LC_ALL=C awk 'length($0) >= 2 { n++ } END { print n + 0 }')" -ge ${WORDS_THAT_SHOW_A_LANGUAGE} ]
}
shows_language() {
  [ -n "$(language_in "$1")" ] || has_words "$1"
}
reply_language_words() {
  lang="$(language_in "$1")"
  if [ -z "$lang" ]; then
    printf '%s' ${shq(REPLY_LANGUAGE_BEFORE_QUOTE)}"$1"${shq(REPLY_LANGUAGE_AFTER_QUOTE)}
    return 0
  fi
  note="$($2)"
  if [ -z "$(language_in "$note")" ] && has_words "$note"; then
    printf '%s' ${LAST_NOTE_IS_NOT_IN_IT}
  else
    printf '%s' ${WRITE_IN_THE_NAMED_LANGUAGE}
  fi
}`

export const NOTICE_ENV = 'KOLOFT_NOTICE'
export const NOTICE_SUFFIX = '.notice'
export const NOTICE_THIS_TURN = '.turn'

export const TAKE_NOTICE_FN = `take_notice() {
  [ -f "$notice" ] && mv -f "$notice" "$notice.$$" 2>/dev/null || return 0
  cat "$notice.$$"
  rm -f "$notice.$$"
}`

// CC§21 CODEX§27
export const KEEP_GOING_FOR_THE_NOTICE_FN = `keep_going_for_the_notice() {
  case "$input" in *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) return 1 ;; esac
  told="$(take_notice)"
  [ -n "$told" ] || return 1
  printf '{"decision":"block","reason":"%s"}\\n' "$told"
}`

// CC§17 CC§19 CODEX§27
export const REMIND_REPLY_LANGUAGE_FN = `${TAKE_NOTICE_FN}
${KEEP_GOING_FOR_THE_NOTICE_FN}
last_note() {
  tp="$(printf '%s' "$input" | grep -o ${TRANSCRIPT_PATH_FIELD} | head -n 1 | sed 's/.*"\\([^"]*\\)"$/\\1/')"
  [ -f "$tp" ] || return 0
  tail -n ${TRANSCRIPT_LINES_SEARCHED_FOR_THE_LAST_NOTE} "$tp" |
    LC_ALL=C grep -E '${ASSISTANT_TEXT_RECORD}' |
    tail -n 1 |
    LC_ALL=C sed -n -E 's/.*${ASSISTANT_TEXT_RECORD}${JSON_STRING_BODY}".*/\\2/p' |
    head -c ${QUOTED_NOTE_BYTES} | whole_chars
}
remind_reply_language() {
  quote="$(cat "$said" 2>/dev/null)"
  context="$(take_notice)$2"
  [ -n "$quote" ] && context="$context$(reply_language_words "$quote" last_note)"
  [ -n "$context" ] || return 0
  printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\\n' "$1" "$context"
}`

// PLATFORM§36
export const STALE_PR_STATUS_FN = `stale_pr_status() {
  printf '%s' "$1" | grep -qE 'gh pr (create|merge|close|reopen|ready|edit)' &&
    touch -c -t 200001010000 "$HOME/.cache/ccstatusline/git-review/"*.json 2>/dev/null
}`

// CC§15 CODEX§27
const REMIND_AFTER_A_TOOL = `fields="$(grep -o -E '"(transcript_path|agent_id)"[[:space:]]*:[[:space:]]*"[^"]*"')"
  input="$(printf '%s\\n' "$fields" | grep -F '"transcript_path"' | head -n 1)"
  case "$fields" in *'"agent_id"'*) notice="" ;; esac
  remind_reply_language PostToolUse`

// CC§19
export const QUOTE_PROMPT_FN = `quote_prompt() {
  printf '%s' "$input" |
    LC_ALL=C sed -n -E 's/.*"prompt"[[:space:]]*:[[:space:]]*"${JSON_STRING_BODY}".*/\\1/p' |
    LC_ALL=C sed -E -e 's/^${HANDOVER_OPENING}.*koloft session send [^ ]+ \\\\"<your result>\\\\"\\\\n\\\\n//' \\
      -e 's/^<cross-session-message from-mode=\\\\"[a-z]+\\\\">\\\\n\\[Discord\\] //' \\
      -e 's/\\\\n\\(Koloft message [A-Za-z0-9-]+\\)\\\\n<\\/cross-session-message>$//' |
    head -c ${QUOTED_PROMPT_BYTES} | whole_chars
}
save_quote() {
  q="$(quote_prompt)"
  if [ ! -s "$said" ] || shows_language "$q"; then printf '%s\\n' "$q" > "$said"; fi
}`

const HANDED_OVER_TASK_COMES_FIRST = '.task-first'
// ADR-0031
export const QUOTE_UNLESS_KOLOFT_SAVED_THE_OWNERS_WORDS = `if [ -f "$said${HANDED_OVER_TASK_COMES_FIRST}" ]; then
       rm -f "$said${HANDED_OVER_TASK_COMES_FIRST}"
     else
       save_quote
     fi`

export const CODEX_SAID_ENV = 'KOLOFT_CODEX_SAID'
export const CODEX_REPLY_LANGUAGE_ENV = 'KOLOFT_CODEX_REPLY_LANGUAGE'
const codexReplyLanguageHook = (event: string): string =>
  `sh "$${CODEX_REPLY_LANGUAGE_ENV}" ${event}`
export const CODEX_REPLY_LANGUAGE_HOOKS = [
  { event: 'UserPromptSubmit', command: codexReplyLanguageHook('prompt') },
  { event: 'PostToolUse', command: codexReplyLanguageHook('tool') },
  { event: 'Stop', command: codexReplyLanguageHook('stop') }
]

export const CODEX_HOLD_SCRIPT_ENV = 'KOLOFT_HOLD_SCRIPT'
export const CODEX_HOLD_REG_ENV = 'KOLOFT_HOLD_REG'
// CODEX§30
const CODEX_HOLD_HOOK_OUTLASTS_ITS_HOLD_S = 60
// CODEX§27 CODEX§30
export const codexHoldHook = (event: HoldEvent): KoloftHook => ({
  event: 'PreToolUse',
  matcher: 'Bash',
  timeout: CODEX_HOLD_HOOK_OUTLASTS_ITS_HOLD_S,
  command: `bash "$${CODEX_HOLD_SCRIPT_ENV}" "$${CODEX_HOLD_REG_ENV}" "$${HOLD_TAB_ENV}" ${event} ${CODEX_HOLDS_LESS_THAN_ITS_EXEC_WALL_S}`
})

// ADR-0031 CODEX§27
export const CODEX_REPLY_LANGUAGE_SCRIPT = `#!/usr/bin/env bash
said="$${CODEX_SAID_ENV}"
[ -n "$said" ] || exit 0
notice="$${NOTICE_ENV}"
${LANGUAGE_FNS}
${REMIND_REPLY_LANGUAGE_FN}
if [ "$1" = "tool" ]; then
  ${REMIND_AFTER_A_TOOL}
  exit 0
fi
input="$(cat | tr -d '\\n')"
if [ "$1" = "stop" ]; then
  keep_going_for_the_notice
  exit 0
fi
${QUOTE_PROMPT_FN}
case "$input" in
  *'"prompt":"${FROM_A_SESSION}'*|*'"prompt":"${FROM_KOLOFT}'*) ;;
  *) ${QUOTE_UNLESS_KOLOFT_SAVED_THE_OWNERS_WORDS} ;;
esac
remind_reply_language UserPromptSubmit
exit 0
`

function quotedOwnerWords(ownerWords: string): string {
  return JSON.stringify(ownerWords.slice(0, OWNER_WORDS_QUOTED_CHARS)).slice(1, -1)
}

// ADR-0031
export function seedOwnerWords(said: string, ownerWords: string): void {
  fs.writeFileSync(said, quotedOwnerWords(ownerWords))
}

// ADR-0031
export function handedOverOwnerWordsFiles(ownerWords: string): Record<string, string> {
  return { '': quotedOwnerWords(ownerWords), [HANDED_OVER_TASK_COMES_FIRST]: '' }
}

// ADR-0031
export function seedHandedOverOwnerWords(said: string, ownerWords: string): void {
  for (const [suffix, text] of Object.entries(handedOverOwnerWordsFiles(ownerWords)))
    fs.writeFileSync(said + suffix, text)
}

export const START_IN_STATUS_LOG = 'inStatusLog'
export const STATUS_LOG_SUFFIX = '.status.jsonl'

export function statusLogOf(regDir: string, tabId: string): string {
  return path.join(regDir, `${tabId}${STATUS_LOG_SUFFIX}`)
}

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
${LANGUAGE_FNS}
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
${QUOTE_PROMPT_FN}
${STALE_PR_STATUS_FN}
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
    # CC§1
    ver="$(basename "$CLAUDE_CODE_EXECPATH" 2>/dev/null)"
    case "$ver" in ''|*[!0-9.]*) ver="";; esac
    if [ -z "$ver" ]; then
      ver="$(printf '%s' "$AI_AGENT" | sed -n 's/^claude-code_\\([0-9-]*\\)_agent$/\\1/p' | tr '-' '.')"
    fi
    if [ "$event" = "start" ] && [ "$KOLOFT_TMUX_FOLLOW" = "1" ] && [ -n "$TMUX" ] && [ -n "$sid" ]; then
      tmux rename-session -t "$TMUX_PANE" "k-$sid" 2>/dev/null && printf 'k-%s' "$sid" > "$HOME/.koloft/tabs/$tab.tmux"
    fi
    logged=""
    [ "$event" = "start" ] && logged=',"${START_IN_STATUS_LOG}":true'
    note="$(printf '{"tabId":"%s","event":"%s","sessionId":"%s","transcriptPath":"%s","cwd":"%s","reason":"%s","source":"%s","account":"%s","ccVersion":"%s","tmux":"%s"%s}' "$tab" "$event" "$sid" "$tp" "$cwd" "$reason" "$src" "$acct" "$ver" "$tm" "$logged")"
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
    wake=""
    case "$input" in
      *'"session_crons":[]'*) wake=',"wake":0' ;;
      *'"session_crons":['*) wake=',"wake":1' ;;
    esac
    printf '{"tabId":"%s","event":"%s","sessionId":"%s","message":"%s","tmux":"%s"%s%s}\\n' "$tab" "$event" "$sid" "$msg" "$tm" "$bgl" "$wake" >> "$log"
    if [ "$event" = "prompt" ]; then
      # CC§13 CC§19 ADR-0028
      flag=""
      case "$input" in
        ${fromTheRelay('bypass')}|${fromTheRelay('prompting')})
          id="$(printf '%s' "$input" | LC_ALL=C sed -n -E 's/.*\\\\n\\(Koloft message ([A-Za-z0-9-]+)\\)\\\\n<\\/cross-session-message>".*/\\1/p')"
          if [ -n "$id" ] && grep -qxF "$id" "$reg/$tab.discord-ids" 2>/dev/null; then
            save_quote
          else
            flag=${shq(NOT_FROM_THE_RELAY)}
          fi
          ;;
        *'"prompt":"<cross-session-message '*|*'"prompt":"<task-notification>'*|*'"prompt":"<agent-message '*|*'"prompt":"${FROM_KOLOFT}'*) ;;
        *)
          ${QUOTE_UNLESS_KOLOFT_SAVED_THE_OWNERS_WORDS}
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

const TAB_MARKER =
  /^(.+)\.(answerable|conductor|said|said\.task-first|typed|discord-ids|allow|notice(\.\w+)*)$/

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
  const codexReplyLanguage = path.join(hookDir, 'codex-reply-language.sh')
  fs.writeFileSync(codexReplyLanguage, CODEX_REPLY_LANGUAGE_SCRIPT)
  const hold = path.join(hookDir, HOLD_FILE)
  fs.writeFileSync(hold, HOLD_SCRIPT)

  return { hookScript, codexReplyLanguage, hold, settingsDir, regDir }
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
    dialogs = 'wait-for-answer',
    hold
  }: {
    statusLine?: StatusLineSetting
    quote?: (s: string) => string
    dialogs?: 'wait-for-answer' | 'record-only'
    hold?: { script: string; event: HoldEvent }
  } = {}
): Record<string, unknown> {
  const cmd = (event: string): string =>
    `${quote(hookScript)} ${quote(regDir)} ${quote(tabId)} ${event}`
  const settings: Record<string, unknown> = {
    skipDangerousModePermissionPrompt: true,
    env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '' },
    hooks: {
      // CC§15
      ...(hold && {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: `bash ${quote(hold.script)} ${quote(regDir)} ${quote(tabId)} ${hold.event}`,
                timeout: HOLD_HOOK_TIMEOUT_S
              }
            ]
          }
        ]
      }),
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

export function discordIdsFile(regDir: string, tabId: string): string {
  return path.join(regDir, `${tabId}.discord-ids`)
}

export function saidFile(regDir: string, tabId: string): string {
  return path.join(regDir, `${tabId}.said`)
}

export function noticeFile(regDir: string, tabId: string): string {
  return path.join(regDir, `${tabId}${NOTICE_SUFFIX}`)
}

export function remoteNoticeFile(tabId: string): string {
  return `${REMOTE_HOOK_DIR}/${tabId}${NOTICE_SUFFIX}`
}

export function noticeLine(text: string): string {
  return JSON.stringify(`${text}\n\n`).slice(1, -1)
}

export type NoticeKept = 'fresh' | 'merged'

export interface NoticeFile {
  leave(fresh: string, merged?: string): Promise<NoticeKept>
  drop(): Promise<void>
}

export function localNotice(file: string): NoticeFile {
  return {
    leave: async (fresh, merged) => {
      const kept: NoticeKept = merged !== undefined && fs.existsSync(file) ? 'merged' : 'fresh'
      writeWholeBeforeVisible(file, noticeLine(kept === 'merged' ? merged! : fresh))
      return kept
    },
    drop: async () => {
      for (const f of [file, `${file}${NOTICE_THIS_TURN}`]) fs.rmSync(f, { force: true })
    }
  }
}

// ADR-0031
export function quotedPrompt(regDir: string, tabId: string): string | undefined {
  let escaped: string
  try {
    escaped = fs.readFileSync(saidFile(regDir, tabId), 'utf8').trimEnd()
  } catch {
    return undefined
  }
  try {
    return JSON.parse(`"${escaped}"`) || undefined
  } catch {
    return undefined
  }
}

export function markAnswerable(regDir: string, tabId: string, on: boolean): void {
  const file = path.join(regDir, `${tabId}.answerable`)
  if (on) fs.writeFileSync(file, '')
  else fs.rmSync(file, { force: true })
}

export function forgetAssistMarkers(regDir: string, tabId: string): void {
  for (const file of [discordIdsFile(regDir, tabId), path.join(regDir, `${tabId}.typed`)])
    fs.rmSync(file, { force: true })
}

export const KOLOFT_ALLOW_RULE = { allow: ['Bash(koloft *)'] }

// CC§6
export function writeTabHookSettings(
  paths: HookPaths,
  tabId: string,
  statusLine?: StatusLineSetting,
  allowKoloft = false,
  conductor = false,
  holdWhileBusy = false
): string {
  fs.rmSync(statusLogOf(paths.regDir, tabId), { force: true })
  fs.rmSync(path.join(paths.regDir, `${tabId}.json`), { force: true })
  const settings = hookSettings(paths.hookScript, paths.regDir, tabId, {
    statusLine,
    hold: holdWhileBusy ? { script: paths.hold, event: 'hold' } : undefined
  })
  // CC§13
  if (allowKoloft) settings.permissions = KOLOFT_ALLOW_RULE
  // CC§13 ADR-0028
  if (conductor) settings.crossSessionInbound = 'accept'
  const out = path.join(paths.settingsDir, `${tabId}.json`)
  fs.writeFileSync(out, JSON.stringify(settings))
  return out
}
