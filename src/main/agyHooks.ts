import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { record } from './codexObservation'
import {
  A_HELPER_HAS_IT_IN_OLDER_TRANSCRIPTS,
  FROM_A_SESSION,
  FROM_KOLOFT
} from './crossSessionMessage'
import {
  HOLD_FILE,
  HOLD_TAB_ENV,
  JSON_STRING_BODY,
  KEEP_GOING_FOR_THE_NOTICE_FN,
  LANGUAGE_FNS,
  NOTICE_ENV,
  NOTICE_THIS_TURN,
  QUOTED_NOTE_BYTES,
  QUOTED_PROMPT_BYTES,
  TAKE_NOTICE_FN,
  TRANSCRIPT_LINES_SEARCHED_FOR_THE_LAST_NOTE,
  type HoldEvent,
  type HoldScript
} from './hooks'
import { HOLD_HOOK_TIMEOUT_S } from './resourceGuard'
import { REMOTE_HOOK_DIR } from './remote/paths'

export const AGY_LOG_ENV = 'KOLOFT_AGY_LOG'
export const AGY_START_ENV = 'KOLOFT_AGY_START'
export const AGY_LOG_POINTER_SUFFIX = '.agy-log'
export const AGY_OWNER_TITLE_ENV = 'KOLOFT_AGY_OWNER_TITLE'
export const AGY_COST_ENV = 'KOLOFT_AGY_COST'

// AGY§12
const EVENTS = ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop'] as const
type AgyHookName = (typeof EVENTS)[number]

