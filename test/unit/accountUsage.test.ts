import { describe, it, expect } from 'vitest'
import type { AccountView, UsageSnapshot } from '../../src/shared/types'
import {
  hardLimited,
  meterLevel,
  capsuleGlyph,
  meteredArmed,
  oldestAt,
  autoProbeDue,
  capsuleAria,
  popoverX,
  windowTone,
  accountWalled,
  poolSnapshot,
  poolGlyph,
  sublineFor,
  AUTO_PROBE_MS,
  STALE_MS,
  GRACE,
  FABLE_STOP,
  CAP
} from '../../src/shared/accountUsage'

/** Capsule view rules (topbar-usage design §3/§04/§05, retired —
 *  this suite IS the surviving contract). Every expected
 *  value is hand-derived from the design doc, never from the implementation. */

const NOW_SEC = 1_700_000_000 // epoch seconds (reset headers)
const NOW_MS = NOW_SEC * 1000 // epoch ms (snapshot `at`)

function snap(p: Partial<UsageSnapshot>): UsageSnapshot {
  return {
    u5: 0,
    u7: 0,
    uoi: 0,
    s5: '?',
    s7: '?',
    soi: '?',
    r5: 0,
    r7: 0,
    roi: 0,
    overage: '?',
    hasOi: true,
    at: NOW_MS,
    ...p
  }
}

/** the fable layer of an untouched included-allowance plan (uoi 0, nothing spent) */
const NO_FABLE_SPEND = { frac: 0, spent: false }

function view(p: Partial<AccountView>): AccountView {
  return {
    name: 'a',
    kind: 'oauth',
    enabled: true,
    fable: 'unknown',
    status: 'ok',
    addedAt: 0,
    ...p
  }
}

describe('hardLimited', () => {
  it('5h rejected with reset exactly GRACE away is hard-limited (boundary inclusive)', () => {
    expect(hardLimited(snap({ s5: 'rejected', r5: NOW_SEC + GRACE }), NOW_SEC)).toBe(true)
  })
  it('5h rejected but reset under GRACE is not (wall clears in minutes)', () => {
    expect(hardLimited(snap({ s5: 'rejected', r5: NOW_SEC + GRACE - 1 }), NOW_SEC)).toBe(false)
  })
  it('7d rejected with a far reset is hard-limited', () => {
    expect(hardLimited(snap({ s7: 'rejected', r7: NOW_SEC + 86_400 }), NOW_SEC)).toBe(true)
  })
  it('a full fable bucket alone is NOT a hard limit', () => {
    expect(hardLimited(snap({ soi: 'rejected', roi: NOW_SEC + 86_400, uoi: 1 }), NOW_SEC)).toBe(
      false
    )
  })
  it('no rejected bucket → false', () => {
    expect(hardLimited(snap({ u5: 0.99, u7: 0.99 }), NOW_SEC)).toBe(false)
  })
})

describe('meterLevel', () => {
  it('below 70% is neutral', () => {
    expect(meterLevel(0)).toBe('')
    expect(meterLevel(0.69)).toBe('')
  })
  it('70% inclusive is warn', () => {
    expect(meterLevel(0.7)).toBe('warn')
    expect(meterLevel(0.89)).toBe('warn')
  })
  it('90% inclusive is bad, including >100% utilization', () => {
    expect(meterLevel(0.9)).toBe('bad')
    expect(meterLevel(1.2)).toBe('bad')
  })
})

