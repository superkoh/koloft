import { DATE_STAMP, KEYS, MODEL_PRICING } from '@agents/claude/shared/claudePrices'
import { OPENAI_PRICING } from '@agents/codex/shared/codexPrices'
import { geminiPricing } from '@agents/agy/shared/agyPrices'

export interface ModelPricing {
  inPerM: number
  outPerM: number
  cacheWritePerM: number
  cacheWrite1hPerM: number
  cacheReadPerM: number
  windowTokens: number
  longContext?: LongContextTier
}

export interface LongContextTier {
  aboveInputTokens: number
  inPerM: number
  cacheReadPerM: number
  outPerM: number
}

export function resolvePricing(model: string): ModelPricing | undefined {
  if (!model) return undefined
  const exact = MODEL_PRICING[model] ?? OPENAI_PRICING[model] ?? geminiPricing(model)
  if (exact) return exact
  for (const k of KEYS) {
    if (model.startsWith(k + '-') && DATE_STAMP.test(model.slice(k.length + 1)))
      return MODEL_PRICING[k]
  }
  return undefined
}

export interface TokenCounts {
  inTok: number
  outTok: number
  cacheWriteTok: number
  cacheWrite1hTok: number
  cacheReadTok: number
}

export const TOKEN_FIELDS = [
  'inTok',
  'outTok',
  'cacheWriteTok',
  'cacheWrite1hTok',
  'cacheReadTok'
] as const

export function costUsdOf(pricing: ModelPricing, t: TokenCounts): number {
  return (
    (t.inTok * pricing.inPerM +
      t.outTok * pricing.outPerM +
      Math.max(0, t.cacheWriteTok - t.cacheWrite1hTok) * pricing.cacheWritePerM +
      t.cacheWrite1hTok * pricing.cacheWrite1hPerM +
      t.cacheReadTok * pricing.cacheReadPerM) /
    1_000_000
  )
}

export function longContextSurchargeUsd(pricing: ModelPricing, request: TokenCounts): number {
  const long = pricing.longContext
  if (!long || request.inTok + request.cacheReadTok <= long.aboveInputTokens) return 0
  return costUsdOf({ ...pricing, ...long }, request) - costUsdOf(pricing, request)
}