const NOT_THE_OWNERS_WORDS = [FROM_A_SESSION, FROM_KOLOFT, A_HELPER_HAS_IT_IN_OLDER_TRANSCRIPTS]
  .map((opening) => `-e ${shq(`"content":"<USER_REQUEST>\\n${opening}`)}`)
  .join(' ')

// AGY§12
const LAST_REPLY_FN = `last_reply() {
  tail -n ${TRANSCRIPT_LINES_SEARCHED_FOR_THE_LAST_NOTE} "$tp" 2>/dev/null |
    LC_ALL=C sed -n -E 's/.*"type":"PLANNER_RESPONSE"[^{]*"content":"${JSON_STRING_BODY}".*/\\1/p' |
    LC_ALL=C grep . | tail -n 1 |
    head -c ${QUOTED_NOTE_BYTES} | whole_chars
}`

// AGY§12 ADR-0031
export const AGY_HOOK_SCRIPT = `#!/bin/sh
: koloft agy hook
[ -n "$BASH_VERSION" ] || exec bash "$0" "$@"
event="$1"
input="$(cat)"
log="$${AGY_LOG_ENV}"
notice="$${NOTICE_ENV}"
turn=""; [ -n "$notice" ] && turn="$notice${NOTICE_THIS_TURN}"
${TAKE_NOTICE_FN}
${KEEP_GOING_FOR_THE_NOTICE_FN}
${LANGUAGE_FNS}
${LAST_REPLY_FN}
if [ "$event" = "Stop" ]; then
  keep_going_for_the_notice && exit 0
  [ -n "$turn" ] && rm -f "$turn"
fi
[ -n "$log" ] && { printf '{"event":"%s","input":' "$event"; printf '%s' "$input" | tr -d '\\n'; printf '}\\n'; } >> "$log" 2>/dev/null
case "$event" in
  SessionStart) [ -f "$${AGY_START_ENV}" ] && cat "$${AGY_START_ENV}" ;;
  PreInvocation)
    tp="$(printf '%s' "$input" | tr -d '\\n' | sed -n 's/.*"transcriptPath" *: *"\\([^"]*\\)".*/\\1/p')"
    said="$(grep -F '"type":"USER_INPUT"' "$tp" 2>/dev/null | grep -v -F ${NOT_THE_OWNERS_WORDS} | tail -n 1 | sed -n 's/.*"content":"<USER_REQUEST>\\\\n//p' | sed -E 's/\\\\n<\\/USER_REQUEST>.*//; s/^.*koloft session send [^ ]+ \\\\"<your result>\\\\"\\\\n\\\\n//; s/\\\\[nrt]/ /g; s/ +/ /g; s/^ //' | head -c ${QUOTED_PROMPT_BYTES} | ( iconv -c -f UTF-8 -t UTF-8 2>/dev/null || cat ) | sed -E 's/\\\\u[0-9a-fA-F]{0,3}$//; s/\\\\+$//')"
    [ -n "$said" ] && said="$(reply_language_words "$said" last_reply)"
    if [ -n "$turn" ]; then
      case "$(printf '%s' "$input" | tr -d ' \\n')" in *'"invocationNum":0'[,}]*) rm -f "$turn" ;; esac
      [ -f "$notice" ] && take_notice >> "$turn"
    fi
    told="$([ -n "$turn" ] && cat "$turn" 2>/dev/null)$said"
    [ -n "$told" ] && printf '{"injectSteps":[{"ephemeralMessage":"%s"}]}' "$told"
    ;;
esac
exit 0
`

// AGY§9 AGY§11
export const AGY_TITLE_SCRIPT = `#!/bin/sh
: koloft agy title
input="$(cat)"
log="$${AGY_LOG_ENV}"
[ -n "$log" ] && printf '%s\\n' "$(printf '%s' "$input" | tr -d '\\n')" >> "$log" 2>/dev/null
if [ "$KOLOFT_TMUX_FOLLOW" = 1 ] && [ -n "$TMUX" ]; then
  id="$(printf '%s' "$input" | tr -d '\\n' | sed -n 's/.*"conversation_id" *: *"\\([0-9a-f-][0-9a-f-]*\\)".*/\\1/p')"
  [ -n "$id" ] && [ "$(tmux display-message -p '#S' 2>/dev/null)" != "k-$id" ] && tmux rename-session -t "$TMUX_PANE" "k-$id" 2>/dev/null
  [ -n "$id" ] && [ -n "$log" ] && printf '%s' "$(basename "$log")" > "$(dirname "$log")/k-$id${AGY_LOG_POINTER_SUFFIX}"
  [ -n "$id" ] && printf 'k-%s' "$id" > "$HOME/.koloft/tabs/$KOLOFT_TAB_ID.tmux"
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

const holdCommand = (file: string, regDir: string, event: HoldEvent): string =>
  `bash ${file} ${regDir} "$${HOLD_TAB_ENV}" ${event}`

// ADR-0043
export const localAgyHold = ({ file, regDir }: HoldScript): string =>
  holdCommand(shq(file), shq(regDir), 'hold')

// ADR-0043
export const machineAgyHold = (machineDir: string): string =>
  holdCommand(`"${machineDir}/${HOLD_FILE}"`, `"${REMOTE_HOOK_DIR}"`, 'hold-self')

// AGY§12
export function koloftHookEntry(runScript: string, hold?: string): Record<string, unknown> {
  const command = (event: AgyHookName): string => `${runScript} ${event}`
  const flat = (event: AgyHookName): unknown[] => [{ type: 'command', command: command(event) }]
  const matched = (event: AgyHookName, ...more: unknown[]): unknown[] => [
    { matcher: '*', hooks: [...flat(event), ...more] }
  ]
  return {
    SessionStart: flat('SessionStart'),
    PreInvocation: flat('PreInvocation'),
    // AGY§12
    PreToolUse: matched(
      'PreToolUse',
      ...(hold ? [{ type: 'command', command: hold, timeout: HOLD_HOOK_TIMEOUT_S }] : [])
    ),
    PostToolUse: matched('PostToolUse'),
    Stop: flat('Stop')
  }
}

// AGY§12
export function sessionStartOutput(text: string): string {
  return JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: text } }] })
}

export interface AgyHook {
  event: AgyHookName
  conversationId: string
  input: Record<string, unknown>
}

function agyHook(line: Record<string, unknown>): AgyHook | undefined {
  const input = record(line.input)
  const event = EVENTS.find((e) => e === line.event)
  if (!event || typeof input.conversationId !== 'string') return undefined
  return { event, conversationId: input.conversationId, input }
}

export interface AgyTitleState {
  conversationId: string
  agentState: string
  confirmationPending: boolean
  title?: string
  contextUsed?: number
  model?: string
}

// AGY§9 AGY§11
function titleState(r: Record<string, unknown>): AgyTitleState | undefined {
  if (typeof r.conversation_id !== 'string') return undefined
  const context = record(r.context_window)
  const model = record(r.model)
  return {
    conversationId: r.conversation_id,
    agentState: typeof r.agent_state === 'string' ? r.agent_state : '',
    confirmationPending: r.tool_confirmation_pending === true,
    title:
      typeof r.conversation_title === 'string' && r.conversation_title
        ? r.conversation_title
        : undefined,
    contextUsed: typeof context.used_percentage === 'number' ? context.used_percentage : undefined,
    model: typeof model.id === 'string' ? model.id : undefined
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
