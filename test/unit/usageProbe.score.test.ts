import { describe, it, expect } from 'vitest'
import type { UsageSnapshot } from '../../src/shared/types'
import {
  disc,
  scoreSnapshot,
  leximaxFinalists,
  RESET_TIE_S,
  D5,
  GRACE,
  type Score,
  type ScoreRoute
} from '../../src/main/usageProbe'

/** U2 — the scoring/selection contract (tests.md §2.4), expectations hand-computed
 *  from the formulas, never derived from the code under test. `now` is a parameter
 *  everywhere (pure functions). */

const NOW = 1_700_000_000 // epoch seconds

function snap(p: Partial<UsageSnapshot>): UsageSnapshot {
  return {
    u5: 0,
    u7: 0,
    uoi: 0,
    s5: 'allowed',
    s7: 'allowed',
    soi: '?',
    r5: 0,
    r7: 0,
    roi: 0,
    overage: '?',
    hasOi: false,
    at: NOW * 1000,
    ...p
  }
}

/** default route is 'fable' — the historic single-route behavior these cases pin */
function score(p: Partial<UsageSnapshot>, route: ScoreRoute = 'fable'): Score {
  return scoreSnapshot(snap(p), NOW, route)
}

/** the finalist NAMES, in list order — a single name is a clear pick, several are the
 *  set the picker rotates over */
function finalists(cands: { name: string; score: Score }[]): string[] {
  return leximaxFinalists(cands).map((c) => c.name)
}

describe('U2 · disc edges', () => {
  it('r=0 (missing) → 1.0 — conservative, no discount', () => {
    expect(disc(0, D5, NOW)).toBe(1.0)
  })
  it('reset already past → 0.0 — the window data is void', () => {
    expect(disc(NOW - 10, D5, NOW)).toBe(0.0)
  })
  it('halfway inside the window → linear 0.5', () => {
    expect(disc(NOW + D5 / 2, D5, NOW)).toBeCloseTo(0.5, 10)
  })
  it('at/after the window edge → 1.0', () => {
    expect(disc(NOW + D5, D5, NOW)).toBe(1.0)
  })
})

describe('U2 · component formulas', () => {
  it('"90% but clears in 10 min": p5 = 0.9 × 600/10800 = 0.05 — beats an idle 50% account', () => {
    const hot = score({ u5: 0.9, r5: NOW + 600 })
    expect(hot.s1).toBeCloseTo(0.05, 10)
    const mild = score({ u5: 0.5 }) // r5=0 → no discount → s1=0.5
    expect(
      finalists([
        { name: 'hot', score: hot },
        { name: 'mild', score: mild }
      ])
    ).toEqual(['hot'])
  })

  it('ramp has NO upper clamp: u7·f7=0.95 → exactly 1.0; u7·f7=1.0 → 1.2', () => {
    expect(score({ u7: 0.95 }).s1).toBeCloseTo(1.0, 10)
    expect(score({ u7: 1.0 }).s1).toBeCloseTo(1.2, 10)
  })

  it('rejected but resetting inside grace: pen=0.5, NOT hard-limited', () => {
    const s = score({ u5: 0.99, s5: 'rejected', r5: NOW + 900 })
    // p5 = 0.99 × 900/10800 = 0.0825; pen = 900/1800 = 0.5
    expect(s.s1).toBeCloseTo(0.0825 + 0.5, 10)
    expect(s.hardLimited).toBe(false)
  })

  it('rejected with reset ≥ grace away: pen=1.0 and hard-limited', () => {
    const s = score({ u5: 1.0, s5: 'rejected', r5: NOW + 3600 })
    // p5 = 1.0 × 3600/10800 = 1/3; pen = 1.0
    expect(s.s1).toBeCloseTo(1 / 3 + 1, 10)
    expect(s.hardLimited).toBe(true)
  })

  it('rejected with UNKNOWN reset (r=0): pen=0, not hard-limited — never spend on unknowns', () => {
    const s = score({ u5: 0.4, s5: 'rejected', r5: 0 })
    expect(s.s1).toBeCloseTo(0.4, 10) // disc(0)=1 → p5=0.4; pen = 0/1800 = 0
    expect(s.hardLimited).toBe(false)
  })

  it('a full fable bucket does NOT penalize as rejected (only s5/s7 do)', () => {
    const s = score({ uoi: 1.0, soi: 'rejected' })
    expect(s.s1).toBeCloseTo(1.25, 10) // oi component only; no pen
    expect(s.hardLimited).toBe(false)
  })
})