describe('capsuleGlyph', () => {
  it('expired account → grey slot regardless of usage', () => {
    expect(capsuleGlyph(view({ status: 'expired', usage: snap({ u5: 0.4 }) }), NOW_MS)).toEqual({
      kind: 'grey'
    })
  })
  it('unverified account → grey slot', () => {
    expect(capsuleGlyph(view({ status: 'unverified' }), NOW_MS)).toEqual({ kind: 'grey' })
  })
  it('no snapshot → empty track (cold start)', () => {
    expect(capsuleGlyph(view({}), NOW_MS)).toEqual({ kind: 'empty' })
  })
  it('5h rejected → walled (full red)', () => {
    expect(capsuleGlyph(view({ usage: snap({ s5: 'rejected', u5: 1 }) }), NOW_MS)).toEqual({
      kind: 'walled',
      stale: false
    })
  })
  it('7d rejected → walled', () => {
    expect(capsuleGlyph(view({ usage: snap({ s7: 'rejected', u7: 1 }) }), NOW_MS)).toEqual({
      kind: 'walled',
      stale: false
    })
  })
  it('a rejected fable bucket does NOT wall the account, and does NOT raise the bar either', () => {
    // the regression point: before the change this same input drew frac 0.92 / level 'bad',
    // i.e. a fable-only wall was displayed as a nearly exhausted account.
    const g = capsuleGlyph(
      view({ usage: snap({ u5: 0.1, u7: 0.2, uoi: 1.0, soi: 'rejected' }) }),
      NOW_MS
    )
    expect(g).toEqual({
      kind: 'bar',
      frac: 0.2,
      level: '',
      stale: false,
      fable: { frac: 0.92, spent: true }
    })
  })
  it('healthy: height = max of the 5h/7d windows — uoi rides the fable layer, not the bar', () => {
    expect(capsuleGlyph(view({ usage: snap({ u5: 0.42, u7: 0.61, uoi: 0.35 }) }), NOW_MS)).toEqual({
      kind: 'bar',
      frac: 0.61,
      level: '',
      stale: false,
      fable: { frac: 0.35, spent: false }
    })
  })
  it('binding window at 78% → warn', () => {
    expect(capsuleGlyph(view({ usage: snap({ u5: 0.78 }) }), NOW_MS)).toEqual({
      kind: 'bar',
      frac: 0.78,
      level: 'warn',
      stale: false,
      fable: NO_FABLE_SPEND
    })
  })
  it('non-walled fill never touches the top rail: 95% draws at 92%, level from raw value', () => {
    expect(capsuleGlyph(view({ usage: snap({ u5: 0.95 }) }), NOW_MS)).toEqual({
      kind: 'bar',
      frac: 0.92,
      level: 'bad',
      stale: false,
      fable: NO_FABLE_SPEND
    })
  })
  it('utilization above 1 is capped, not drawn past the track', () => {
    expect(capsuleGlyph(view({ usage: snap({ u7: 1.3 }) }), NOW_MS)).toEqual({
      kind: 'bar',
      frac: 0.92,
      level: 'bad',
      stale: false,
      fable: NO_FABLE_SPEND
    })
  })
  it('snapshot older than 15min is stale; exactly 15min is not', () => {
    const old = view({ usage: snap({ u5: 0.4, at: NOW_MS - STALE_MS - 1 }) })
    const edge = view({ usage: snap({ u5: 0.4, at: NOW_MS - STALE_MS }) })
    expect(capsuleGlyph(old, NOW_MS)).toEqual({
      kind: 'bar',
      frac: 0.4,
      level: '',
      stale: true,
      fable: NO_FABLE_SPEND
    })
    expect(capsuleGlyph(edge, NOW_MS)).toEqual({
      kind: 'bar',
      frac: 0.4,
      level: '',
      stale: false,
      fable: NO_FABLE_SPEND
    })
  })
  it('a walled bar carries staleness too', () => {
    expect(
      capsuleGlyph(
        view({ usage: snap({ s5: 'rejected', at: NOW_MS - STALE_MS - 60_000 }) }),
        NOW_MS
      )
    ).toEqual({ kind: 'walled', stale: true })
  })
})

describe('capsuleGlyph — the fable layer', () => {
  it('a plan without an included allowance draws no fable layer at all', () => {
    expect(
      capsuleGlyph(view({ usage: snap({ u5: 0.4, uoi: 0.8, hasOi: false }) }), NOW_MS)
    ).toEqual({ kind: 'bar', frac: 0.4, level: '', stale: false, fable: null })
  })
  it('a fable layer under the stop draws at its own utilization', () => {
    const g = capsuleGlyph(view({ usage: snap({ u5: 0.1, uoi: 0.5 }) }), NOW_MS)
    expect(g).toEqual({
      kind: 'bar',
      frac: 0.1,
      level: '',
      stale: false,
      fable: { frac: 0.5, spent: false }
    })
  })
  it('just under the stop is still spendable; the stop itself reads spent', () => {
    const below = capsuleGlyph(view({ usage: snap({ uoi: FABLE_STOP - 0.001 }) }), NOW_MS)
    const at = capsuleGlyph(view({ usage: snap({ uoi: FABLE_STOP }) }), NOW_MS)
    expect(below).toMatchObject({ fable: { frac: 0.92, spent: false } })
    expect(at).toMatchObject({ fable: { frac: 0.92, spent: true } })
  })
  it('a rejected fable bucket reads spent even with a low utilization number', () => {
    expect(
      capsuleGlyph(view({ usage: snap({ u5: 0.3, uoi: 0.1, soi: 'rejected' }) }), NOW_MS)
    ).toMatchObject({ frac: 0.3, fable: { frac: 0.92, spent: true } })
  })
  it('the fable layer is capped by the same top rail as the bar', () => {
    expect(capsuleGlyph(view({ usage: snap({ uoi: 0.95 }) }), NOW_MS)).toMatchObject({
      fable: { frac: 0.92, spent: false }
    })
  })
  it('grey / empty / walled carry no fable layer, however full the bucket is', () => {
    const full = snap({ uoi: 1, soi: 'rejected' })
    expect(capsuleGlyph(view({ status: 'expired', usage: full }), NOW_MS)).not.toHaveProperty(
      'fable'
    )
    expect(capsuleGlyph(view({}), NOW_MS)).not.toHaveProperty('fable')
    expect(capsuleGlyph(view({ usage: { ...full, s5: 'rejected' } }), NOW_MS)).not.toHaveProperty(
      'fable'
    )
  })
})

