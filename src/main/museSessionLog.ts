import fs from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { record } from './codexObservation'

const DAY_MS = 24 * 60 * 60 * 1000

// MUSE§2
export function museHome(env: NodeJS.ProcessEnv): string {
  const data = env.XDG_DATA_HOME || path.join(env.HOME || os.homedir(), '.local', 'share')
  return path.join(data, 'muse')
}

// MUSE§2
export function museConfigHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config')
}

const uuidV7Ms = (id: string): number => parseInt(id.replace(/-/g, '').slice(0, 12), 16)

const dateDir = (ms: number): string => {
  const d = new Date(ms)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return path.join(String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()))
}

// MUSE§2
export function museSessionLog(env: NodeJS.ProcessEnv, sessionId: string): string | undefined {
  const at = uuidV7Ms(sessionId)
  if (!Number.isFinite(at)) return undefined
  for (const ms of [at, at - DAY_MS, at + DAY_MS]) {
    const file = path.join(museHome(env), 'sessions', dateDir(ms), sessionId, 'session.jsonl')
    if (fs.existsSync(file)) return file
  }
  return undefined
}

export type LogRecord = { payloadType: string; payload: Record<string, unknown>; atMs?: number }

const MICROSECONDS_PER_MS = 1000

export const logRecord = (line: string): LogRecord | undefined => {
  try {
    const r = record(JSON.parse(line))
    return typeof r.payload_type === 'string'
      ? {
          payloadType: r.payload_type,
          payload: record(r.payload),
          ...(typeof r.recorded_at === 'number' && { atMs: r.recorded_at / MICROSECONDS_PER_MS })
        }
      : undefined
  } catch {
    return undefined
  }
}

// MUSE§1
export function lastCompletedText(stdout: string): string | null {
  let text: string | null = null
  for (const line of stdout.split('\n')) {
    const r = logRecord(line)
    if (r?.payloadType === 'run.terminal.completed' && typeof r.payload.text === 'string')
      text = r.payload.text
  }
  return text
}

const NAME_CHANGED = 'session.name.changed'
const QUEUED = 'inbox_item_queued'
const MANUAL_COMPACT = 'context.compact.manual'

export const REMOTE_LOG_MARKS = [NAME_CHANGED, QUEUED, MANUAL_COMPACT]

// MUSE§2
export const museNameOf = (r: LogRecord): string | undefined =>
  r.payloadType === NAME_CHANGED && typeof r.payload.new_name === 'string'
    ? r.payload.new_name
    : undefined

// MUSE§2
export const renamedTo = (r: LogRecord): string | undefined =>
  r.payload.source === 'user' ? museNameOf(r) : undefined

// MUSE§3 MUSE§9
export const startsATurnByItself = (r: LogRecord): boolean =>
  r.payloadType === 'runtime.session' && record(r.payload.event).kind === QUEUED

export const runEvent = (r: LogRecord, kind: string): Record<string, unknown> | undefined => {
  const event = record(r.payload.event)
  return r.payloadType === 'runtime.session' &&
    r.payload.kind === 'run' &&
    typeof r.payload.run_id === 'string' &&
    event.kind === kind
    ? event
    : undefined
}

// MUSE§9
export function replyIn(r: LogRecord): { turnId: string; text: string } | undefined {
  const text = runEvent(r, 'assistant_message_committed')?.text
  return typeof text === 'string' ? { turnId: String(r.payload.run_id), text } : undefined
}

// MUSE§9
export const turnEndedIn = (r: LogRecord): string | undefined =>
  runEvent(r, 'terminal') ? String(r.payload.run_id) : undefined

// MUSE§9
export const compactionStarts = (r: LogRecord): boolean =>
  r.payloadType === 'runtime.command.accepted' && r.payload.command_kind === MANUAL_COMPACT

// MUSE§9
export const compactionEnds = (r: LogRecord): boolean =>
  r.payloadType === `${MANUAL_COMPACT}.outcome`

// MUSE§9
export function firedJob(r: LogRecord): string | undefined {
  const event = record(r.payload.event)
  const source = record(event.source)
  return startsATurnByItself(r) &&
    source.source === 'scheduled' &&
    typeof source.job_id === 'string'
    ? source.job_id
    : undefined
}

// MUSE§9
export function finishedWork(r: LogRecord): string | undefined {
  const event = record(r.payload.event)
  return r.payloadType === 'runtime.session' &&
    event.kind === QUEUED &&
    record(event.source).source === 'background_task_terminal' &&
    typeof event.registered_work_id === 'string'
    ? event.registered_work_id
    : undefined
}

export class LineTail {
  private rest = ''

  constructor(
    readonly file: string,
    private onLine: (line: string) => void,
    private offset = 0
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

export class SessionLogTail extends LineTail {
  constructor(file: string, onRecord: (r: LogRecord) => void, offset = 0) {
    super(
      file,
      (line) => {
        const r = logRecord(line)
        if (r) onRecord(r)
      },
      offset
    )
  }
}

const PROMPT_TYPE = 'runtime.command_intake.received'
const REPLY_KIND = 'assistant_message_committed'

export const SAID_MARKS = [PROMPT_TYPE, REPLY_KIND]

// MUSE§2
export function textOfLogLine(line: string): string | undefined {
  if (!SAID_MARKS.some((mark) => line.includes(mark))) return undefined
  const r = logRecord(line)
  if (!r) return undefined
  const text =
    r.payloadType === PROMPT_TYPE
      ? record(record(r.payload.record).command).prompt
      : record(r.payload.event).kind === REPLY_KIND
        ? record(r.payload.event).text
        : undefined
  return typeof text === 'string' ? text : undefined
}

// MUSE§2
export async function saidInLog(
  file: string,
  each: (text: string) => boolean | void
): Promise<void> {
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const text = textOfLogLine(line)
      if (text !== undefined && each(text) === true) return
    }
  } finally {
    lines.close()
  }
}
