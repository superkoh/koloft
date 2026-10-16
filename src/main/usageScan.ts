import type { TokenCounts } from '@shared/pricing'
import { localDayKey } from '@shared/usageFormat'

export interface UsageRecord extends TokenCounts {
  sessionId: string
  day: string
  model: string
}

export interface CodexScan {
  sessionId: string
  cwd: string
  records: UsageRecord[]
}

const TOKEN_FIELDS = ['inTok', 'outTok', 'cacheWriteTok', 'cacheReadTok'] as const

function num(x: unknown): number {
  return typeof x === 'number' && isFinite(x) && x > 0 ? x : 0
}

function parsedLines(text: string, mustHave: string[]): any[] {
  const out: any[] = []
  for (const line of text.split('\n')) {
    if (!mustHave.some((word) => line.includes(word))) continue
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

  add(sessionId: string, day: string, model: string, tokens: TokenCounts): void {
    const key = sessionId + '\n' + day + '\n' + model
    const rec = this.byKey.get(key)
    if (!rec) {
      this.byKey.set(key, { sessionId, day, model, ...tokens })
      return
    }
    for (const f of TOKEN_FIELDS) rec[f] += tokens[f]
  }

  list(): UsageRecord[] {
    return [...this.byKey.values()]
  }
}

interface ClaudeCall {
  sessionId: string
  day: string
  model: string
  tokens: TokenCounts
}

// CC§2
export function scanClaudeLines(text: string): UsageRecord[] {
  const calls: ClaudeCall[] = []
  const callByIds = new Map<string, ClaudeCall>()
  for (const obj of parsedLines(text, ['"usage"'])) {
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
      cacheReadTok: num(u.cache_read_input_tokens)
    }
    const id = typeof msg.id === 'string' ? msg.id : ''
    const reqId = typeof obj.requestId === 'string' ? obj.requestId : ''
    const seen = id || reqId ? callByIds.get(id + ' ' + reqId) : undefined
    if (seen) {
      for (const f of TOKEN_FIELDS) seen.tokens[f] = Math.max(seen.tokens[f], tokens[f])
      continue
    }
    const call = { sessionId: obj.sessionId, day, model, tokens }
    calls.push(call)
    if (id || reqId) callByIds.set(id + ' ' + reqId, call)
  }
  const out = new RecordsByDayAndModel()
  for (const c of calls) out.add(c.sessionId, c.day, c.model, c.tokens)
  return out.list()
}

// CODEX§13
export function scanCodexLines(text: string): CodexScan | null {
  let meta: any
  const modelByTurn = new Map<string, string>()
  const booked = new Set<string>()
  const out = new RecordsByDayAndModel()
  let sessionId = ''
  for (const obj of parsedLines(text, ['session_meta', 'turn_context', 'token_usage_record'])) {
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
        cacheWriteTok: num(u.cache_write_input_tokens)
      })
    }
  }
  if (!meta || !sessionId) return null
  return { sessionId, cwd: typeof meta.cwd === 'string' ? meta.cwd : '', records: out.list() }
}