describe('meteredArmed', () => {
  const walledSnap = snap({ s5: 'rejected', r5: NOW_SEC + 7_200, u5: 1 })
  const sub = (p: Partial<AccountView>): AccountView => view({ kind: 'oauth', ...p })
  const metered = view({ name: 'key', kind: 'apikey' })

  it('no enabled metered account → never armed', () => {
    expect(meteredArmed([sub({ usage: walledSnap })], NOW_SEC)).toBe(false)
  })
  it('disabled metered account does not arm', () => {
    expect(
      meteredArmed([sub({ usage: walledSnap }), { ...metered, enabled: false }], NOW_SEC)
    ).toBe(false)
  })
  it('every usable sub hard-limited + metered enabled → armed', () => {
    expect(meteredArmed([sub({ usage: walledSnap }), metered], NOW_SEC)).toBe(true)
  })
  it('one healthy sub keeps it un-armed', () => {
    expect(
      meteredArmed(
        [sub({ usage: walledSnap }), sub({ name: 'b', usage: snap({ u5: 0.3 }) }), metered],
        NOW_SEC
      )
    ).toBe(false)
  })
  it('an unprobed sub keeps it un-armed (not fully probed)', () => {
    expect(meteredArmed([sub({ usage: walledSnap }), sub({ name: 'b' }), metered], NOW_SEC)).toBe(
      false
    )
  })
  it('a wall clearing in under GRACE does not arm', () => {
    expect(
      meteredArmed(
        [sub({ usage: snap({ s5: 'rejected', r5: NOW_SEC + 60, u5: 1 }) }), metered],
        NOW_SEC
      )
    ).toBe(false)
  })
  it('zero usable subs (all expired) + metered → armed: metered IS the pool', () => {
    expect(meteredArmed([sub({ status: 'expired' }), metered], NOW_SEC)).toBe(true)
  })
})

describe('oldestAt', () => {
  it('empty / no snapshots → null', () => {
    expect(oldestAt([])).toBe(null)
    expect(oldestAt([view({})])).toBe(null)
  })
  it('returns the OLDEST snapshot timestamp (never advertises fresher than the worst row)', () => {
    const rows = [
      view({ usage: snap({ at: NOW_MS - 100 }) }),
      view({ name: 'b' }),
      view({ name: 'c', usage: snap({ at: NOW_MS - 5_000 }) })
    ]
    expect(oldestAt(rows)).toBe(NOW_MS - 5_000)
  })
})

describe('autoProbeDue', () => {
  const M = 60_000
  /** an enabled, alive OAuth row with a snapshot of the given age */
  const aged = (name: string, ageMs: number): AccountView =>
    view({ name, usage: snap({ at: NOW_MS - ageMs }) })
  const cold = (name: string): AccountView => view({ name })

  it('nothing probed yet and nothing attempted → refresh (the cold-start case)', () => {
    expect(autoProbeDue([cold('a')], null, NOW_MS)).toBe(true)
  })
  it('snapshot younger than the window → leave it alone', () => {
    expect(autoProbeDue([aged('a', 4 * M + 59_000)], null, NOW_MS)).toBe(false)
  })
  it('exactly at the window is not yet "older than 5m"', () => {
    expect(autoProbeDue([aged('a', AUTO_PROBE_MS)], null, NOW_MS)).toBe(false)
  })
  it('older than the window → refresh', () => {
    expect(autoProbeDue([aged('a', AUTO_PROBE_MS + 1)], null, NOW_MS)).toBe(true)
  })
  it('the OLDEST row decides — one fresh row must not vouch for a stale one', () => {
    expect(autoProbeDue([aged('a', 1_000), aged('b', 60 * M)], null, NOW_MS)).toBe(true)
  })
  it('a row with NO snapshot is stale however fresh its neighbours are', () => {
    // the half-failed round: alpha answered, bravo did not
    expect(autoProbeDue([aged('alpha', 1_000), cold('bravo')], null, NOW_MS)).toBe(true)
  })
  it('rows that can never carry a number are not a reason to probe', () => {
    const rows = [
      aged('alpha', 1_000),
      view({ name: 'api', kind: 'apikey' }), // metered: no buckets, ever
      view({ name: 'dead', status: 'expired' }), // can't get a snapshot either
      view({ name: 'off', enabled: false })
    ]
    expect(autoProbeDue(rows, null, NOW_MS)).toBe(false)
  })
  it('no usable OAuth row at all → nothing worth fetching', () => {
    expect(autoProbeDue([], null, NOW_MS)).toBe(false)
    expect(autoProbeDue([view({ name: 'api', kind: 'apikey' })], null, NOW_MS)).toBe(false)
  })
  it('a recent attempt suppresses the refresh even on stale data', () => {
    expect(autoProbeDue([aged('a', 60 * M)], NOW_MS - M, NOW_MS)).toBe(false)
  })
  it('a recent attempt suppresses it for never-probed accounts too (failing probe)', () => {
    expect(autoProbeDue([cold('a')], NOW_MS - M, NOW_MS)).toBe(false)
  })
  it('an attempt older than the window stops suppressing', () => {
    expect(autoProbeDue([aged('a', 60 * M)], NOW_MS - AUTO_PROBE_MS - 1, NOW_MS)).toBe(true)
    expect(autoProbeDue([cold('a')], NOW_MS - AUTO_PROBE_MS - 1, NOW_MS)).toBe(true)
  })
  it('an attempt in the FUTURE (clock jumped back) must not lock the panel out', () => {
    expect(autoProbeDue([cold('a')], NOW_MS + 60 * M, NOW_MS)).toBe(true)
  })
})