describe('U2 · fable saturation semantics', () => {
  it('no hard veto: a lone fable-full account is still returned', () => {
    const only = { name: 'a', score: score({ uoi: 1.0 }) }
    expect(finalists([only])).toEqual(['a'])
  })

  it('oi=1.25 IS the largest component — fable-full loses to an idle rival', () => {
    const full = score({ uoi: 1.0 })
    expect(full.s1).toBeCloseTo(1.25, 10)
    expect(
      finalists([
        { name: 'full', score: full },
        { name: 'idle', score: score({ u5: 0.5 }) }
      ])
    ).toEqual(['idle'])
  })

  it('ALL fable-full → L1 ties at 1.25, L2 compares 5h', () => {
    const a = score({ uoi: 1.0, u5: 0.6 })
    const b = score({ uoi: 1.0, u5: 0.2 })
    expect(
      finalists([
        { name: 'a', score: a },
        { name: 'b', score: b }
      ])
    ).toEqual(['b'])
  })
})

describe('U2 · route: opus discards the fable dimension', () => {
  it('MIXED pool: the fable-exhausted account still wins on opus (a same-plan pool cannot show this)', () => {
    // A has no included fable allowance at all; B has one and has burned it
    const a = snap({ u5: 0.6, u7: 0.8 })
    const b = snap({ u5: 0.05, u7: 0.5, uoi: 0.99, soi: 'allowed', hasOi: true })
    const cands = (route: ScoreRoute): { name: string; score: Score }[] => [
      { name: 'A', score: scoreSnapshot(a, NOW, route) },
      { name: 'B', score: scoreSnapshot(b, NOW, route) }
    ]
    // fable route: B's oi = 0.99 × 1.25 = 1.2375 dominates A's p5 = 0.6
    expect(finalists(cands('fable'))).toEqual(['A'])
    // opus route: oi is gone, so B's idle 5h/7d wins — the whole point of the split
    expect(finalists(cands('opus'))).toEqual(['B'])
  })

  it('opus keeps THREE components (s3 is 0, never undefined) so a full tie still resolves', () => {
    const s = scoreSnapshot(snap({ u5: 0.3, uoi: 1.0, soi: 'allowed', hasOi: true }), NOW, 'opus')
    expect(s.s3).toBe(0) // `[p5, ramp].sort()` would leave undefined → NaN → no-usable
    expect(s.s1).toBeCloseTo(0.3, 10) // oi discarded entirely, not merely down-weighted
    const tied = [
      { name: 'x', score: scoreSnapshot(snap({ u5: 0.3 }), NOW, 'opus') },
      { name: 'y', score: scoreSnapshot(snap({ u5: 0.3 }), NOW, 'opus') }
    ]
    expect(finalists(tied)).toEqual(['x', 'y']) // NaN in s3 would filter both out
  })

  it('opus tie-break is the 7d reset, NOT the fable reset', () => {
    // if opus read roi, 'late7d' (earliest roi) would win — that is the dimension we
    // just threw out, sneaking back in through the tie-break
    const late = snap({ r7: NOW + 1001 + RESET_TIE_S, roi: NOW + 1 })
    const early = snap({ r7: NOW + 1000, roi: 0 })
    expect(
      finalists([
        { name: 'late7d', score: scoreSnapshot(late, NOW, 'opus') },
        { name: 'early7d', score: scoreSnapshot(early, NOW, 'opus') }
      ])
    ).toEqual(['early7d'])
  })

  it('pen is exposed pre-sort for the fable-host health gate', () => {
    expect(score({ s5: 'rejected', r5: NOW + 900 }).pen).toBeCloseTo(0.5, 10)
    expect(score({ u5: 0.9 }).pen).toBe(0)
  })
})

