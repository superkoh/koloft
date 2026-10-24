import fs from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'
import type { SaidLine, Turn } from '@shared/turns'
import { record } from './codexObservation'
import type { HistoryEntry } from './storedSessions'

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
export function agyTranscript(geminiDir: string, conversationId: string): string {
  return path.join(
    geminiDir,
    AGY_APP_DIR,
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  )
}

export const conversationDb = (geminiDir: string, id: string): string =>
  path.join(geminiDir, AGY_APP_DIR, 'conversations', `${id}.db`)

export interface SummaryRow {
  conversation_id: unknown
  title: unknown
  preview: unknown
  workspace_uris: unknown
  last_modified_time: unknown
  step_count: unknown
  born?: unknown
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
    and (app_data_dir is null or app_data_dir = '' or app_data_dir = '${AGY_APP_DIR}')
    and step_count > 0`

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
    if (typeof row.conversation_id !== 'string') return false
    const st = fs.statSync(conversationDb(geminiDir, row.conversation_id), {
      throwIfNoEntry: false
    })
    if (st) row.born = st.birthtimeMs || st.ctimeMs
    return !!st
  })
  return historyEntries(kept)
}

export function historyEntries(rows: SummaryRow[]): HistoryEntry[] {
  return rows.flatMap((row) => {
    const id = row.conversation_id
    const cwd = firstFolder(row.workspace_uris)
    if (typeof id !== 'string' || !id || !cwd) return []
    const updatedAt = timeOf(row.last_modified_time)
    const born = typeof row.born === 'number' ? row.born : undefined
    const entry: HistoryEntry = {
      id,
      cwd,
      name: typeof row.title === 'string' && row.title ? row.title : null,
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
const [db, sql, conversations] = process.argv.slice(2)
let rows = []
if (fs.existsSync(db)) {
  const sqlite = new DatabaseSync(db, { readOnly: true })
  try {
    rows = sqlite.prepare(sql).all()
  } finally {
    sqlite.close()
  }
}
rows = rows.filter((row) => {
  try {
    const st = fs.statSync(conversations + '/' + row.conversation_id + '.db')
    row.born = st.birthtimeMs || st.ctimeMs
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

function stepOf(line: string): TranscriptStep | undefined {
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
  await eachTranscriptStep(file, (step) => {
    const said = saidOf(step)
    if (!said) return
    const open = turns[turns.length - 1]
    if (said.who === 'owner' || !open) turns.push({ said: [], reply: '', at: said.at })
    const turn = turns[turns.length - 1]
    if (said.who === 'owner') turn.said.push(said)
    else turn.reply = turn.reply ? `${turn.reply}\n\n${said.text}` : said.text
    turn.at = said.at
  })
  return turns.slice(-n)
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

// AGY§8
export async function tokenTotals(file: string): Promise<TokenTotals> {
  const totals: TokenTotals = { input: 0, output: 0, cacheRead: 0 }
  await eachTranscriptStep(file, (step) => {
    if (step.type !== 'PLANNER_RESPONSE') return
    totals.input += step.inputTokens
    totals.output += step.outputTokens
    totals.cacheRead += step.cacheReadTokens
  })
  return totals
}
