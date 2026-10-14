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

export type LogRecord = { payloadType: string; payload: Record<string, unknown> }

const logRecord = (line: string): LogRecord | undefined => {
  try {
    const r = record(JSON.parse(line))
    return typeof r.payload_type === 'string'
      ? { payloadType: r.payload_type, payload: record(r.payload) }
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

// MUSE§2
export const renamedTo = (r: LogRecord): string | undefined =>
  r.payloadType === 'session.name.changed' &&
  r.payload.source === 'user' &&
  typeof r.payload.new_name === 'string'
    ? r.payload.new_name
    : undefined

// MUSE§9
export function finishedWork(r: LogRecord): string | undefined {
  const event = record(r.payload.event)
  return r.payloadType === 'runtime.session' &&
    event.kind === 'inbox_item_queued' &&
    record(event.source).source === 'background_task_terminal' &&
    typeof event.registered_work_id === 'string'
    ? event.registered_work_id
    : undefined
}

export class SessionLogTail {
  private offset = 0
  private rest = ''

  constructor(
    private file: string,
    private onRecord: (r: LogRecord) => void
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
      for (const line of lines) {
        const r = line && logRecord(line)
        if (r) this.onRecord(r)
      }
    } finally {
      fs.closeSync(fd)
    }
  }
}

const PROMPT_TYPE = 'runtime.command_intake.received'
const REPLY_KIND = 'assistant_message_committed'

// MUSE§2
export async function saidInLog(
  file: string,
  each: (text: string) => boolean | void
): Promise<void> {
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.includes(PROMPT_TYPE) && !line.includes(REPLY_KIND)) continue
      const r = logRecord(line)
      if (!r) continue
      const text =
        r.payloadType === PROMPT_TYPE
          ? record(record(r.payload.record).command).prompt
          : record(r.payload.event).kind === REPLY_KIND
            ? record(r.payload.event).text
            : undefined
      if (typeof text === 'string' && each(text) === true) return
    }
  } finally {
    lines.close()
  }
}