describe('U2 · eps-cascaded leximax', () => {
  const raw = (s1: number, s2 = 0, s3 = 0, tiebreak = 0): Score => ({
    s1,
    s2,
    s3,
    tiebreak,
    pen: 0,
    hardLimited: false
  })

  it('transitivity trap (the prototype-documented bug): A≈B, B≈C, A<C−eps ⇒ C never wins', () => {
    // running-best ±eps greedy would let C survive a comparison it never had with A
    const cands = [
      { name: 'A', score: raw(0.5, 0.4) },
      { name: 'B', score: raw(0.54, 0.1) },
      { name: 'C', score: raw(0.58) }
    ]
    expect(finalists(cands)).not.toContain('C')
    // and with A's later layers pinned best, A wins outright
    const pinned = [
      { name: 'A', score: raw(0.5, 0.0) },
      { name: 'B', score: raw(0.54, 0.3) },
      { name: 'C', score: raw(0.58) }
    ]
    expect(finalists(pinned)).toEqual(['A'])
  })

  it('order independence: same winner under every permutation', () => {
    const mk = (): { name: string; score: Score }[] => [
      { name: 'A', score: raw(0.5, 0.0) },
      { name: 'B', score: raw(0.54, 0.3) },
      { name: 'C', score: raw(0.58) }
    ]
    const [a, b, c] = mk()
    for (const perm of [
      [a, b, c],
      [c, b, a],
      [b, a, c],
      [c, a, b]
    ]) {
      expect(finalists(perm)).toEqual(['A'])
    }
  })

  it('full tie → a clearly earlier fable weekly reset wins alone; missing tiebreak reads as +∞', () => {
    expect(
      finalists([
        { name: 'late', score: raw(0.1, 0, 0, NOW + 1001 + RESET_TIE_S) },
        { name: 'early', score: raw(0.1, 0, 0, NOW + 1000) },
        { name: 'none', score: raw(0.1, 0, 0, 0) }
      ])
    ).toEqual(['early'])
  })

  it('tiebreak also equal → both stay, in list order', () => {
    expect(
      finalists([
        { name: 'first', score: raw(0.1, 0, 0, NOW + 1000) },
        { name: 'second', score: raw(0.1, 0, 0, NOW + 1000) }
      ])
    ).toEqual(['first', 'second'])
  })

  // the picker rotates over the finalist SET; the reset filter decides who is in it
  it('finalists: a reset within RESET_TIE_S of the earliest stays, one past it drops', () => {
    expect(
      finalists([
        { name: 'early', score: raw(0.1, 0, 0, NOW + 1000) },
        { name: 'in', score: raw(0.1, 0, 0, NOW + 1000 + RESET_TIE_S) },
        { name: 'out', score: raw(0.1, 0, 0, NOW + 1001 + RESET_TIE_S) },
        { name: 'none', score: raw(0.1, 0, 0, 0) }
      ])
    ).toEqual(['early', 'in'])
    // no live reset anywhere → nothing to prefer, everyone stays
    expect(
      finalists([
        { name: 'a', score: raw(0, 0, 0, 0) },
        { name: 'b', score: raw(0, 0, 0, 0) }
      ])
    ).toEqual(['a', 'b'])
  })

  it('an elapsed weekly reset is void for the tie-break too (reads as missing)', () => {
    expect(score({ r7: NOW - 1 }, 'opus').tiebreak).toBe(0)
    expect(score({ r7: NOW + 1 }, 'opus').tiebreak).toBe(NOW + 1)
    expect(score({ roi: NOW - 1, hasOi: true }, 'fable').tiebreak).toBe(0)
  })

  it('grace boundary pins the GRACE constant', () => {
    expect(score({ s5: 'rejected', r5: NOW + GRACE }).hardLimited).toBe(true)
    expect(score({ s5: 'rejected', r5: NOW + GRACE - 1 }).hardLimited).toBe(false)
  })

  it('empty pool → no finalists', () => {
    expect(finalists([])).toEqual([])
  })
})
