import type { LongContextTier, ModelPricing } from '@shared/pricing'

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
  'gpt-6.2-sol': openAi(2, 0.1, 10, openAiLong(4, 0.2, 15)),
  'gpt-6.2-astra': openAi(8, 0.4, 40, openAiLong(16, 0.8, 60)),
  'gpt-6.1-sol': openAi(2, 0.1, 10, openAiLong(4, 0.2, 15)),
  'gpt-6.1-terra': openAi(1, 0.05, 5, openAiLong(2, 0.1, 7.5)),
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

export const codexPriceOf = (model: string): ModelPricing | undefined => OPENAI_PRICING[model]
