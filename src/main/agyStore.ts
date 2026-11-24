import fs from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'
import type { SaidLine, Turn } from '@shared/turns'
import { AGY_LOGS_FOLDER } from '@shared/agyBrain'
import { nonEmptyString, record } from '@core/unknownValue'
import { readAppendedLines, type AppendCursor } from './appendedLines'
import type { HistoryEntry } from '@agents/kit/main/storedSessions'

export const AGY_APP_DIR = 'antigravity-cli'

// AGY§4
export function ownersGeminiDir(env: NodeJS.ProcessEnv): string {
  return path.join(env.HOME || os.homedir(), '.gemini')
}

// AGY§8
export function summariesDb(geminiDir: string): string {
  return path.join(geminiDir, AGY_APP_DIR, 'conversation_summaries.db')
}

// AGY§8
export function agyBrain(geminiDir: string): string {
  return path.join(geminiDir, AGY_APP_DIR, 'brain')
}

// AGY§8
export function agyTranscript(geminiDir: string, conversationId: string): string {
  return path.join(agyBrain(geminiDir), conversationId, AGY_LOGS_FOLDER, 'logs', 'transcript.jsonl')
}

export const conversationDb = (geminiDir: string, id: string): string =>
  path.join(geminiDir, AGY_APP_DIR, 'conversations', `${id}.db`)

// AGY§8
export const annotationFile = (geminiDir: string, id: string): string =>
  path.join(geminiDir, AGY_APP_DIR, 'annotations', `${id}.pbtxt`)

const ANNOTATION_TITLE_RE = /^title:\s*"((?:[^"\\]|\\.)*)"/m

const PBTXT_SIMPLE_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '\\': 0x5c,
  "'": 0x27,
  '"': 0x22,
  '?': 0x3f
}

