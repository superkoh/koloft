import type { PriceList } from '@shared/pricing'
import type { UsageRecord } from '@shared/types'
import { localDayKey } from '@shared/usageFormat'
import type { UsageWorkerScan } from '@core/agent/usage'
import { linesWithAny, num, parsedLines, RecordsByDayAndModel } from '@agents/kit/main/usageLines'
import { codexPriceOf } from '../shared/codexPrices'

interface CodexScan {
  sessionId: string
  cwd: string
  records: UsageRecord[]
}

export const CODEX_USAGE_WORDS = ['session_meta', 'turn_context', 'token_usage_record']

// CODEX§13
export function scanCodexLines(text: string, priceOf: PriceList): CodexScan | null {
  let meta: any
  const modelByTurn = new Map<string, string>()
  const booked = new Set<string>()
  const out = new RecordsByDayAndModel(priceOf)
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

export const usageWorkerScan: UsageWorkerScan = {
  id: 'codex',
  priceOf: codexPriceOf,
  async scan(f, priceOf) {
    const codex = scanCodexLines((await linesWithAny(f.file, CODEX_USAGE_WORDS)).text, priceOf)
    return { records: codex?.records ?? [], cwd: codex?.cwd }
  }
}
