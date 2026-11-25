import type { ModelPricing } from '@shared/pricing'

const M = 1_000_000
const K200 = 200_000

// CC§7
function tier(
  inPerM: number,
  outPerM: number,
  windowTokens: number,
  cacheReadPerM = inPerM * 0.1
): ModelPricing {
  return {
    inPerM,
    outPerM,
    cacheWritePerM: inPerM * 1.25,
    cacheWrite1hPerM: inPerM * 2,
    cacheReadPerM,
    windowTokens
  }
}

// CC§7
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-fable-5-2': tier(8, 40, M, 0.2),
  'claude-fable-5-1': tier(10, 50, M, 0.25),
  'claude-fable-5': tier(10, 50, M),
  'claude-mythos-5': tier(10, 50, M),
  'claude-opus-5-5': tier(4, 20, M, 0.2),
  'claude-opus-5': tier(5, 25, M),
  'claude-opus-4-8': tier(5, 25, M),
  'claude-opus-4-7': tier(5, 25, M),
  'claude-opus-4-6': tier(5, 25, M),
  'claude-opus-4-5': tier(5, 25, K200),
  'claude-opus-4-1': tier(15, 75, K200),
  'claude-opus-4-0': tier(15, 75, K200),
  // CC§2
  'claude-opus-4-20250514': tier(15, 75, K200),
  'claude-sonnet-5-5': tier(2, 10, M, 0.1),
  'claude-sonnet-5': tier(2, 10, M),
  'claude-sonnet-4-6': tier(3, 15, M),
  'claude-sonnet-4-5': tier(3, 15, K200),
  'claude-sonnet-4-0': tier(3, 15, K200),
  'claude-sonnet-4-20250514': tier(3, 15, K200),
  'claude-haiku-5-5': tier(0.1, 0.5, M),
  'claude-haiku-4-5': tier(1, 5, K200)
}

const KEYS = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length)
const DATE_STAMP = /^\d{8}$/

export function claudePriceOf(model: string): ModelPricing | undefined {
  const exact = MODEL_PRICING[model]
  if (exact) return exact
  for (const k of KEYS) {
    if (model.startsWith(k + '-') && DATE_STAMP.test(model.slice(k.length + 1)))
      return MODEL_PRICING[k]
  }
  return undefined
}