function decodePbtxtString(raw: string): string | undefined {
  const bytes: number[] = []
  for (let i = 0; i < raw.length;) {
    if (raw[i] !== '\\') {
      const cp = raw.codePointAt(i)!
      const ch = String.fromCodePoint(cp)
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b)
      i += ch.length
      continue
    }
    i++
    if (i >= raw.length) return undefined
    const esc = raw[i]
    if (esc >= '0' && esc <= '7') {
      const oct = raw.slice(i, i + 3).match(/^[0-7]{1,3}/)![0]
      bytes.push(parseInt(oct, 8) & 0xff)
      i += oct.length
    } else if (esc === 'x' || esc === 'X') {
      const hex = raw.slice(i + 1, i + 3).match(/^[0-9a-fA-F]{1,2}/)?.[0]
      if (!hex) return undefined
      bytes.push(parseInt(hex, 16))
      i += 1 + hex.length
    } else if (esc === 'u' || esc === 'U') {
      const len = esc === 'u' ? 4 : 8
      const hex = raw.slice(i + 1, i + 1 + len)
      if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) return undefined
      const cp = parseInt(hex, 16)
      if (cp > 0x10ffff) return undefined
      for (const b of Buffer.from(String.fromCodePoint(cp), 'utf8')) bytes.push(b)
      i += 1 + len
    } else if (esc in PBTXT_SIMPLE_ESCAPES) {
      bytes.push(PBTXT_SIMPLE_ESCAPES[esc])
      i++
    } else {
      return undefined
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

// AGY§8
export function parseAnnotationTitle(text: string): string | undefined {
  const matched = ANNOTATION_TITLE_RE.exec(text)
  if (!matched) return undefined
  const decoded = decodePbtxtString(matched[1])
  return decoded || undefined
}

// AGY§8
function readAnnotationTitle(geminiDir: string, id: string): string | undefined {
  try {
    return parseAnnotationTitle(fs.readFileSync(annotationFile(geminiDir, id), 'utf8'))
  } catch {
    return undefined
  }
}

// AGY§8
export async function readAgyConversationTitle(
  geminiDir: string,
  conversationId: string
): Promise<string | undefined> {
  const db = summariesDb(geminiDir)
  if (fs.existsSync(db)) {
    let sqlite: InstanceType<typeof import('node:sqlite').DatabaseSync> | undefined
    try {
      const { DatabaseSync } = await import('node:sqlite')
      sqlite = new DatabaseSync(db, { readOnly: true })
      const row = sqlite
        .prepare('select title from conversation_summaries where conversation_id = ?')
        .get(conversationId) as { title?: unknown } | undefined
      if (typeof row?.title === 'string' && row.title) return row.title
    } catch {
    } finally {
      sqlite?.close()
    }
  }
  return readAnnotationTitle(geminiDir, conversationId)
}

export interface SummaryRow {
  conversation_id: unknown
  title: unknown
  preview: unknown
  workspace_uris: unknown
  last_modified_time: unknown
  step_count: unknown
  born?: unknown
  touched?: unknown
  annotation?: unknown
}

const seconds = (ms: number): number => Math.floor(ms / 1000)

// AGY§8
const AGY_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/
const NEVER_YEAR = '0001'

function timeOf(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const m = AGY_DATETIME.exec(value)
  if (!m || m[1].startsWith(NEVER_YEAR)) return undefined
  const ms = Date.parse(`${m[1]}T${m[2]}.${(m[3] ?? '0').padEnd(3, '0').slice(0, 3)}${m[4]}`)
  return Number.isFinite(ms) ? seconds(ms) : undefined
}

function firstFolder(uris: unknown): string | undefined {
  let list: unknown
  try {
    list = typeof uris === 'string' ? JSON.parse(uris) : uris
  } catch {
    return undefined
  }
  const first = Array.isArray(list) ? list.find((u) => typeof u === 'string') : undefined
  if (!first) return undefined
  try {
    return first.startsWith('file:') ? fileURLToPath(first) : first
  } catch {
    return undefined
  }
}

// AGY§8
export const TOP_LEVEL_ROWS = `select conversation_id, title, preview, workspace_uris, last_modified_time, step_count
  from conversation_summaries
  where (parent_conversation_id is null or parent_conversation_id = '')
    and (app_data_dir is null or app_data_dir = '' or app_data_dir = '${AGY_APP_DIR}')`

const MAX_ANCESTOR_HOPS = 16

export interface AgyConversationAncestry {
  parentId: string
  ancestors: string[]
  agentName?: string
  killed?: boolean
}

// AGY§8 AGY§13
export async function ancestryOfAgyConversation(
  geminiDir: string,
  conversationId: string
): Promise<AgyConversationAncestry | undefined> {
  const db = summariesDb(geminiDir)
  if (!fs.existsSync(db)) return undefined
  const { DatabaseSync } = await import('node:sqlite')
  const sqlite = new DatabaseSync(db, { readOnly: true })
  try {
    let stmt: ReturnType<InstanceType<typeof DatabaseSync>['prepare']>
    try {
      stmt = sqlite.prepare(
        'select parent_conversation_id, agent_name, killed from conversation_summaries where conversation_id = ?'
      )
    } catch {
      stmt = sqlite.prepare(
        'select parent_conversation_id from conversation_summaries where conversation_id = ?'
      )
    }
    const first = stmt.get(conversationId) as
      { parent_conversation_id?: unknown; agent_name?: unknown; killed?: unknown } | undefined
    if (!first) return undefined
    const parentId = nonEmptyString(first.parent_conversation_id) ?? ''
    const agentName = nonEmptyString(first.agent_name)
    const killed = first.killed === 1 || first.killed === true
    if (!parentId) {
      return {
        parentId: '',
        ancestors: [],
        ...(agentName && { agentName }),
        ...(killed && { killed: true })
      }
    }
    const ancestors = [parentId]
    const seen = new Set([conversationId, parentId])
    let cur: string | undefined = parentId
    while (cur && ancestors.length < MAX_ANCESTOR_HOPS) {
      const nextRow = stmt.get(cur) as { parent_conversation_id?: unknown } | undefined
      const nextParent = nonEmptyString(nextRow?.parent_conversation_id)
      if (!nextParent || seen.has(nextParent)) break
      seen.add(nextParent)
      ancestors.push(nextParent)
      cur = nextParent
    }
    return {
      parentId,
      ancestors,
      ...(agentName && { agentName }),
      ...(killed && { killed: true })
    }
  } catch {
    return undefined
  } finally {
    sqlite.close()
  }
}

// AGY§8
function readStepsWithoutSummary(row: SummaryRow, geminiDir: string, id: string): boolean {
  const transcript = fs.statSync(agyTranscript(geminiDir, id), { throwIfNoEntry: false })
  if (!transcript?.size) return false
  row.touched = transcript.mtimeMs
  return true
}

export async function listAgyConversations(geminiDir: string): Promise<HistoryEntry[]> {
  const db = summariesDb(geminiDir)
  if (!fs.existsSync(db)) return []
  const { DatabaseSync } = await import('node:sqlite')
  const sqlite = new DatabaseSync(db, { readOnly: true })
  let rows: SummaryRow[]
  try {
    rows = sqlite.prepare(TOP_LEVEL_ROWS).all() as unknown as SummaryRow[]
  } finally {
    sqlite.close()
  }
  const kept = rows.filter((row) => {
    const id = row.conversation_id
    if (typeof id !== 'string') return false
    const st = fs.statSync(conversationDb(geminiDir, id), { throwIfNoEntry: false })
    if (!st) return false
    if (!(Number(row.step_count) > 0) && !readStepsWithoutSummary(row, geminiDir, id)) return false
    row.born = st.birthtimeMs || st.ctimeMs
    if (!row.title) row.title = readAnnotationTitle(geminiDir, id)
    return true
  })
  return historyEntries(kept)
}

export function historyEntries(rows: SummaryRow[]): HistoryEntry[] {
  return rows.flatMap((row) => {
    const id = row.conversation_id
    const cwd = firstFolder(row.workspace_uris)
    if (typeof id !== 'string' || !id || !cwd) return []
    const touched = typeof row.touched === 'number' ? seconds(row.touched) : undefined
    const updatedAt = timeOf(row.last_modified_time) ?? touched
    const born = typeof row.born === 'number' ? row.born : undefined
    const annotated =
      typeof row.annotation === 'string' ? parseAnnotationTitle(row.annotation) : undefined
    const entry: HistoryEntry = {
      id,
      cwd,
      name: (typeof row.title === 'string' && row.title) || annotated || null,
      preview: typeof row.preview === 'string' ? row.preview : undefined,
      createdAt: born ? seconds(born) : updatedAt,
      updatedAt
    }
    return [entry]
  })
}

// AGY§8
export const AGY_LIST_JS = `import fs from 'fs'
import { DatabaseSync } from 'node:sqlite'
const [dir, sql] = process.argv.slice(2)
const db = dir + '/conversation_summaries.db'
let rows = []
if (fs.existsSync(db)) {
  const sqlite = new DatabaseSync(db, { readOnly: true })
  try {
    rows = sqlite.prepare(sql).all()
  } finally {
    sqlite.close()
  }
}
const stepsWithoutSummary = (row) => {
  const id = row.conversation_id
  const transcript = fs.statSync(dir + '/brain/' + id + '/${AGY_LOGS_FOLDER}/logs/transcript.jsonl')
  if (transcript.size === 0) return false
  row.touched = transcript.mtimeMs
  return true
}
rows = rows.filter((row) => {
  try {
    const st = fs.statSync(dir + '/conversations/' + row.conversation_id + '.db')
    if (!(row.step_count > 0) && !stepsWithoutSummary(row)) return false
    row.born = st.birthtimeMs || st.ctimeMs
    if (!row.title) {
      try {
        row.annotation = fs.readFileSync(dir + '/annotations/' + row.conversation_id + '.pbtxt', 'utf8')
      } catch {}
    }
    return true
  } catch {
    return false
  }
})
process.stdout.write(JSON.stringify(rows))
`

const USER_REQUEST = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/

// AGY§2 AGY§8
export function ownersWords(content: string): string {
  return (USER_REQUEST.exec(content)?.[1] ?? content).trim()
}

export interface TranscriptStep {
  type: string
  content: string
  at: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

export function stepOf(line: string): TranscriptStep | undefined {
  let r: Record<string, unknown>
  try {
    r = record(JSON.parse(line))
  } catch {
    return undefined
  }
  if (typeof r.type !== 'string') return undefined
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
  return {
    type: r.type,
    content: typeof r.content === 'string' ? r.content : '',
    at: (timeOf(r.created_at) ?? 0) * 1000,
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadTokens: num(r.cache_read_tokens)
  }
}

// AGY§8
export async function eachTranscriptStep(
  file: string,
  each: (step: TranscriptStep) => boolean | void
): Promise<void> {
  if (!fs.existsSync(file)) return
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const step = line && stepOf(line)
      if (step && each(step) === true) return
    }
  } finally {
    lines.close()
  }
}

