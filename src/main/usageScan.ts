import {
  longContextSurchargeUsd,
  resolvePricing,
  TOKEN_FIELDS,
  type TokenCounts
} from '@shared/pricing'
import type { UsageRecord } from '@shared/types'
import { localDayKey } from '@shared/usageFormat'
import { stepOf } from './agyStore'
import { logRecord, runEvent } from './museSessionLog'

interface CodexScan {
  sessionId: string
  cwd: string
  records: UsageRecord[]
}

export const CLAUDE_USAGE_WORDS = ['"usage"']
export const CODEX_USAGE_WORDS = ['session_meta', 'turn_context', 'token_usage_record']
export const MUSE_USAGE_WORDS = ['model_completed']
export const AGY_USAGE_WORDS = ['PLANNER_RESPONSE']

function num(x: unknown): number {
  return typeof x === 'number' && isFinite(x) && x > 0 ? x : 0
}

export function topLevelTimestampOf(line: string): string | undefined {
  try {
    const at = JSON.parse(line).timestamp
    return typeof at === 'string' ? at : undefined
  } catch {
    return undefined
  }
}

function parsedLines(text: string): any[] {
  const out: any[] = []
  for (const line of text.split('\n')) {
    try {
      out.push(JSON.parse(line))
    } catch {
      continue
    }
  }
  return out
}

class RecordsByDayAndModel {
  private byKey = new Map<string, UsageRecord>()

  add(sessionId: string, day: string, model: string, call: TokenCounts): void {
    const pricing = resolvePricing(model)
    const surchargeUsd = pricing ? longContextSurchargeUsd(pricing, call) : 0
    const key = sessionId + '\n' + day + '\n' + model
    const rec = this.byKey.get(key)
    if (!rec) {
      this.byKey.set(key, { sessionId, day, model, ...call, surchargeUsd })
      return
    }
    for (const f of TOKEN_FIELDS) rec[f] += call[f]
    rec.surchargeUsd += surchargeUsd
  }

  list(): UsageRecord[] {
    return [...this.byKey.values()]
  }
}

interface ClaudeCall {
  key: string
  sessionId: string
  day: string
  model: string
  tokens: TokenCounts
}

export interface ClaudeCalls {
  sessions: string[]
  days: string[]
  models: string[]
  calls: string
}

const CALL_SEPARATOR = ';'
const FIELD_SEPARATOR = ','

function shortHashOf(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 16777619)
    b = Math.imul(b ^ c, 2246822519)
  }
  return ((a >>> 0) * 2 ** 21 + ((b >>> 0) & 0x1fffff)).toString(36)
}

function indexIn(list: string[], value: string): number {
  const at = list.indexOf(value)
  return at >= 0 ? at : list.push(value) - 1
}

function packClaudeCalls(calls: ClaudeCall[]): ClaudeCalls {
  const packed: ClaudeCalls = { sessions: [], days: [], models: [], calls: '' }
  packed.calls = calls
    .map((c) =>
      [
        c.key && shortHashOf(c.key),
        indexIn(packed.sessions, c.sessionId),
        indexIn(packed.days, c.day),
        indexIn(packed.models, c.model),
        ...TOKEN_FIELDS.map((f) => c.tokens[f])
      ].join(FIELD_SEPARATOR)
    )
    .join(CALL_SEPARATOR)
  return packed
}

function packedEntries(c: ClaudeCalls): string[] {
  return c.calls ? c.calls.split(CALL_SEPARATOR) : []
}

export function claudeCallKeys(c: ClaudeCalls): string[] {
  return packedEntries(c).map((e) => e.slice(0, e.indexOf(FIELD_SEPARATOR)))
}

export function recordsOfClaudeCalls(c: ClaudeCalls, skip?: Set<string>): UsageRecord[] {
  const out = new RecordsByDayAndModel()
  for (const entry of packedEntries(c)) {
    const [key, session, day, model, ...counts] = entry.split(FIELD_SEPARATOR)
    if (key && skip?.has(key)) continue
    const tokens = {} as TokenCounts
    TOKEN_FIELDS.forEach((f, i) => (tokens[f] = Number(counts[i])))
    out.add(c.sessions[+session], c.days[+day], c.models[+model], tokens)
  }
  return out.list()
}

// CC§2
export function scanClaudeCalls(text: string): ClaudeCalls {
  const calls: ClaudeCall[] = []
  const callByIds = new Map<string, ClaudeCall>()
  for (const obj of parsedLines(text)) {
    const msg = obj?.message
    if (obj.type !== 'assistant' || !msg?.usage || typeof msg.usage !== 'object') continue
    const model = typeof msg.model === 'string' ? msg.model : ''
    if (model === '<synthetic>') continue
    const day = localDayKey(obj.timestamp)
    if (!day || typeof obj.sessionId !== 'string') continue
    const u = msg.usage
    const tokens: TokenCounts = {
      inTok: num(u.input_tokens),
      outTok: num(u.output_tokens),
      cacheWriteTok: num(u.cache_creation_input_tokens),
      cacheWrite1hTok: num(u.cache_creation?.ephemeral_1h_input_tokens),
      cacheReadTok: num(u.cache_read_input_tokens)
    }
    const id = typeof msg.id === 'string' ? msg.id : ''
    const reqId = typeof obj.requestId === 'string' ? obj.requestId : ''
    const key = id || reqId ? id + ' ' + reqId : ''
    const seen = key ? callByIds.get(key) : undefined
    if (seen) {
      for (const f of TOKEN_FIELDS) seen.tokens[f] = Math.max(seen.tokens[f], tokens[f])
      continue
    }
    const call = { key, sessionId: obj.sessionId, day, model, tokens }
    calls.push(call)
    if (key) callByIds.set(key, call)
  }
  return packClaudeCalls(calls)
}

