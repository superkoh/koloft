import { describe, it, expect } from 'vitest'
// Import the REAL production table + resolver so drift in either is caught here.
import { resolvePricing, MODEL_PRICING } from '../../src/shared/pricing'

describe('resolvePricing — exact then longest-prefix match', () => {
  it('resolves a bare current model id exactly', () => {
    const p = resolvePricing('claude-opus-4-8')
    expect(p).toBeDefined()
    expect(p!.inPerM).toBe(5)
    expect(p!.outPerM).toBe(25)
  })

  it('resolves a date-suffixed id via prefix to the same family price', () => {
    // real jsonl ids can carry a date suffix; the prefix path must still price them
    expect(resolvePricing('claude-opus-4-8-20260115')).toEqual(resolvePricing('claude-opus-4-8'))
  })

  it('does not collapse two price tiers of the same family (Opus 4.1 vs 4.8)', () => {
    // a greedy `claude-opus-4` prefix would mis-price 4.1 as 4.8 — guard against it
    expect(resolvePricing('claude-opus-4-1')!.inPerM).toBe(15)
    expect(resolvePricing('claude-opus-4-8')!.inPerM).toBe(5)
  })

  it('anchors the prefix at a hyphen so a future sibling id is NOT mis-priced (#6)', () => {
    // `claude-opus-4-10` must not resolve to `claude-opus-4-1`'s tier — or any tier;
    // an unknown id is tokens-only, never a fabricated $ (design D6)
    expect(resolvePricing('claude-opus-4-10')).toBeUndefined()
    expect(resolvePricing('claude-sonnet-4-99')).toBeUndefined()
  })

  it('prices the DATED 4.0-generation ids real transcripts record (review finding)', () => {
    // A resumed mid-2025 session's records carry the full dated id, not the `-0`
    // alias — unresolvable ids would set the sticky unknown-model flag and strip
    // the $ from the ENTIRE session, current turns included.
    const opus = resolvePricing('claude-opus-4-20250514')!
    expect(opus.inPerM).toBe(15)
    expect(opus.outPerM).toBe(75)
    expect(opus.windowTokens).toBe(200_000)
    const sonnet = resolvePricing('claude-sonnet-4-20250514')!
    expect(sonnet.inPerM).toBe(3)
    expect(sonnet.outPerM).toBe(15)
    expect(sonnet.windowTokens).toBe(200_000)
  })

  it('returns undefined for unknown / synthetic / empty ids (design D6: no $)', () => {
    expect(resolvePricing('gpt-4')).toBeUndefined()
    expect(resolvePricing('<synthetic>')).toBeUndefined()
    expect(resolvePricing('')).toBeUndefined()
  })

  it('prices Fable 5.1 cache reads at $0.25/Mtok, and keeps Fable 5 on its own rate', () => {
    const p51 = resolvePricing('claude-fable-5-1')!
    expect(p51.inPerM).toBe(10)
    expect(p51.outPerM).toBe(50)
    expect(p51.cacheReadPerM).toBe(0.25)
    // the longest-first prefix match must send a dated 5.1 id to the 5.1 entry
    expect(resolvePricing('claude-fable-5-1-20260901')).toEqual(p51)
  })

  it('prices Sonnet 5 at its $2/$10 list price (#5)', () => {
    const p = resolvePricing('claude-sonnet-5')!
    expect(p.inPerM).toBe(2)
    expect(p.outPerM).toBe(10)
  })

  it('uses real per-model context windows: 1M for current families, 200k for Haiku/legacy (#7)', () => {
    expect(resolvePricing('claude-fable-5')!.windowTokens).toBe(1_000_000)
    expect(resolvePricing('claude-opus-4-8')!.windowTokens).toBe(1_000_000)
    expect(resolvePricing('claude-sonnet-5')!.windowTokens).toBe(1_000_000)
    expect(resolvePricing('claude-sonnet-4-6')!.windowTokens).toBe(1_000_000)
    expect(resolvePricing('claude-haiku-4-5')!.windowTokens).toBe(200_000)
    expect(resolvePricing('claude-opus-4-1')!.windowTokens).toBe(200_000)
    expect(resolvePricing('claude-sonnet-4-5')!.windowTokens).toBe(200_000)
  })

  it('derives cache rates from input: write = 1.25×, read = 0.1× (ccusage alignment)', () => {
    for (const [id, p] of Object.entries(MODEL_PRICING)) {
      expect(p.cacheWritePerM, id).toBeCloseTo(p.inPerM * 1.25, 10)
      if (id !== 'claude-fable-5-1') expect(p.cacheReadPerM, id).toBeCloseTo(p.inPerM * 0.1, 10)
      expect([200_000, 1_000_000]).toContain(p.windowTokens)
    }
  })

  it('covers the required current families', () => {
    for (const id of [
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-sonnet-4-5',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-haiku-4-5'
    ]) {
      expect(resolvePricing(id), id).toBeDefined()
    }
  })
})