const saidOf = (step: TranscriptStep): SaidLine | undefined =>
  step.type === 'USER_INPUT'
    ? { who: 'owner', text: ownersWords(step.content), at: step.at }
    : step.type === 'PLANNER_RESPONSE' && step.content
      ? { who: 'assistant', text: step.content, at: step.at }
      : undefined

// AGY§8
export async function readAgyTurns(file: string, n: number): Promise<Turn[]> {
  const turns: Turn[] = []
  await eachTranscriptStep(file, (step) => addToTurns(turns, step))
  return turns.slice(-n)
}

function addToTurns(turns: Turn[], step: TranscriptStep): void {
  const said = saidOf(step)
  if (!said) return
  const open = turns[turns.length - 1]
  if (said.who === 'owner' || !open) turns.push({ said: [], reply: '', at: said.at })
  const turn = turns[turns.length - 1]
  if (said.who === 'owner') turn.said.push(said)
  else turn.reply = turn.reply ? `${turn.reply}\n\n${said.text}` : said.text
  turn.at = said.at
}

// AGY§8
export async function saidInTranscript(
  file: string,
  each: (text: string) => boolean | void
): Promise<void> {
  await eachTranscriptStep(file, (step) => {
    const said = saidOf(step)
    return said ? each(said.text) : undefined
  })
}