// CODEX§13
export function scanCodexLines(text: string): CodexScan | null {
  let meta: any
  const modelByTurn = new Map<string, string>()
  const booked = new Set<string>()
  const out = new RecordsByDayAndModel()
  let sessionId = ''
  for (const obj of parsedLines(text)) {
    const p = obj?.payload
    if (!p || typeof p !== 'object') continue
    if (obj.type === 'session_meta' && !meta) {
      meta = p
      const parent = p.source?.subagent?.thread_spawn?.parent_thread_id
      sessionId = typeof parent === 'string' ? parent : String(p.id ?? '')
    } else if (obj.type === 'turn_context' && typeof p.model === 'string') {
      modelByTurn.set(p.turn_id, p.model)
    } else if (obj.type === 'token_usage_record' && meta && !booked.has(p.response_id)) {
      const day = localDayKey(obj.timestamp)
      const u = p.usage
      if (!day || !u || typeof u !== 'object') continue
      booked.add(p.response_id)
      const input = num(u.input_tokens)
      const cached = num(u.cached_input_tokens)
      out.add(sessionId, day, modelByTurn.get(p.turn_id) ?? '', {
        inTok: Math.max(0, input - cached),
        outTok: num(u.output_tokens),
        cacheReadTok: cached,
        cacheWriteTok: num(u.cache_write_input_tokens),
        cacheWrite1hTok: 0
      })
    }
  }
  if (!meta || !sessionId) return null
  return { sessionId, cwd: typeof meta.cwd === 'string' ? meta.cwd : '', records: out.list() }
}

// MUSE§2
export function scanMuseLines(text: string, sessionId: string): UsageRecord[] {
  const out = new RecordsByDayAndModel()
  for (const line of text.split('\n')) {
    const r = logRecord(line)
    const event = r && runEvent(r, 'model_completed')
    const u = event?.usage as Record<string, unknown> | undefined
    const day = localDayKey(r?.atMs)
    if (!u || typeof u !== 'object' || !day) continue
    out.add(sessionId, day, typeof event?.model === 'string' ? event.model : '', {
      inTok: Math.max(0, num(u.input_tokens) - num(u.cache_read_tokens)),
      outTok: num(u.output_tokens),
      cacheReadTok: num(u.cache_read_tokens),
      cacheWriteTok: num(u.cache_write_tokens),
      cacheWrite1hTok: 0
    })
  }
  return out.list()
}

// AGY§8
export function scanAgyLines(
  text: string,
  sessionId: string,
  modelOfCall: string[],
  configuredModel: string
): UsageRecord[] {
  const out = new RecordsByDayAndModel()
  let call = 0
  for (const line of text.split('\n')) {
    const step = stepOf(line)
    if (step?.type !== 'PLANNER_RESPONSE') continue
    const model = modelOfCall[call++] || configuredModel
    const tokens: TokenCounts = {
      inTok: num(step.inputTokens),
      outTok: num(step.outputTokens),
      cacheReadTok: num(step.cacheReadTokens),
      cacheWriteTok: 0,
      cacheWrite1hTok: 0
    }
    if (!tokens.inTok && !tokens.outTok && !tokens.cacheReadTok) continue
    if (step.at) out.add(sessionId, localDayKey(step.at), model, tokens)
  }
  return out.list()
}

function varint(b: Uint8Array, at: number): [number, number] {
  let value = 0
  let scale = 1
  let i = at
  for (;;) {
    if (i >= b.length) return [NaN, i]
    const c = b[i++]
    value += (c & 0x7f) * scale
    if (c < 0x80) return [value, i]
    scale *= 128
  }
}

// AGY§8
export function protobufString(b: Uint8Array, fieldPath: number[]): string | undefined {
  let i = 0
  while (i < b.length) {
    const [key, afterKey] = varint(b, i)
    if (isNaN(key)) return undefined
    const field = Math.floor(key / 8)
    const wire = key % 8
    i = afterKey
    if (wire === 0) i = varint(b, i)[1]
    else if (wire === 1) i += 8
    else if (wire === 5) i += 4
    else if (wire === 2) {
      const [len, start] = varint(b, i)
      if (isNaN(len)) return undefined
      i = start + len
      if (field !== fieldPath[0]) continue
      const chunk = b.subarray(start, i)
      if (fieldPath.length === 1) return Buffer.from(chunk).toString('utf8')
      const inner = protobufString(chunk, fieldPath.slice(1))
      if (inner !== undefined) return inner
    } else return undefined
  }
  return undefined
}
