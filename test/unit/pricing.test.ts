import { describe, it, expect } from 'vitest'
import { resolvePricing, MODEL_PRICING } from '../../src/shared/pricing'

describe('resolvePricing — exact then longest-prefix match', () => {
  it('resolves a bare current model id exactly', () => {
    const p = resolvePricing('claude-opus-4-8')
    expect(p).toBeDefined()
    expect(p!.inPerM).toBe(5)
    expect(p!.outPerM).toBe(25)
  })

  it('resolves a date-suffixed id via prefix to the same family price', () => {
    expect(resolvePricing('claude-opus-4-8-20260115')).toEqual(resolvePricing('claude-opus-4-8'))
  })

  it('does not collapse two price tiers of the same family (Opus 4.1 vs 4.8)', () => {
    expect(resolvePricing('claude-opus-4-1')!.inPerM).toBe(15)
    expect(resolvePricing('claude-opus-4-8')!.inPerM).toBe(5)
  })

  it('anchors the prefix at a hyphen so a future sibling id is NOT mis-priced but unknown: tokens only, never a made-up $ (#6)', () => {
    expect(resolvePricing('claude-opus-4-10')).toBeUndefined()
    expect(resolvePricing('claude-sonnet-4-99')).toBeUndefined()
  })

  it('falls back to a family row only for a date stamp, so the next minor version (5-6 after 5) is unknown, never priced as its elder', () => {
    expect(resolvePricing('claude-opus-5-6')).toBeUndefined()
    expect(resolvePricing('claude-sonnet-5-6')).toBeUndefined()
    expect(resolvePricing('claude-fable-5-2')).toBeUndefined()
  })

  it('prices the DATED 4.0-generation ids real transcripts record, since one unknown id strips the $ from the whole session', () => {
    const opus = resolvePricing('claude-opus-4-20250514')!
    expect(opus.inPerM).toBe(15)
    expect(opus.outPerM).toBe(75)
    expect(opus.windowTokens).toBe(200_000)
    const sonnet = resolvePricing('claude-sonnet-4-20250514')!
    expect(sonnet.inPerM).toBe(3)
    expect(sonnet.outPerM).toBe(15)
    expect(sonnet.windowTokens).toBe(200_000)
  })

  it("prices an OpenAI id only on an exact match, so gpt-5-mini never borrows gpt-5's price", () => {
    expect(resolvePricing('gpt-5')!.inPerM).toBe(1.25)
    expect(resolvePricing('gpt-5')!.cacheWritePerM).toBe(0)
    expect(resolvePricing('gpt-5-mini')).toBeUndefined()
    expect(resolvePricing('gpt-6-astra-2026-09-01')).toBeUndefined()
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
    expect(resolvePricing('claude-fable-5-1-20260901')).toEqual(p51)
  })

  it('prices Sonnet 5 at its $2/$10 list price (#5)', () => {
    const p = resolvePricing('claude-sonnet-5')!
    expect(p.inPerM).toBe(2)
    expect(p.outPerM).toBe(10)
  })

  it('prices the bare Opus 5.5 id transcripts record at its own $4/$20 rate with $0.20 cache reads, not as Opus 5', () => {
    const p55 = resolvePricing('claude-opus-5-5')!
    expect(p55.inPerM).toBe(4)
    expect(p55.outPerM).toBe(20)
    expect(p55.cacheReadPerM).toBe(0.2)
    expect(p55.windowTokens).toBe(1_000_000)
    const p5 = resolvePricing('claude-opus-5')!
    expect(p5.inPerM).toBe(5)
    expect(p5.outPerM).toBe(25)
    expect(p5.windowTokens).toBe(1_000_000)
  })

  it.each([
    ['claude-sonnet-5-5', { inPerM: 2, outPerM: 10, cacheReadPerM: 0.1, windowTokens: 1_000_000 }],
    [
      'claude-haiku-5-5',
      {
        inPerM: 0.1,
        outPerM: 0.5,
        cacheReadPerM: expect.closeTo(0.01, 10),
        windowTokens: 1_000_000
      }
    ],
    ['gpt-6.1-sol', { inPerM: 2, outPerM: 10, cacheReadPerM: 0.1 }]
  ])(
    'prices %s, a default model of Claude Code 2.1.293+ or Codex 0.161+, at its own row',
    (id, expected) => {
      expect(resolvePricing(id)).toMatchObject(expected)
    }
  )

  it('uses real per-model context windows: 1M for current families, 200k for Haiku/legacy (#7)', () => {
    expect(resolvePricing('claude-fable-5')!.windowTokens).toBe(1_000_000)
    expect(resolvePricing('claude-opus-4-8')!.windowTokens).toBe(1_000_000)
    expect(resolvePricing('claude-sonnet-5')!.windowTokens).toBe(1_000_000)
    expect(resolvePricing('claude-sonnet-4-6')!.windowTokens).toBe(1_000_000)
    expect(resolvePricing('claude-haiku-4-5')!.windowTokens).toBe(200_000)
    expect(resolvePricing('claude-opus-4-1')!.windowTokens).toBe(200_000)
    expect(resolvePricing('claude-sonnet-4-5')!.windowTokens).toBe(200_000)
  })

  it('derives cache rates from input: write = 1.25×, read = 0.1× (ccusage alignment), but for the 5.5-generation rows with their own cache-read price', () => {
    const OWN_CACHE_READ: Record<string, number> = {
      'claude-fable-5-1': 0.25,
      'claude-opus-5-5': 0.2,
      'claude-sonnet-5-5': 0.1
    }
    for (const [id, p] of Object.entries(MODEL_PRICING)) {
      expect(p.cacheWritePerM, id).toBeCloseTo(p.inPerM * 1.25, 10)
      expect(p.cacheReadPerM, id).toBeCloseTo(OWN_CACHE_READ[id] ?? p.inPerM * 0.1, 10)
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