describe('capsuleAria', () => {
  it('reads the D11 sample string: accounts, pool, highest, usable, walled', () => {
    // §03 D11. tensions .61 / .78 / 1 (hard-walled) → mean .7967 → 80%;
    // the expired row is in the count but in neither the mean nor `usable`.
    const rows = [
      view({ usage: snap({ u7: 0.61 }) }),
      view({ name: 'b', usage: snap({ u5: 0.78 }) }),
      view({ name: 'c', usage: snap({ s5: 'rejected', r5: NOW_SEC + 7_200, u5: 1 }) }),
      view({ name: 'd', status: 'expired' })
    ]
    expect(capsuleAria(rows, NOW_MS)).toBe('4 accounts, pool 80%, highest 100%, 2 usable, 1 walled')
  })
  it('names the pool size and the highest utilization', () => {
    // tensions .61 / .78 / .1 → mean .4967 → 50%
    const rows = [
      view({ usage: snap({ u5: 0.42, u7: 0.61 }) }),
      view({ name: 'b', usage: snap({ u5: 0.78 }) }),
      view({ name: 'c', usage: snap({ u5: 0.1 }) })
    ]
    expect(capsuleAria(rows, NOW_MS)).toBe('3 accounts, pool 50%, highest 78%, 3 usable')
  })
  it('singular with no data yet — an unprobed account is still usable', () => {
    expect(capsuleAria([view({})], NOW_MS)).toBe('1 account, 1 usable')
  })
  it('a walled account reads as 100% and is counted, and drops out of usable', () => {
    // tensions .5 / 1 → mean .75
    const rows = [
      view({ usage: snap({ u5: 0.5 }) }),
      view({ name: 'b', usage: snap({ s5: 'rejected', u5: 1 }) })
    ]
    expect(capsuleAria(rows, NOW_MS)).toBe('2 accounts, pool 75%, highest 100%, 1 usable, 1 walled')
  })
  it('grey (defunct) accounts are listed in the count but not in the highest or usable', () => {
    expect(capsuleAria([view({ status: 'expired' })], NOW_MS)).toBe('1 account, 0 usable')
  })
  it('a spent fable bucket does not inflate the highest — it gets its own segment', () => {
    // tensions .61 / .2 → mean .405 → 41%
    const rows = [
      view({ usage: snap({ u5: 0.42, u7: 0.61 }) }),
      view({ name: 'b', usage: snap({ u5: 0.2, uoi: 1, soi: 'rejected' }) })
    ]
    expect(capsuleAria(rows, NOW_MS)).toBe(
      '2 accounts, pool 41%, highest 61%, 2 usable, 1 fable spent'
    )
  })
  it('an unspent fable bucket adds no segment and no height; one row gets no pool reading', () => {
    expect(capsuleAria([view({ usage: snap({ u5: 0.2, uoi: 0.9 }) })], NOW_MS)).toBe(
      '1 account, highest 20%, 1 usable'
    )
  })
  it('the fable segment follows the walled one, and a walled row is never counted twice', () => {
    // tensions 1 / .3 /.3 → mean .5333 → 53%
    const rows = [
      view({ usage: snap({ s5: 'rejected', u5: 1, uoi: 1, soi: 'rejected' }) }),
      view({ name: 'b', usage: snap({ u5: 0.3, uoi: 0.98 }) }),
      view({ name: 'c', usage: snap({ u5: 0.3, uoi: 0.99 }) })
    ]
    expect(capsuleAria(rows, NOW_MS)).toBe(
      '3 accounts, pool 53%, highest 100%, 2 usable, 1 walled, 2 fable spent'
    )
  })
})

describe('popoverX', () => {
  it('centers under the anchor when there is room', () => {
    expect(popoverX(500, 368, 1000)).toBe(316)
  })
  it('clamps to the left margin', () => {
    expect(popoverX(100, 368, 1000)).toBe(8)
  })
  it('clamps to the right margin', () => {
    expect(popoverX(950, 368, 1000)).toBe(624)
  })
  it('viewport narrower than the popover pins to the left margin', () => {
    expect(popoverX(150, 368, 300)).toBe(8)
  })
})

