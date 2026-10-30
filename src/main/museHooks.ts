import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { NEWID_FN } from './openShimScript'
import {
  discordSaidBeside,
  LANGUAGE_FNS,
  QUOTE_PROMPT_FN,
  QUOTE_THE_OWNER_OR_FLAG_A_FALSE_DISCORD,
  REMIND_REPLY_LANGUAGE_FN,
  seedHandedOverOwnerWords,
  type HoldScript
} from './hooks'
import { record } from './codexObservation'
import { HOLD_HOOK_TIMEOUT_S } from './resourceGuard'
import { REMOTE_HOOK_DIR } from './remote/paths'

// MUSE§9
export const MUSE_HOOKS_ENV = 'TBH_MANAGED_HOOKS_PATH'

// MUSE§9
const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'PostToolUse',
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
input="$(cat | tr -d '\\n')"
[ "$event" = "Stop" ] && keep_going_for_the_notice && exit 0
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

export type MuseHold = HoldScript & { tabId: string }

// MUSE§9
export function writeMuseHooks(
  shimDir: string,
  requestDir: string,
  context?: string,
  ownerWords?: string,
  hold?: MuseHold,
  notice = ''
): string {
  const script = path.join(shimDir, 'muse-hook')
  fs.writeFileSync(script, HOOK_SCRIPT, { mode: 0o755 })
  const contextFile = path.join(shimDir, 'session-start.json')
  if (context) fs.writeFileSync(contextFile, sessionStartContext(context))
  const saidFile = path.join(shimDir, 'said')
  if (ownerWords) seedHandedOverOwnerWords(saidFile, ownerWords)
  const file = path.join(shimDir, 'hooks.json')
  fs.writeFileSync(
    file,
    hooksJson(
      (event) =>
        `/bin/bash ${shq(script)} ${shq(requestDir)} ${event} ${shq(contextFile)} ${shq(saidFile)} ${shq(notice)} ${shq(notice && discordSaidBeside(notice))}`,
      hold && `/bin/bash ${shq(hold.file)} ${shq(hold.regDir)} ${shq(hold.tabId)} hold`
    )
  )
  return file
}

function hooksJson(command: (event: MuseHookName) => string, hold?: string): string {
  const run = (line: string): unknown[] => [{ hooks: [{ type: 'command', command: line }] }]
  const hooks: Record<string, unknown> = Object.fromEntries(
    EVENTS.map((event) => [event, run(command(event))])
  )
  // ADR-0043 MUSE§9
  if (hold)
    hooks.PreToolUse = [
      { hooks: [{ type: 'command', command: hold, timeout: HOLD_HOOK_TIMEOUT_S }] }
    ]
  return JSON.stringify({ hooks })
}

// MUSE§9 MUSE§17
export function remoteMuseHooks(
  script: string,
  runId: string,
  contextFile?: string,
  holdScript?: string
): string {
  return hooksJson(
    (event) => `bash "${script}" ${runId} ${event}${contextFile ? ` "${contextFile}"` : ''}`,
    holdScript && `bash "${holdScript}" "${REMOTE_HOOK_DIR}" ${runId} hold-self`
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
