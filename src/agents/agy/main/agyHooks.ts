import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { A_HELPER_HAS_IT_IN_OLDER_TRANSCRIPTS } from '@shared/koloftOpenings'
import { nonEmptyString, record } from '@core/unknownValue'
import { messageArrivesRules, textOf } from '@core/hookMoments'
import {
  hookField,
  JSON_STRING_BODY,
  KEEP_GOING_FOR_THE_NOTICE_FN,
  LANGUAGE_FNS,
  QUOTED_NOTE_BYTES,
  QUOTED_PROMPT_BYTES,
  SHELL_WRITES_FNS,
  STALE_PR_STATUS_FN,
  TAKE_NOTICE_FN,
  TRANSCRIPT_LINES_SEARCHED_FOR_THE_LAST_NOTE
} from '@agents/kit/main/hookScriptParts'
import { NOTICE_ENV, NOTICE_THIS_TURN } from '../../../main/hookFiles'
import { UUID } from '@agents/kit/main/sessionStore'
import { HANDOVER_OPENING } from '@core/handOver'

export const AGY_LOG_ENV = 'KOLOFT_AGY_LOG'
export const AGY_START_ENV = 'KOLOFT_AGY_START'
export const AGY_LOG_POINTER_SUFFIX = '.agy-log'
export const AGY_OWNER_TITLE_ENV = 'KOLOFT_AGY_OWNER_TITLE'
export const AGY_COST_ENV = 'KOLOFT_AGY_COST'

// AGY§12
const EVENTS = ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop'] as const
type AgyHookName = (typeof EVENTS)[number]

const notTheOwnersWords = [
  ...messageArrivesRules()
    .filter((r) => r.countsAs === 'not-the-owners-words')
    .map(textOf),
  A_HELPER_HAS_IT_IN_OLDER_TRANSCRIPTS
]
const opensWithAnother = (text: string): boolean =>
  notTheOwnersWords.some((other) => other !== text && text.startsWith(other))