/** §2.1 predicate table: "walled" is one word for four different situations. */
describe('windowTone', () => {
  it('a window that never got rejected is ok, whatever its reset says', () => {
    expect(windowTone('?', 0, NOW_SEC)).toBe('ok')
    expect(windowTone('allowed', NOW_SEC + 10, NOW_SEC)).toBe('ok')
    expect(windowTone('allowed', NOW_SEC - 10, NOW_SEC)).toBe('ok')
  })
  it('rejected with no reset header at all is hard — nothing says it will come back', () => {
    expect(windowTone('rejected', 0, NOW_SEC)).toBe('hard')
  })
  it('rejected with a reset already past is "due": the snapshot, not the account, is behind', () => {
    expect(windowTone('rejected', NOW_SEC - 1, NOW_SEC)).toBe('due')
    expect(windowTone('rejected', NOW_SEC, NOW_SEC)).toBe('due')
  })
  it('one second out is "soon" — rejected right now, but healing', () => {
    expect(windowTone('rejected', NOW_SEC + 1, NOW_SEC)).toBe('soon')
  })
  it('the GRACE boundary: 1799s away is soon, 1800s is hard (picker parity)', () => {
    expect(GRACE).toBe(1_800)
    expect(windowTone('rejected', NOW_SEC + 1_799, NOW_SEC)).toBe('soon')
    expect(windowTone('rejected', NOW_SEC + 1_800, NOW_SEC)).toBe('hard')
    expect(windowTone('rejected', NOW_SEC + 1_801, NOW_SEC)).toBe('hard')
  })
})

describe('accountWalled', () => {
  it('either window hard-walled walls the account', () => {
    expect(accountWalled(snap({ s5: 'rejected', r5: NOW_SEC + 7_200 }), NOW_SEC)).toBe(true)
    expect(accountWalled(snap({ s7: 'rejected', r7: NOW_SEC + 86_400 }), NOW_SEC)).toBe(true)
  })
  it('rejected with a missing reset header still walls it', () => {
    expect(accountWalled(snap({ s5: 'rejected' }), NOW_SEC)).toBe(true)
  })
  it('a wall clearing inside GRACE does not wall the account (soon)', () => {
    expect(accountWalled(snap({ s5: 'rejected', r5: NOW_SEC + GRACE - 1 }), NOW_SEC)).toBe(false)
  })
  it('a reset already past does not wall the account (due)', () => {
    expect(accountWalled(snap({ s5: 'rejected', r5: NOW_SEC - 1 }), NOW_SEC)).toBe(false)
  })
  it('a rejected fable bucket never walls the account', () => {
    expect(accountWalled(snap({ soi: 'rejected', roi: NOW_SEC + 86_400, uoi: 1 }), NOW_SEC)).toBe(
      false
    )
  })
  it('nothing rejected → not walled however full the buckets are', () => {
    expect(accountWalled(snap({ u5: 1.2, u7: 0.99 }), NOW_SEC)).toBe(false)
  })
})

/** D15 side note: the member bar reads the same predicate table as the popover badge. */
describe('capsuleGlyph — the D15 tri-state', () => {
  it('a wall clearing inside GRACE draws a bar at min(u,1), not the walled rail', () => {
    expect(
      capsuleGlyph(
        view({ usage: snap({ s5: 'rejected', r5: NOW_SEC + GRACE - 1, u5: 1 }) }),
        NOW_MS
      )
    ).toEqual({ kind: 'bar', frac: CAP, level: 'bad', stale: false, fable: NO_FABLE_SPEND })
  })
  it('exactly GRACE away is hard → walled, in step with the popover badge', () => {
    expect(
      capsuleGlyph(view({ usage: snap({ s5: 'rejected', r5: NOW_SEC + GRACE, u5: 1 }) }), NOW_MS)
    ).toEqual({ kind: 'walled', stale: false })
  })
  it('a reset already past (suspected recovered) draws a bar, not a red wall', () => {
    expect(
      capsuleGlyph(view({ usage: snap({ s7: 'rejected', r7: NOW_SEC - 1, u7: 1 }) }), NOW_MS)
    ).toEqual({ kind: 'bar', frac: CAP, level: 'bad', stale: false, fable: NO_FABLE_SPEND })
  })
  it('rejected with no reset header is walled (r === 0)', () => {
    expect(capsuleGlyph(view({ usage: snap({ s7: 'rejected', r7: 0, u7: 1 }) }), NOW_MS)).toEqual({
      kind: 'walled',
      stale: false
    })
  })
  it('a soon/due bar still carries its fable layer', () => {
    expect(
      capsuleGlyph(
        view({ usage: snap({ s5: 'rejected', r5: NOW_SEC + 60, u5: 1, uoi: 0.5 }) }),
        NOW_MS
      )
    ).toMatchObject({ kind: 'bar', fable: { frac: 0.5, spent: false } })
  })
})