const DIFF_BLOCK = /\[diff_block_start\]([\s\S]*?)\[diff_block_end\]/g

// AGY§8
export function diffCounts(content: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const [, block] of content.matchAll(DIFF_BLOCK))
    for (const line of block.split('\n')) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  return { added, removed }
}

export async function lastDiffFor(file: string, target: string): Promise<string | undefined> {
  let found: string | undefined
  await eachTranscriptStep(file, (step) => {
    if (
      step.type === 'GENERIC' &&
      step.content.includes('[diff_block_start]') &&
      step.content.includes(target)
    )
      found = step.content
  })
  return found
}

export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
}

export interface TurnsAndTokens {
  turns: Turn[]
  tokens: TokenTotals
}

// AGY§8
export class TranscriptFollower {
  private cursor: AppendCursor = { offset: 0, tail: [] }
  private turns: Turn[] = []
  private tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0 }
  private toldReply = new WeakMap<Turn, string>()
  private historyUnread: boolean
  private reading: Promise<unknown>

  constructor(
    readonly file: string,
    historyReadable?: Promise<void>
  ) {
    this.historyUnread = !!historyReadable
    this.reading = historyReadable
      ? historyReadable.then(() => this.readWhatWasAdded(true)).catch(() => {})
      : Promise.resolve()
  }

  catchUp(): Promise<TurnsAndTokens> {
    const read = this.reading.then(() => this.readWhatWasAdded(false))
    this.reading = read.catch(() => undefined)
    return read
  }

  private async readWhatWasAdded(asHistory: boolean): Promise<TurnsAndTokens> {
    const unreadable = { turns: [], tokens: { ...this.tokens } }
    const size = (await fs.promises.stat(this.file).catch(() => undefined))?.size
    if (size === undefined || (asHistory && size === 0)) return unreadable
    let endedTurnsAreHistory = this.historyUnread
    if (size < this.cursor.offset) {
      this.cursor = { offset: 0, tail: [] }
      this.turns = []
      this.tokens = { input: 0, output: 0, cacheRead: 0 }
      endedTurnsAreHistory = true
    }
    const ended: Turn[] = []
    while (this.cursor.offset < size) {
      const from = this.cursor.offset
      const lines = await readAppendedLines(this.file, size, this.cursor)
      if (lines === null) return unreadable
      if (this.cursor.offset === from) break
      for (const line of lines) {
        const step = line && stepOf(line)
        if (step) this.add(step, ended)
      }
    }
    const lineWithNoNewlineYet =
      this.cursor.tail.length && stepOf(Buffer.concat(this.cursor.tail).toString('utf8'))
    if (lineWithNoNewlineYet) {
      this.add(lineWithNoNewlineYet, ended)
      this.cursor.tail = []
    }
    const [last] = this.turns
    const history = [...(endedTurnsAreHistory ? ended : []), ...(asHistory ? this.turns : [])]
    for (const turn of history) this.toldReply.set(turn, turn.reply)
    this.historyUnread = false
    const due = last ? [...ended, last] : ended
    const turns = due.filter((turn) => this.toldReply.get(turn) !== turn.reply)
    for (const turn of turns) this.toldReply.set(turn, turn.reply)
    return {
      turns: turns.map((turn) => ({ ...turn, said: [...turn.said] })),
      tokens: { ...this.tokens }
    }
  }

  private add(step: TranscriptStep, ended: Turn[]): void {
    addToTurns(this.turns, step)
    if (this.turns.length > 1) ended.push(...this.turns.splice(0, 1))
    if (step.type !== 'PLANNER_RESPONSE') return
    this.tokens.input += step.inputTokens
    this.tokens.output += step.outputTokens
    this.tokens.cacheRead += step.cacheReadTokens
  }
}