// AGY§8 ADR-0028 ADR-0031
const NOT_THE_OWNERS_WORDS = notTheOwnersWords
  .filter((text) => !opensWithAnother(text))
  .map((opening) => `-e ${shq(`"content":"<USER_REQUEST>\\n${opening}`)}`)
  .join(' ')

// AGY§12
const LAST_REPLY_FN = `last_reply() {
  tail -n ${TRANSCRIPT_LINES_SEARCHED_FOR_THE_LAST_NOTE} "$tp" 2>/dev/null |
    LC_ALL=C grep -F '"type":"PLANNER_RESPONSE"' |
    LC_ALL=C sed -n -E 's/.*"type":"PLANNER_RESPONSE"[^{]*"content":"${JSON_STRING_BODY}".*/\\1/p' |
    LC_ALL=C grep . | tail -n 1 |
    head -c ${QUOTED_NOTE_BYTES} | whole_chars
}`

const INJECT_STEPS_OPEN = '{"injectSteps":['
const INJECT_STEPS_CLOSE = ']}'
const STEP_THIS_HOOK_INJECTED = 'injected by a PreInvocation hook:'

// AGY§12 AGY§17
const START_STEP_ONCE_COMPACTED_FN = `start_step_once_compacted() {
  [ -f "$${AGY_START_ENV}" ] || return 0
  LC_ALL=C grep -F -e '"type":"CHECKPOINT"' -e ${shq(STEP_THIS_HOOK_INJECTED)} "$tp" 2>/dev/null | awk ${shq(`/"type":"SYSTEM_MESSAGE"/ && index($0, "${STEP_THIS_HOOK_INJECTED}") { put = 1 } /"type":"CHECKPOINT"/ { compacted = 1; put = 0 } END { exit !(compacted && !put) }`)} || return 0
  st="$(cat "$${AGY_START_ENV}")"
  st="\${st#${shq(INJECT_STEPS_OPEN)}}"
  printf '%s' "\${st%${shq(INJECT_STEPS_CLOSE)}}"
}`

// AGY§12 AGY§16 ADR-0028 ADR-0031
export const AGY_HOOK_SCRIPT = `#!/bin/sh
: koloft agy hook
[ "$1" != PreInvocation ] || [ -n "$BASH_VERSION" ] || exec bash "$0" "$@"
event="$1"
input="$(cat)"
log="$${AGY_LOG_ENV}"
notice="$${NOTICE_ENV}"
turn=""; [ -n "$notice" ] && turn="$notice${NOTICE_THIS_TURN}"
${TAKE_NOTICE_FN}
${KEEP_GOING_FOR_THE_NOTICE_FN}
${LANGUAGE_FNS}
${LAST_REPLY_FN}
${STALE_PR_STATUS_FN}
${SHELL_WRITES_FNS}
${START_STEP_ONCE_COMPACTED_FN}
case "$event:$input" in
  PreToolUse:*'"name":"run_command"'*|PostToolUse:*'"name":"run_command"'*)
    where="$(printf '%s' "$input" | tr -d '\\n' | ${hookField('Cwd')})"
    [ -n "$where" ] || where="$(printf '%s' "$input" | tr -d '\\n' | sed -n 's/.*"workspacePaths"[[:space:]]*:[[:space:]]*\\[[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
    key="$(shell_key "$(printf '%s' "$input" | tr -d '\\n' | ${hookField('conversationId')})-$(printf '%s' "$input" | tr -d '\\n' | sed -n 's/.*"stepIdx"[[:space:]]*:[[:space:]]*\\([0-9]*\\).*/\\1/p')")"
    if [ "$event" = PreToolUse ]; then shell_before "$where" "$key"
    else input="\${input%\\}}$(shell_wrote "$where" "$key")}"; fi ;;
esac
if [ "$event" = "Stop" ]; then
  keep_going_for_the_notice && exit 0
  [ -n "$turn" ] && rm -f "$turn"
fi
[ -n "$log" ] && printf '{"event":"%s","input":%s}\\n' "$event" "$(printf '%s' "$input" | tr -d '\\n')" >> "$log" 2>/dev/null
case "$event" in
  SessionStart) [ -f "$${AGY_START_ENV}" ] && cat "$${AGY_START_ENV}" ;;
  PreInvocation)
    tp="$(printf '%s' "$input" | tr -d '\\n' | sed -n 's/.*"transcriptPath" *: *"\\([^"]*\\)".*/\\1/p')"
    said="$(grep -F '"type":"USER_INPUT"' "$tp" 2>/dev/null | grep -v -F ${NOT_THE_OWNERS_WORDS} | tail -n 1 | sed -n 's/.*"content":"<USER_REQUEST>\\\\n//p' | sed -E 's/\\\\n<\\/USER_REQUEST>.*//; s/^${HANDOVER_OPENING}.*koloft session send [^ ]+ \\\\"<your result>\\\\"\\\\n\\\\n//; s/\\\\[nrt]/ /g; s/ +/ /g; s/^ //' | head -c ${QUOTED_PROMPT_BYTES} | ( iconv -c -f UTF-8 -t UTF-8 2>/dev/null || cat ) | sed -E 's/\\\\u[0-9a-fA-F]{0,3}$//; s/\\\\+$//')"
    [ -n "$said" ] && said="$(reply_language_words "$said" last_reply)"
    if [ -n "$turn" ]; then
      case "$(printf '%s' "$input" | tr -d ' \\n')" in *'"invocationNum":0'[,}]*) rm -f "$turn" ;; esac
      [ -f "$notice" ] && take_notice >> "$turn"
    fi
    told="$([ -n "$turn" ] && cat "$turn" 2>/dev/null)$said"
    steps="$(start_step_once_compacted)"
    [ -n "$told" ] && steps="\${steps:+$steps,}{\\"ephemeralMessage\\":\\"$told\\"}"
    [ -n "$steps" ] && printf '${INJECT_STEPS_OPEN}%s${INJECT_STEPS_CLOSE}' "$steps"
    ;;
  # AGY§12 PLATFORM§36
  PostToolUse) case "$input" in *'gh pr '*) stale_pr_status "$(printf '%s' "$input" | tr -d '\\n' | LC_ALL=C sed -n -E 's/.*"CommandLine" *: *"${JSON_STRING_BODY}".*/\\1/p')" ;; esac ;;
esac
exit 0
`

const TITLE_ROLE_STRIP_ABOVE_CHARS = 4096
const LONG_ROLE_BODY = '(([^"\\\\]|\\\\.){160,})'

// AGY§9 AGY§11
export const AGY_TITLE_SCRIPT = `#!/bin/sh
: koloft agy title
input="$(cat)"
log="$${AGY_LOG_ENV}"
if [ -n "$log" ]; then
  logged="$(printf '%s' "$input" | tr -d '\\n')"
  [ "\${#logged}" -gt ${TITLE_ROLE_STRIP_ABOVE_CHARS} ] && logged="$(printf '%s' "$logged" | LC_ALL=C sed -E 's/"role" *: *"${LONG_ROLE_BODY}"/"role":""/g')"
  printf '%s\\n' "$logged" >> "$log" 2>/dev/null
fi
if [ "$KOLOFT_TMUX_FOLLOW" = 1 ] && [ -n "$TMUX" ]; then
  id="$(printf '%s' "$input" | tr -d '\\n' | sed -n 's/.*"conversation_id" *: *"\\([0-9a-f-][0-9a-f-]*\\)".*/\\1/p')"
  if [ -n "$id" ]; then
    # ADR-0044 PLATFORM§35
    nf="$HOME/.koloft/tabs/$KOLOFT_TAB_ID.tmux"
    printf 'k-%s' "$id" > "$nf"
    now="$(tmux display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null)"
    if [ "$now" != "k-$id" ] && ! tmux rename-session -t "$TMUX_PANE" "k-$id" 2>/dev/null; then
      if [ -n "$now" ]; then printf '%s' "$now" > "$nf"; else rm -f "$nf"; fi
    fi
    [ -n "$log" ] && printf '%s' "$(basename "$log")" > "$(dirname "$log")/k-$id${AGY_LOG_POINTER_SUFFIX}"
  fi
fi
[ -n "$${AGY_OWNER_TITLE_ENV}" ] && printf '%s' "$input" | sh -c "$${AGY_OWNER_TITLE_ENV}"
exit 0
`

export interface AgyScripts {
  hook: string
  title: string
}

export function writeAgyScripts(dir: string): AgyScripts {
  fs.mkdirSync(dir, { recursive: true })
  const hook = path.join(dir, 'koloft-agy-hook')
  const title = path.join(dir, 'koloft-agy-title')
  for (const [file, text] of [
    [hook, AGY_HOOK_SCRIPT],
    [title, AGY_TITLE_SCRIPT]
  ])
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text)
      fs.writeFileSync(file, text, { mode: 0o755 })
  return { hook, title }
}