/** §2.2 / D10: the pool is the equal-weight mean over M, never over the enabled rows. */
describe('poolSnapshot', () => {
  const hard = (p: Partial<UsageSnapshot> = {}): UsageSnapshot =>
    snap({ s5: 'rejected', r5: NOW_SEC + 7_200, u5: 1, ...p })

  it('M is ok+snapshot only; usable keeps the unprobed ok row and drops the walled one', () => {
    const rows = [
      view({ usage: snap({ u5: 0.5 }) }),
      view({ name: 'cold' }),
      view({ name: 'dead', status: 'expired', usage: snap({ u5: 1 }) }),
      view({ name: 'walled', usage: hard() })
    ]
    const p = poolSnapshot(rows, NOW_MS)
    expect(p.measured).toBe(2)
    expect(p.usable).toBe(2)
    expect(p.walled).toBe(1)
    expect(p.tension).toBeCloseTo(0.75, 10)
  })
  it('tension folds a hard wall to 1 and clamps utilization over 1', () => {
    const rows = [
      view({ usage: snap({ u5: 1.4 }) }),
      view({ name: 'b', usage: snap({ u5: 0.25, u7: 0.75 }) })
    ]
    expect(poolSnapshot(rows, NOW_MS).tension).toBeCloseTo(0.875, 10)
  })
  it('T5/T7 are per-window means with NO walled special case (D10 rev2.1)', () => {
    const rows = [
      view({ usage: hard({ u7: 0.5 }) }),
      view({ name: 'b', usage: snap({ u5: 0.25, u7: 0.75 }) })
    ]
    const p = poolSnapshot(rows, NOW_MS)
    expect(p.t5).toBeCloseTo(0.625, 10)
    expect(p.t7).toBeCloseTo(0.625, 10)
    expect(p.tension).toBeCloseTo(0.875, 10)
  })
  it('T5/T7 clamp too — remaining headroom is never negative', () => {
    const rows = [
      view({ usage: snap({ u5: 1.4, u7: 1.9 }) }),
      view({ name: 'b', usage: snap({ u5: 0.5, u7: 0.5 }) })
    ]
    const p = poolSnapshot(rows, NOW_MS)
    expect(p.t5).toBeCloseTo(0.75, 10)
    expect(p.t7).toBeCloseTo(0.75, 10)
  })
  it('a soon/due member is measured and usable, never walled', () => {
    const rows = [
      view({ usage: snap({ s5: 'rejected', r5: NOW_SEC + 60, u5: 1 }) }),
      view({ name: 'b', usage: snap({ s7: 'rejected', r7: NOW_SEC - 60, u7: 1 }) })
    ]
    const p = poolSnapshot(rows, NOW_MS)
    expect(p.measured).toBe(2)
    expect(p.usable).toBe(2)
    expect(p.walled).toBe(0)
    expect(p.tension).toBeCloseTo(1, 10)
  })
  it('Tfable runs over the hasOi subset only; an exhausted bucket folds to 1', () => {
    const rows = [
      view({ usage: snap({ uoi: 0.5 }) }),
      view({ name: 'b', usage: snap({ uoi: 0.1, soi: 'rejected' }) }),
      view({ name: 'c', usage: snap({ uoi: 1, hasOi: false }) })
    ]
    const p = poolSnapshot(rows, NOW_MS)
    expect(p.tfable).toBeCloseTo(0.75, 10)
    expect(p.fableSpentAll).toBe(false)
  })
  it('every fable member exhausted (rejected or at the stop) → Tfable 1, spent-all', () => {
    const rows = [
      view({ usage: snap({ uoi: FABLE_STOP }) }),
      view({ name: 'b', usage: snap({ uoi: 0.2, soi: 'rejected' }) })
    ]
    const p = poolSnapshot(rows, NOW_MS)
    expect(p.tfable).toBeCloseTo(1, 10)
    expect(p.fableSpentAll).toBe(true)
  })
  it('no plan with an included allowance → no fable reading at all', () => {
    const rows = [
      view({ usage: snap({ uoi: 1, hasOi: false }) }),
      view({ name: 'b', usage: snap({ uoi: 0.4, hasOi: false }) })
    ]
    const p = poolSnapshot(rows, NOW_MS)
    expect(p.tfable).toBe(null)
    expect(p.fableSpentAll).toBe(false)
  })
  it('empty M → zeroed means and null times, but usable still counts the live rows', () => {
    const rows = [
      view({ name: 'cold' }),
      view({ name: 'dead', status: 'expired', usage: snap({}) })
    ]
    expect(poolSnapshot(rows, NOW_MS)).toEqual({
      measured: 0,
      usable: 1,
      walled: 0,
      tension: 0,
      t5: 0,
      t7: 0,
      tfable: null,
      fableSpentAll: false,
      earliestBack: null,
      oldestAt: null
    })
  })
  it('no members at all → the same empty reading with 0 usable', () => {
    expect(poolSnapshot([], NOW_MS)).toMatchObject({ measured: 0, usable: 0, oldestAt: null })
  })
  it('earliestBack = smallest FUTURE reset among the hard windows of walled members', () => {
    const rows = [
      view({ usage: hard({ r5: NOW_SEC + 7_200, s7: 'rejected', r7: NOW_SEC + 9_000 }) }),
      view({ name: 'b', usage: snap({ s7: 'rejected', r7: NOW_SEC + 3_600, u7: 1 }) }),
      view({ name: 'c', usage: snap({ s5: 'rejected', r5: 0, u5: 1 }) }),
      view({ name: 'd', usage: snap({ s5: 'rejected', r5: NOW_SEC + 60, u5: 1 }) })
    ]
    expect(poolSnapshot(rows, NOW_MS).earliestBack).toBe(NOW_SEC + 3_600)
  })
  it('a past reset on a walled account never wins the min (no 1970)', () => {
    const rows = [
      view({ usage: hard({ s7: 'rejected', r7: NOW_SEC - 500 }) }),
      view({ name: 'b', usage: snap({ u5: 0.1 }) })
    ]
    expect(poolSnapshot(rows, NOW_MS).earliestBack).toBe(NOW_SEC + 7_200)
  })
  it('walled only by a missing reset header → no time to promise', () => {
    const rows = [view({ usage: snap({ s5: 'rejected', u5: 1 }) }), view({ name: 'b' })]
    expect(poolSnapshot(rows, NOW_MS).earliestBack).toBe(null)
  })
  it('nothing walled → no earliestBack', () => {
    expect(poolSnapshot([view({ usage: snap({ u5: 0.4 }) })], NOW_MS).earliestBack).toBe(null)
  })
  it('oldestAt is the oldest snapshot IN M — a dead row keeps its stale one to itself', () => {
    const rows = [
      view({ usage: snap({ at: NOW_MS - 1_000 }) }),
      view({ name: 'b', usage: snap({ at: NOW_MS - 5_000 }) }),
      view({ name: 'dead', status: 'expired', usage: snap({ at: NOW_MS - 900_000 }) })
    ]
    expect(poolSnapshot(rows, NOW_MS).oldestAt).toBe(NOW_MS - 5_000)
  })
})

