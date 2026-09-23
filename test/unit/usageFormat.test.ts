import { describe, it, expect } from 'vitest'
import {
  ctxLevel,
  ctxPercent,
  formatCost,
  formatTokens,
  localDayKey,
  todayCostFor
} from '../../src/shared/usageFormat'

describe('formatCost — thresholds from the design', () => {
  it('< $10 → two decimals', () => {
    expect(formatCost(1.24)).toBe('$1.24')
    expect(formatCost(2.03)).toBe('$2.03')
    expect(formatCost(0.1)).toBe('$0.10')
  })
  it('$10..$100 → one decimal', () => {
    expect(formatCost(11.6)).toBe('$11.6')
    expect(formatCost(10)).toBe('$10.0')
  })
  it('≥ $100 → integer', () => {
    expect(formatCost(128)).toBe('$128')
    expect(formatCost(128.7)).toBe('$129')
  })
  it('picks the tier from the ROUNDED value — rounding never spills across a boundary', () => {
    // 9.997 rounds to 10.00: the $10 tier owns it → '$10.0', never '$10.00'
    expect(formatCost(9.997)).toBe('$10.0')
    expect(formatCost(9.994)).toBe('$9.99')
    // 99.96 rounds to 100.0: the integer tier owns it → '$100', never '$100.0'
    expect(formatCost(99.96)).toBe('$100')
    expect(formatCost(99.94)).toBe('$99.9')
  })
})

describe('ctxLevel — ring colour bands (< 50% green / < 80% amber / ≥ 80% red)', () => {
  it('maps the design mock fractions', () => {
    expect(ctxLevel(0.34)).toBe('g')
    expect(ctxLevel(0.72)).toBe('y')
    expect(ctxLevel(0.91)).toBe('r')
  })
  it('is correct on the boundaries', () => {
    expect(ctxLevel(0.499)).toBe('g')
    expect(ctxLevel(0.5)).toBe('y') // 50% is NOT green
    expect(ctxLevel(0.799)).toBe('y')
    expect(ctxLevel(0.8)).toBe('r') // 80% is red
    expect(ctxLevel(1.2)).toBe('r')
  })
})

describe('ctxPercent / formatTokens', () => {
  it('ctxPercent rounds a fraction to whole percent', () => {
    expect(ctxPercent(0.34)).toBe(34)
    expect(ctxPercent(0.715)).toBe(72)
  })
  it('formatTokens is compact k/M', () => {
    expect(formatTokens(840)).toBe('840')
    expect(formatTokens(2100)).toBe('2.1k')
    expect(formatTokens(128_000)).toBe('128k')
    expect(formatTokens(1_480_000)).toBe('1.48M')
    expect(formatTokens(0)).toBe('0')
  })
  it('formatTokens never spills a magnitude (#9): no "1000k", no 5-char "100.0k"', () => {
    expect(formatTokens(999_900)).toBe('1.00M') // would round to "1000k" naively
    expect(formatTokens(1_000_000)).toBe('1.00M')
    expect(formatTokens(99_950)).toBe('100k') // 99.95 rounds to "100.0k" naively
    expect(formatTokens(999_400)).toBe('999k') // just under the M cutover stays in k
  })
})

describe('localDayKey', () => {
  it('renders a local YYYY-MM-DD and is empty for junk', () => {
    expect(localDayKey('2026-07-19T10:00:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(localDayKey('')).toBe('')
    expect(localDayKey(undefined)).toBe('')
  })
})

describe('todayCostFor — day-gated today cost (#3)', () => {
  const today = '2026-07-19'
  it('counts a cost whose bucket is the current day', () => {
    expect(
      todayCostFor(
        {
          inTok: 0,
          outTok: 0,
          cacheWriteTok: 0,
          cacheReadTok: 0,
          todayCostUsd: 1.5,
          todayDayKey: today
        },
        today
      )
    ).toBe(1.5)
  })
  it('treats a stale (yesterday) bucket as $0 — self-expires at midnight', () => {
    expect(
      todayCostFor(
        {
          inTok: 0,
          outTok: 0,
          cacheWriteTok: 0,
          cacheReadTok: 0,
          todayCostUsd: 1.5,
          todayDayKey: '2026-07-18'
        },
        today
      )
    ).toBe(0)
  })
  it('is $0 when there is no today cost', () => {
    expect(todayCostFor({ inTok: 0, outTok: 0, cacheWriteTok: 0, cacheReadTok: 0 }, today)).toBe(0)
    expect(todayCostFor(undefined, today)).toBe(0)
  })
})
