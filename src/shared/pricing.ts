/**
 * Per-model price + context-window table for the per-session usage sub-row.
 *
 * ⚠️ ESTIMATE — this is our best-effort transcription of Anthropic's public
 * pricing, deliberately aligned with **ccusage** (the community de-facto standard,
 * design D6). Prices are USD per **million tokens**. When a model id is NOT found
 * here, the UI shows tokens only and NEVER a dollar figure — a wrong unit price is
 * worse than none (design D6). Keep this in sync with ccusage; a mismatch is a bug.
 *
 * Sources (2026-07):
 *  - input / output $/Mtok — Anthropic model catalog (via the local `claude-api`
 *    skill reference, cached) for the current families; Anthropic's
 *    public pricing page for the legacy Opus/Sonnet families.
 *  - cache write (5-minute ephemeral TTL) = 1.25 × input; cache read = 0.10 × input
 * the standard Anthropic prompt-caching multipliers ccusage applies.
 *  - windowTokens — the model's real context window from the catalog: 1M for the
 *    current Fable/Opus 4.6+/Sonnet 4.6+ families, 200k for Haiku 4.5 and the legacy
 *    Opus 4.x/Sonnet 4.x families. The ctx% ring measures fill against this (the UI
 *    clamps the shown percent at 100% defensively).
 */
export interface ModelPricing {
  /** USD per million input tokens */
  inPerM: number
  /** USD per million output tokens */
  outPerM: number
  /** USD per million cache-creation (5-minute ephemeral) tokens */
  cacheWritePerM: number
  /** USD per million cache-read tokens */
  cacheReadPerM: number
  /** context window (tokens) the ctx% ring measures against */
  windowTokens: number
}

const M = 1_000_000
const K200 = 200_000

/** Derive the two cache rates (1.25× / 0.1× input) from in/out + the model's window. */
function tier(inPerM: number, outPerM: number, windowTokens: number): ModelPricing {
  return {
    inPerM,
    outPerM,
    cacheWritePerM: inPerM * 1.25,
    cacheReadPerM: inPerM * 0.1,
    windowTokens
  }
}

/** model id → pricing. Keyed by full version id so the anchored-prefix match (below)
 *  can't collapse two price tiers of the same family (e.g. Opus 4.1 vs Opus 4.8). */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Fable 5.1 — $10 / $50, 1M window; cache read $0.25/Mtok, not the 10% rule
  'claude-fable-5-1': { ...tier(10, 50, M), cacheReadPerM: 0.25 },
  // Fable / Mythos 5 — $10 / $50, 1M window
  'claude-fable-5': tier(10, 50, M),
  'claude-mythos-5': tier(10, 50, M),
  // Opus 4.6 – 4.8 — $5 / $25, 1M window
  'claude-opus-4-8': tier(5, 25, M),
  'claude-opus-4-7': tier(5, 25, M),
  'claude-opus-4-6': tier(5, 25, M),
  // Opus 4.5 — $5 / $25, 200k window (pre-1M rollout)
  'claude-opus-4-5': tier(5, 25, K200),
  // Opus 4 / 4.1 — $15 / $75, 200k window. Only exact version ids are keyed (no bare
  // `claude-opus-4` family alias) so an unknown future sibling (`claude-opus-4-10`)
  // resolves to undefined → tokens-only, never a mis-priced tier (design D6).
  // The 4.0 generation's transcripts record the DATED full id (`claude-opus-4-20250514`),
  // which neither the `-0` alias key nor the anchored prefix match can reach — so the
  // dated id is keyed explicitly, else every resumed 4.0-era session loses its $.
  'claude-opus-4-1': tier(15, 75, K200),
  'claude-opus-4-0': tier(15, 75, K200),
  'claude-opus-4-20250514': tier(15, 75, K200),
  // Sonnet 5 — $2 / $10 list price (CC 2.1.243 made these the standard rates); 1M window
  'claude-sonnet-5': tier(2, 10, M),
  // Sonnet 4.6 — $3 / $15, 1M window
  'claude-sonnet-4-6': tier(3, 15, M),
  // Sonnet 4 / 4.5 — $3 / $15, 200k window (dated id: same reason as Opus 4 above)
  'claude-sonnet-4-5': tier(3, 15, K200),
  'claude-sonnet-4-0': tier(3, 15, K200),
  'claude-sonnet-4-20250514': tier(3, 15, K200),
  // Haiku 4.5 — $1 / $5, 200k window
  'claude-haiku-4-5': tier(1, 5, K200)
}

// Longest keys first so a specific version id wins over a shorter family prefix.
const KEYS = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length)

/**
 * Resolve a jsonl `message.model` string to its pricing. Exact match first, then an
 * ANCHORED prefix match (`<key>-…`) so date-suffixed ids (`claude-opus-4-8-20260115`)
 * still resolve to their family while a future sibling id can't be mis-priced
 * (`claude-opus-4-10` must NOT match `claude-opus-4-1`). Returns `undefined` for
 * anything unknown / empty, so callers show tokens only — never a fabricated $ (D6).
 */
export function resolvePricing(model: string): ModelPricing | undefined {
  if (!model) return undefined
  const exact = MODEL_PRICING[model]
  if (exact) return exact
  for (const k of KEYS) {
    if (model.startsWith(k + '-')) return MODEL_PRICING[k]
  }
  return undefined
}