describe('poolGlyph', () => {
  const hardView = (name: string): AccountView =>
    view({ name, usage: snap({ s5: 'rejected', r5: NOW_SEC + 7_200, u5: 1 }) })

  it('under two measured accounts there is no pool to draw', () => {
    expect(poolGlyph([], NOW_MS)).toBe(null)
    expect(poolGlyph([view({ usage: snap({ u5: 0.5 }) }), view({ name: 'cold' })], NOW_MS)).toBe(
      null
    )
  })
  it('two measured accounts → a bar at the mean tension', () => {
    const rows = [
      view({ usage: snap({ u7: 0.25 }) }),
      view({ name: 'b', usage: snap({ u5: 0.75 }) })
    ]
    expect(poolGlyph(rows, NOW_MS)).toEqual({
      kind: 'bar',
      frac: 0.5,
      level: '',
      stale: false,
      fable: { frac: 0, spent: false }
    })
  })
  it('one walled member does not wall the pool — it just weighs 1 in the mean', () => {
    const rows = [hardView('a'), view({ name: 'b', usage: snap({ u5: 0.5 }) })]
    expect(poolGlyph(rows, NOW_MS)).toMatchObject({ kind: 'bar', frac: 0.75, level: 'warn' })
  })
  it('every measured member hard-walled → the top rail', () => {
    expect(poolGlyph([hardView('a'), hardView('b')], NOW_MS)).toEqual({
      kind: 'walled',
      stale: false
    })
  })
  it('a pool short of the wall never touches the top rail', () => {
    const rows = [
      view({ usage: snap({ u5: 0.95 }) }),
      view({ name: 'b', usage: snap({ u5: 0.97 }) })
    ]
    expect(poolGlyph(rows, NOW_MS)).toMatchObject({ kind: 'bar', frac: CAP, level: 'bad' })
  })
  it('fades on the oldest snapshot in M; exactly 15min is not yet stale', () => {
    const pair = (age: number): AccountView[] => [
      view({ usage: snap({ u5: 0.4, at: NOW_MS }) }),
      view({ name: 'b', usage: snap({ u5: 0.4, at: NOW_MS - age }) })
    ]
    expect(poolGlyph(pair(STALE_MS), NOW_MS)).toMatchObject({ stale: false })
    expect(poolGlyph(pair(STALE_MS + 1), NOW_MS)).toMatchObject({ stale: true })
  })
  it('a walled pool carries staleness too', () => {
    const rows = [
      hardView('a'),
      view({
        name: 'b',
        usage: snap({ s5: 'rejected', r5: NOW_SEC + 7_200, u5: 1, at: NOW_MS - STALE_MS - 1 })
      })
    ]
    expect(poolGlyph(rows, NOW_MS)).toEqual({ kind: 'walled', stale: true })
  })
  it('no fable data in the pool → no fable layer', () => {
    const rows = [
      view({ usage: snap({ u5: 0.5, hasOi: false }) }),
      view({ name: 'b', usage: snap({ u5: 0.5, uoi: 0.9, hasOi: false }) })
    ]
    expect(poolGlyph(rows, NOW_MS)).toMatchObject({ fable: null })
  })
  it('every fable bucket exhausted → a spent layer, capped by the same top rail', () => {
    const rows = [
      view({ usage: snap({ u5: 0.5, uoi: 1 }) }),
      view({ name: 'b', usage: snap({ u5: 0.5, soi: 'rejected' }) })
    ]
    expect(poolGlyph(rows, NOW_MS)).toMatchObject({ fable: { frac: CAP, spent: true } })
  })
})