export function runWithSh(file: string): string {
  return `/bin/sh ${shq(file)}`
}

// AGY§12
export function koloftHookEntry(runScript: string): Record<string, unknown> {
  const command = (event: AgyHookName): string => `${runScript} ${event}`
  const flat = (event: AgyHookName): unknown[] => [{ type: 'command', command: command(event) }]
  const matched = (event: AgyHookName): unknown[] => [{ matcher: '*', hooks: flat(event) }]
  return {
    SessionStart: flat('SessionStart'),
    PreInvocation: flat('PreInvocation'),
    // AGY§12
    PreToolUse: matched('PreToolUse'),
    PostToolUse: matched('PostToolUse'),
    Stop: flat('Stop')
  }
}

// AGY§12
export function sessionStartOutput(text: string): string {
  return `${INJECT_STEPS_OPEN}${JSON.stringify({ systemMessage: { systemMessage: text } })}${INJECT_STEPS_CLOSE}`
}

export interface AgyHook {
  event: AgyHookName
  conversationId: string
  parentConversationId?: string
  rootConversationId?: string
  agentName?: string
  hookEventName?: string
  input: Record<string, unknown>
}

const str = nonEmptyString

// AGY§9 AGY§12
function agyHook(line: Record<string, unknown>): AgyHook | undefined {
  const input = record(line.input)
  const event = EVENTS.find((e) => e === line.event)
  const conversationId = input.conversationId
  if (!event || typeof conversationId !== 'string' || !UUID.test(conversationId)) return undefined
  const parentConversationId = str(input.parentConversationId)
  const rootConversationId = str(input.rootConversationId)
  const agentName = str(input.agentName)
  const hookEventName = str(input.hookEventName)
  return {
    event,
    conversationId,
    ...(parentConversationId && { parentConversationId }),
    ...(rootConversationId && { rootConversationId }),
    ...(agentName && { agentName }),
    ...(hookEventName && { hookEventName }),
    input
  }
}

