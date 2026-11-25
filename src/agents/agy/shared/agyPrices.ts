import type { ModelPricing } from '@shared/pricing'

const GEMINI_WINDOW_TOKENS = 1_048_576

function gemini(inPerM: number, cacheReadPerM: number, outPerM: number): ModelPricing {
  return {
    inPerM,
    outPerM,
    cacheWritePerM: 0,
    cacheWrite1hPerM: 0,
    cacheReadPerM,
    windowTokens: GEMINI_WINDOW_TOKENS
  }
}

// AGY§21
export const GEMINI_PRICING: Record<string, ModelPricing> = {
  'gemini-3.1-pro': gemini(2, 0.2, 12),
  'gemini-3.8-flash': gemini(0.75, 0.075, 3.75),
  'gemini-3.6-flash': gemini(0.75, 0.075, 3.75),
  'gemini-3.1-flash-lite': gemini(0.25, 0.025, 1.5)
}

// AGY§21
const GEMINI_VARIANT = /-(?:preview|low|medium|high|xhigh|max)$/

export function geminiPricing(model: string): ModelPricing | undefined {
  let base = model
  while (GEMINI_VARIANT.test(base)) base = base.replace(GEMINI_VARIANT, '')
  return GEMINI_PRICING[base]
}
