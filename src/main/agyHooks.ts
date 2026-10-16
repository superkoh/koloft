import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { NEWID_FN } from './openShimScript'
import { record } from './codexObservation'

export const AGY_DROPS_ENV = 'KOLOFT_AGY_DROPS'
export const AGY_TITLE_LOG_ENV = 'KOLOFT_AGY_TITLE_LOG'
export const AGY_START_ENV = 'KOLOFT_AGY_START'
export const AGY_TURN_ENV = 'KOLOFT_AGY_TURN'
export const AGY_GATE_ENV = 'KOLOFT_AGY_GATE'
export const AGY_OWNER_TITLE_ENV = 'KOLOFT_AGY_OWNER_TITLE'

export const AGY_HOOK_DROP_PREFIX = 'agy-hook-'

// AGY§12
const EVENTS = ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop'] as const
type AgyHookName = (typeof EVENTS)[number]
const DROPPED: readonly AgyHookName[] = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']

// AGY§12
const HOOK_SCRIPT = `#!/bin/sh
: koloft agy hook
event="$1"
input="$(cat)"
dir="$${AGY_DROPS_ENV}"
case " ${DROPPED.join(' ')} " in *" $event "*)
  if [ -n "$dir" ] && [ -d "$dir" ]; then
    ${NEWID_FN.split('\n').join('\n    ')}
    id="$(newid)"
    [ -n "$id" ] || id="$$-$(date +%s)"
    part="$dir/${AGY_HOOK_DROP_PREFIX}$id.part"
    { printf '{"event":"%s","input":' "$event"; printf '%s' "$input"; printf '}\\n'; } > "$part" 2>/dev/null && mv "$part" "$dir/${AGY_HOOK_DROP_PREFIX}$id.json" 2>/dev/null
  fi
  ;;
esac
case "$event" in
  SessionStart) [ -f "$${AGY_START_ENV}" ] && cat "$${AGY_START_ENV}" ;;
  PreInvocation) [ -f "$${AGY_TURN_ENV}" ] && cat "$${AGY_TURN_ENV}" ;;
  PreToolUse) [ -n "$${AGY_GATE_ENV}" ] && printf '%s' "$input" | sh -c "$${AGY_GATE_ENV}" ;;
esac
exit 0
`

// AGY§9 AGY§11
const TITLE_SCRIPT = `#!/bin/sh
: koloft agy title
input="$(cat)"
log="$${AGY_TITLE_LOG_ENV}"
[ -n "$log" ] && printf '%s\\n' "$(printf '%s' "$input" | tr -d '\\n')" >> "$log" 2>/dev/null
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
    [hook, HOOK_SCRIPT],
    [title, TITLE_SCRIPT]
  ])
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text)
      fs.writeFileSync(file, text, { mode: 0o755 })
  return { hook, title }
}

// AGY§12
export function koloftHookEntry(hookScript: string): Record<string, unknown> {
  const command = (event: AgyHookName): string => `/bin/sh ${shq(hookScript)} ${event}`
  const flat = (event: AgyHookName): unknown[] => [{ type: 'command', command: command(event) }]
  const matched = (event: AgyHookName): unknown[] => [{ matcher: '*', hooks: flat(event) }]
  return {
    SessionStart: flat('SessionStart'),
    PreInvocation: flat('PreInvocation'),
    PreToolUse: matched('PreToolUse'),
    PostToolUse: matched('PostToolUse'),
    Stop: flat('Stop')
  }
}

// AGY§12
export function sessionStartOutput(text: string): string {
  return JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: text } }] })
}

// AGY§12
export function everyTurnOutput(text: string): string {
  return JSON.stringify({ injectSteps: [{ ephemeralMessage: text }] })
}

export interface AgyHook {
  event: AgyHookName
  conversationId: string
  input: Record<string, unknown>
}

export function agyHook(raw: unknown): AgyHook | undefined {
  const drop = record(raw)
  const input = record(drop.input)
  const event = EVENTS.find((e) => e === drop.event)
  if (!event || typeof input.conversationId !== 'string') return undefined
  return { event, conversationId: input.conversationId, input }
}

export interface AgyTitleState {
  conversationId: string
  agentState: string
  title?: string
  contextUsed?: number
  model?: string
}

// AGY§9 AGY§11
export function titleState(line: string): AgyTitleState | undefined {
  let r: Record<string, unknown>
  try {
    r = record(JSON.parse(line))
  } catch {
    return undefined
  }
  if (typeof r.conversation_id !== 'string') return undefined
  const context = record(r.context_window)
  const model = record(r.model)
  return {
    conversationId: r.conversation_id,
    agentState: typeof r.agent_state === 'string' ? r.agent_state : '',
    title:
      typeof r.conversation_title === 'string' && r.conversation_title
        ? r.conversation_title
        : undefined,
    contextUsed: typeof context.used_percentage === 'number' ? context.used_percentage : undefined,
    model: typeof model.id === 'string' ? model.id : undefined
  }
}

export class LineTail {
  private offset = 0
  private rest = ''

  constructor(
    private file: string,
    private onLine: (line: string) => void
  ) {}

  read(): void {
    if ((fs.statSync(this.file, { throwIfNoEntry: false })?.size ?? 0) <= this.offset) return
    let fd: number
    try {
      fd = fs.openSync(this.file, 'r')
    } catch {
      return
    }
    try {
      const size = fs.fstatSync(fd).size
      if (size <= this.offset) return
      const buf = Buffer.alloc(size - this.offset)
      fs.readSync(fd, buf, 0, buf.length, this.offset)
      this.offset = size
      const lines = (this.rest + buf.toString('utf8')).split('\n')
      this.rest = lines.pop() ?? ''
      for (const line of lines) if (line) this.onLine(line)
    } finally {
      fs.closeSync(fd)
    }
  }
}