/** §4.2: the reset subline is resident, so it has a state for every situation. */
describe('sublineFor', () => {
  it('5h healthy with a reset → a plain time, faint', () => {
    expect(sublineFor('5h', snap({ u5: 0.4, r5: NOW_SEC + 1_320 }), NOW_SEC)).toEqual({
      kind: 'time',
      epoch: NOW_SEC + 1_320,
      tone: 'faint'
    })
  })
  it('healthy with no reset header → an empty placeholder, never a missing line', () => {
    expect(sublineFor('5h', snap({ u5: 0.4, r5: 0 }), NOW_SEC)).toEqual({
      kind: 'none',
      epoch: 0,
      tone: 'faint'
    })
  })
  it('soon → amber "back"', () => {
    expect(sublineFor('5h', snap({ s5: 'rejected', r5: NOW_SEC + 480 }), NOW_SEC)).toEqual({
      kind: 'back',
      epoch: NOW_SEC + 480,
      tone: 'amber'
    })
  })
  it('due → a faint "due": never render a moment that already passed', () => {
    expect(sublineFor('5h', snap({ s5: 'rejected', r5: NOW_SEC - 30 }), NOW_SEC)).toEqual({
      kind: 'due',
      epoch: NOW_SEC - 30,
      tone: 'faint'
    })
  })
  it('hard with a reset → red "back"', () => {
    expect(sublineFor('5h', snap({ s5: 'rejected', r5: NOW_SEC + GRACE }), NOW_SEC)).toEqual({
      kind: 'back',
      epoch: NOW_SEC + GRACE,
      tone: 'red'
    })
  })
  it('hard with no reset data → red "walled": the alarm keeps a text channel', () => {
    expect(sublineFor('5h', snap({ s5: 'rejected', r5: 0 }), NOW_SEC)).toEqual({
      kind: 'walled',
      epoch: 0,
      tone: 'red'
    })
  })
  it('each column reads its own window', () => {
    const u = snap({ r5: NOW_SEC + 60, s7: 'rejected', r7: NOW_SEC + 86_400 })
    expect(sublineFor('5h', u, NOW_SEC)).toEqual({
      kind: 'time',
      epoch: NOW_SEC + 60,
      tone: 'faint'
    })
    expect(sublineFor('7d', u, NOW_SEC)).toEqual({
      kind: 'back',
      epoch: NOW_SEC + 86_400,
      tone: 'red'
    })
  })
  it('fable spent (rejected bucket) → "spent" with its reset, faint', () => {
    expect(
      sublineFor('oi', snap({ uoi: 0.1, soi: 'rejected', roi: NOW_SEC + 86_400 }), NOW_SEC)
    ).toEqual({ kind: 'spent', epoch: NOW_SEC + 86_400, tone: 'faint' })
  })
  it('fable at the stop reads spent as well', () => {
    expect(sublineFor('oi', snap({ uoi: FABLE_STOP, roi: NOW_SEC + 100 }), NOW_SEC)).toMatchObject({
      kind: 'spent'
    })
  })
  it('fable with room left → a plain time, and none when the header is missing', () => {
    expect(sublineFor('oi', snap({ uoi: 0.5, roi: NOW_SEC + 100 }), NOW_SEC)).toEqual({
      kind: 'time',
      epoch: NOW_SEC + 100,
      tone: 'faint'
    })
    expect(sublineFor('oi', snap({ uoi: 0.5, roi: 0 }), NOW_SEC)).toEqual({
      kind: 'none',
      epoch: 0,
      tone: 'faint'
    })
  })
  it('a walled account does not colour its fable cell', () => {
    const u = snap({ s5: 'rejected', r5: NOW_SEC + 7_200, uoi: 0.5, roi: NOW_SEC + 100 })
    expect(sublineFor('oi', u, NOW_SEC)).toEqual({
      kind: 'time',
      epoch: NOW_SEC + 100,
      tone: 'faint'
    })
  })
})
