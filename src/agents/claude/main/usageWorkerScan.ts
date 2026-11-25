import { TOKEN_FIELDS, type TokenCounts } from '@shared/pricing'
import type { UsageRecord } from '@shared/types'
import { localDayKey } from '@shared/usageFormat'
import { num, parsedLines, RecordsByDayAndModel } from '@agents/kit/main/usageLines'

export const CLAUDE_USAGE_WORDS = ['"usage"']

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
