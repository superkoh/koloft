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

const CODEX_WINDOW_TOKENS = 272_000

function openAi(
  inPerM: number,
  cacheReadPerM: number,
  outPerM: number,
  longContext?: LongContextTier
): ModelPricing {
  return {
    inPerM,
    outPerM,
    cacheWritePerM: 0,
    cacheWrite1hPerM: 0,
    cacheReadPerM,
    windowTokens: CODEX_WINDOW_TOKENS,
    longContext
  }
}

const OPENAI_LONG_CONTEXT_INPUT_TOKENS = 272_000

function openAiLong(inPerM: number, cacheReadPerM: number, outPerM: number): LongContextTier {
  return { aboveInputTokens: OPENAI_LONG_CONTEXT_INPUT_TOKENS, inPerM, cacheReadPerM, outPerM }
}

// CODEX§13
export const OPENAI_PRICING: Record<string, ModelPricing> = {
  'gpt-6.1-sol': openAi(2, 0.1, 10, openAiLong(4, 0.2, 15)),
  'gpt-6-astra': openAi(10, 1, 50, openAiLong(20, 2, 75)),
  'gpt-6-sol': openAi(2, 0.2, 10, openAiLong(4, 0.4, 15)),
  'gpt-6-luna': openAi(0.1, 0.01, 0.5, openAiLong(0.2, 0.02, 0.75)),
  'gpt-5.6-sol': openAi(4, 0.4, 20, openAiLong(8, 0.8, 30)),
  'gpt-5.6-terra': openAi(2, 0.2, 12, openAiLong(4, 0.4, 18)),
  'gpt-5.6-luna': openAi(0.2, 0.02, 1.2, openAiLong(0.4, 0.04, 1.8)),
  'gpt-5.5': openAi(5, 0.5, 30),
  'gpt-5.4': openAi(2.5, 0.25, 15),
  'gpt-5.3-codex': openAi(1.75, 0.175, 14),
  'gpt-5.2': openAi(1.75, 0.175, 14),
  'gpt-5.1': openAi(1.25, 0.125, 10),
  'gpt-5': openAi(1.25, 0.125, 10)
}

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

function geminiPricing(model: string): ModelPricing | undefined {
  let base = model
  while (GEMINI_VARIANT.test(base)) base = base.replace(GEMINI_VARIANT, '')
  return GEMINI_PRICING[base]
}

// CC§7
export const MODEL_PRICING: Record<string, ModelPricing> = {
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
