import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { NEWID_FN } from './openShimScript'
import {
  discordSaidFile,
  LANGUAGE_FNS,
  noticeFile,
  shellCall,
  SHELL_WRITES_FNS,
  QUOTE_PROMPT_FN,
  QUOTE_THE_OWNER_OR_FLAG_A_FALSE_DISCORD,
  REMIND_REPLY_LANGUAGE_FN,
  seedHandedOverOwnerWords
} from '@plugins/sessions/main/hooks'
import { record } from '@plugins/sessions/main/codexObservation'

// MUSE§9
export const MUSE_HOOKS_ENV = 'TBH_MANAGED_HOOKS_PATH'

// MUSE§9
const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop'
] as const

type MuseHookName = (typeof EVENTS)[number]

export const HOOK_DROP_PREFIX = 'hook-'

// MUSE§9 MUSE§12 ADR-0031
export function museHookScript(head: string, keep: string): string {
  return `#!/bin/bash
${head}
${LANGUAGE_FNS}
${REMIND_REPLY_LANGUAGE_FN}
${QUOTE_PROMPT_FN}
${SHELL_WRITES_FNS}
input="$(cat | tr -d '\\n')"
[ "$event" = "Stop" ] && keep_going_for_the_notice && exit 0
case "$input" in
  *'"tool_name":"bash"'*|*'"tool_name":"shell"'*)
    ${shellCall('session_id')}
    case "$event" in
      PreToolUse) shell_before "$where" "$key" ;;
      PostToolUse|PostToolUseFailure) input="\${input%\\}}$(shell_wrote "$where" "$key")}" ;;
    esac ;;
esac
[ "$event" = "PreToolUse" ] && exit 0
${keep}
case "$event" in
  SessionStart) [ -f "$3" ] && cat "$3" ;;
  UserPromptSubmit)
    ${QUOTE_THE_OWNER_OR_FLAG_A_FALSE_DISCORD}
    remind_reply_language UserPromptSubmit "$flag" ;;
  PostToolUse) remind_reply_language PostToolUse ;;
esac
exit 0
`
}

const HOOK_SCRIPT = museHookScript(
  `: koloft muse hook
dir="$1"
event="$2"
said="$4"
notice="$5"
discord_said="$6"
[ -d "$dir" ] || exit 0
${NEWID_FN}`,
  `id="$(newid)"
[ -n "$id" ] || id="$$-$(date +%s)"
part="$dir/${HOOK_DROP_PREFIX}$id.part"
printf '{"event":"%s","input":%s}\\n' "$event" "$input" > "$part" 2>/dev/null && mv "$part" "$dir/${HOOK_DROP_PREFIX}$id.json" 2>/dev/null`
)

// MUSE§9 MUSE§12
const SESSION_START_OUTPUT_LIMIT = 16_384

// MUSE§12
export function sessionStartContext(text: string): string {
  const out = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text }
  })
  if (Buffer.byteLength(out) >= SESSION_START_OUTPUT_LIMIT)
    throw new Error('Koloft’s instructions for Muse are too long for a Muse hook.')
  return out
}

export interface MuseRelayFiles {
  regDir: string
  tabId: string
}

const contextFileName = (i: number): string =>
  i === 0 ? 'session-start.json' : `session-start-${i + 1}.json`

// MUSE§9 MUSE§12
export function writeMuseHooks(
  shimDir: string,
  requestDir: string,
  contexts: readonly string[] = [],
  ownerWords?: string,
  relay?: MuseRelayFiles
): string {
  const notice = relay ? noticeFile(relay.regDir, relay.tabId) : ''
  const discordSaid = relay ? discordSaidFile(relay.regDir, relay.tabId) : ''
  const script = path.join(shimDir, 'muse-hook')
  fs.writeFileSync(script, HOOK_SCRIPT, { mode: 0o755 })
  const contextFiles = contexts.map((text, i) => {
    const full = path.join(shimDir, contextFileName(i))
    fs.writeFileSync(full, sessionStartContext(text))
    return full
  })
  const contextFile = contextFiles[0] ?? path.join(shimDir, contextFileName(0))
  const saidFile = path.join(shimDir, 'said')
  if (ownerWords) seedHandedOverOwnerWords(saidFile, ownerWords)
  const file = path.join(shimDir, 'hooks.json')
  fs.writeFileSync(
    file,
    hooksJson(
      (event) =>
        `/bin/bash ${shq(script)} ${shq(requestDir)} ${event} ${shq(contextFile)} ${shq(saidFile)} ${shq(notice)} ${shq(discordSaid)}`,
      contextFiles.slice(1).map((f) => `/bin/cat ${shq(f)}`)
    )
  )
  return file
}

// MUSE§12
function hooksJson(command: (event: MuseHookName) => string, laterStarts: string[]): string {
  const run = (lines: string[]): unknown[] => [
    { hooks: lines.map((line) => ({ type: 'command', command: line })) }
  ]
  return JSON.stringify({
    hooks: Object.fromEntries(
      EVENTS.map((event) => [
        event,
        run([command(event), ...(event === 'SessionStart' ? laterStarts : [])])
      ])
    )
  })
}

// MUSE§9 MUSE§12 MUSE§17
export function remoteMuseHooks(
  script: string,
  runId: string,
  contextFiles: readonly string[] = []
): string {
  const [first, ...later] = contextFiles
  return hooksJson(
    (event) => `bash "${script}" ${runId} ${event}${first ? ` "${first}"` : ''}`,
    later.map((f) => `cat "${f}"`)
  )
}

export interface MuseHook {
  event: MuseHookName
  sessionId: string
  input: Record<string, unknown>
}

export function museHook(raw: unknown): MuseHook | undefined {
  const drop = record(raw)
  const input = record(drop.input)
  const event = EVENTS.find((e) => e === drop.event)
  if (!event || typeof input.session_id !== 'string') return undefined
  return { event, sessionId: input.session_id, input }
}
