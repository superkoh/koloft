import type { SessionUsage } from '@shared/types'
import { costUsdOf, resolvePricing, TOKEN_FIELDS, type TokenCounts } from '@shared/pricing'
import { localDayKey } from '@shared/usageFormat'
import type { TranscriptRecord } from './transcriptRecord'

function num(x: unknown): number {
  return typeof x === 'number' && isFinite(x) && x > 0 ? x : 0
}

function growthOver(booked: TokenCounts, line: TokenCounts): TokenCounts {
  const grown = { ...line }
  for (const f of TOKEN_FIELDS) grown[f] = Math.max(0, line[f] - booked[f])
  return grown
}

export class UsageMeter {
  private seen = new Map<string, TokenCounts>()
  private counted = false
  private tokens: TokenCounts = {
    inTok: 0,
    outTok: 0,
    cacheWriteTok: 0,
    cacheWrite1hTok: 0,
    cacheReadTok: 0
  }
  private costUsd = 0
  private unknownModel = false
  private model?: string
  private ccVersion?: string
  private ctxTokens?: number
  private today = { dayKey: '', cost: 0 }

  // CC§2
  add(obj: TranscriptRecord, updateContext: boolean): void {
    const msg = obj.message
    if (!msg) return
    const model = typeof msg.model === 'string' ? msg.model : ''
    if (model === '<synthetic>') return
    const u = msg.usage || {}
    const line: TokenCounts = {
      inTok: num(u.input_tokens),
      outTok: num(u.output_tokens),
      cacheWriteTok: num(u.cache_creation_input_tokens),
      cacheWrite1hTok: num(u.cache_creation?.ephemeral_1h_input_tokens),
      cacheReadTok: num(u.cache_read_input_tokens)
    }
    let add = line
    const id = typeof msg.id === 'string' ? msg.id : ''
    const reqId = typeof obj.requestId === 'string' ? obj.requestId : ''
    if (id || reqId) {
      const key = id + ' ' + reqId
      const booked = this.seen.get(key)
      // CC§2
      if (booked) {
        add = growthOver(booked, line)
        if (TOKEN_FIELDS.every((f) => add[f] === 0)) return
        for (const f of TOKEN_FIELDS) booked[f] += add[f]
      } else {
        this.seen.set(key, { ...line })
      }
    }
    this.counted = true
    for (const f of TOKEN_FIELDS) this.tokens[f] += add[f]

    const pricing = model ? resolvePricing(model) : undefined
    if (!pricing) {
      this.unknownModel = true
    } else {
      const cost = costUsdOf(pricing, add)
      this.costUsd += cost
      const recDay = localDayKey(obj.timestamp)
      if (recDay) {
        if (recDay > this.today.dayKey) this.today = { dayKey: recDay, cost: 0 }
        if (recDay === this.today.dayKey) this.today.cost += cost
      }
    }
    if (updateContext) {
      if (model) this.model = model
      this.ctxTokens = line.inTok + line.cacheReadTok + line.cacheWriteTok
      if (typeof obj.version === 'string' && obj.version) this.ccVersion = obj.version
    }
  }

  usage(): SessionUsage | undefined {
    if (!this.counted) return undefined
    const pricing = this.model ? resolvePricing(this.model) : undefined
    const ctxPct =
      pricing && this.ctxTokens != null ? this.ctxTokens / pricing.windowTokens : undefined
    const hasToday = !this.unknownModel && this.today.cost > 0 && !!this.today.dayKey
    return {
      ...this.tokens,
      costUsd: this.unknownModel ? undefined : this.costUsd,
      todayCostUsd: hasToday ? this.today.cost : undefined,
      todayDayKey: hasToday ? this.today.dayKey : undefined,
      model: this.model,
      ccVersion: this.ccVersion,
      ctxTokens: this.ctxTokens,
      ctxPct
    }
  }
}
