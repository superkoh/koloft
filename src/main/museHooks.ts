import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { NEWID_FN } from './openShimScript'
import { record } from './codexObservation'

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

export type MuseHookName = (typeof EVENTS)[number]

export const HOOK_DROP_PREFIX = 'hook-'

const HOOK_SCRIPT = `#!/bin/sh
: koloft muse hook
dir="$1"
event="$2"
[ -d "$dir" ] || exit 0
${NEWID_FN}
id="$(newid)"
[ -n "$id" ] || id="$$-$(date +%s)"
part="$dir/${HOOK_DROP_PREFIX}$id.part"
{ printf '{"event":"%s","input":' "$event"; cat; printf '}\\n'; } > "$part" 2>/dev/null && mv "$part" "$dir/${HOOK_DROP_PREFIX}$id.json" 2>/dev/null
if [ "$event" = SessionStart ] && [ -f "$3" ]; then cat "$3"; fi
exit 0
`

// MUSE§9 MUSE§12
export const SESSION_START_OUTPUT_LIMIT = 16_384

// MUSE§12
export function sessionStartContext(text: string): string {
  const out = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text }
  })
  if (Buffer.byteLength(out) >= SESSION_START_OUTPUT_LIMIT)
    throw new Error('Koloft’s instructions for Muse are too long for a Muse hook.')
  return out
}

// MUSE§9
export function writeMuseHooks(shimDir: string, requestDir: string, context?: string): string {
  const script = path.join(shimDir, 'muse-hook')
  fs.writeFileSync(script, HOOK_SCRIPT, { mode: 0o755 })
  const contextFile = path.join(shimDir, 'session-start.json')
  if (context) fs.writeFileSync(contextFile, sessionStartContext(context))
  const hooks = Object.fromEntries(
    EVENTS.map((event) => [
      event,
      [
        {
          hooks: [
            {
              type: 'command',
              command: `/bin/sh ${shq(script)} ${shq(requestDir)} ${event} ${shq(contextFile)}`
            }
          ]
        }
      ]
    ])
  )
  const file = path.join(shimDir, 'hooks.json')
  fs.writeFileSync(file, JSON.stringify({ hooks }))
  return file
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