export interface AgyTitleSubagent {
  id?: string
  name?: string
  role?: string
  state?: string
  model?: string
}

export interface AgyTitleState {
  conversationId: string
  agentState: string
  confirmationPending: boolean
  title?: string
  contextUsed?: number
  model?: string
  taskCount?: number
  subagents?: AgyTitleSubagent[]
}

function titleSubagents(raw: unknown): AgyTitleSubagent[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.flatMap((item): AgyTitleSubagent[] => {
    if (typeof item === 'string' && item) return [{ name: item }]
    const r = record(item)
    const id = str(r.conversation_id) ?? str(r.conversationId) ?? str(r.id)
    const name = str(r.name) ?? str(r.agent_name) ?? str(r.type_name) ?? str(r.typeName)
    const role = str(r.role)
    const state = str(r.state) ?? str(r.status)
    const model = str(r.model)
    if (!id && !name && !role && !state && !model) return []
    return [
      {
        ...(id && { id }),
        ...(name && { name }),
        ...(role && { role }),
        ...(state && { state }),
        ...(model && { model })
      }
    ]
  })
}

const NO_CONVERSATION_YET = ''

// AGY§9 AGY§11
function titleState(r: Record<string, unknown>): AgyTitleState | undefined {
  if (typeof r.conversation_id !== 'string') return undefined
  if (r.conversation_id !== NO_CONVERSATION_YET && !UUID.test(r.conversation_id)) return undefined
  const context = record(r.context_window)
  const model = record(r.model)
  const subagents = titleSubagents(r.subagents)
  return {
    conversationId: r.conversation_id,
    agentState: typeof r.agent_state === 'string' ? r.agent_state : '',
    confirmationPending: r.tool_confirmation_pending === true,
    title:
      typeof r.conversation_title === 'string' && r.conversation_title
        ? r.conversation_title
        : undefined,
    contextUsed: typeof context.used_percentage === 'number' ? context.used_percentage : undefined,
    model: typeof model.id === 'string' ? model.id : undefined,
    taskCount: typeof r.task_count === 'number' ? r.task_count : undefined,
    ...(subagents !== undefined && { subagents })
  }
}

export type AgyLogLine = { hook: AgyHook } | { title: AgyTitleState }

// AGY§11 AGY§12
export function agyLogLine(line: string): AgyLogLine | undefined {
  let r: Record<string, unknown>
  try {
    r = record(JSON.parse(line))
  } catch {
    return undefined
  }
  if ('event' in r) {
    const hook = agyHook(r)
    return hook && { hook }
  }
  const title = titleState(r)
  return title && { title }
}
