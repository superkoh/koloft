import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AccountMeta, UsageSnapshot } from '../../src/shared/types'
import {
  AccountPicker,
  FABLE_EXHAUSTED_LINE,
  PICK_BUDGET_MS,
  type PickDeps
} from '../../src/main/accountPicker'
import type { ProbeResult } from '../../src/main/usageProbe'

/** U4 — pick orchestration: cache short-circuit / single-flight / two-tier pool /
 *  degradation ladder (tests.md §2.4). Deps fully injected; no wall clocks except
 *  the deliberate budget-timeout case. */

const NOW_S = 1_700_000_000
const NOW_MS = NOW_S * 1000

function meta(p: Partial<AccountMeta>): AccountMeta {
  return {
    name: 'a',
    kind: 'oauth',
    enabled: true,
    fable: 'unknown',
    status: 'ok',
    addedAt: 1,
    ...p
  }
}

function usage(p: Partial<UsageSnapshot>): UsageSnapshot {
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
    at: NOW_MS,
    ...p
  }
}

/** the second banner line, printed whenever the PICKED account has no fable allowance
 *  left to spend (the design state ②, re-judged per account by D21) */
const FABLE_GONE = FABLE_EXHAUSTED_LINE

/** hard-limited snapshot: rejected with reset ≥ grace away */
function walled(extra: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return usage({ u5: 1, s5: 'rejected', r5: NOW_S + 7200, ...extra })
}

interface Harness {
  picker: AccountPicker
  probeCalls: string[]
  setProbe(name: string, r: ProbeResult): void
  /** move the injected clock forward (ms) — snapshots age against this, not wall time */
  advance(ms: number): void
}

function makeHarness(
  accounts: AccountMeta[],
  opts?: { multiAccount?: boolean; fablePriority?: boolean }
): Harness {
  const results = new Map<string, ProbeResult>()
  const probeCalls: string[] = []
  const secretOf = new Map(accounts.map((a) => [`${a.kind}:${a.name}`, `tok-${a.name}`]))
  let clock = NOW_MS
  const deps: PickDeps = {
    listAccounts: () => accounts,
    multiAccountOn: () => opts?.multiAccount !== false,
    fablePriority: () => opts?.fablePriority !== false,
    readSecret: async (kind, name) => secretOf.get(`${kind}:${name}`) ?? null,
    probe: async (_a, secret) => {
      const name = secret.replace(/^tok-/, '')
      probeCalls.push(name)
      const r = results.get(name) ?? { ok: false, error: 'network' }
      // stamp the snapshot with the CURRENT injected clock, like probeAccount does
      return r.ok && r.usage ? { ...r, usage: { ...r.usage, at: clock } } : r
    },
    onProbeOutcome: () => {},
    now: () => clock
  }
  return {
    picker: new AccountPicker(deps),
    probeCalls,
    setProbe: (name, r) => results.set(name, r),
    advance: (ms) => {
      clock += ms
    }
  }
}

describe('U4 · mode / empty-pool gates', () => {
  it('mode off → immediate {account:null, reason:disabled}', async () => {
    const h = makeHarness([meta({ name: 'bravo' })], { multiAccount: false })
    expect(await h.picker.pick()).toEqual({ account: null, reason: 'disabled' })
    expect(h.probeCalls).toHaveLength(0)
  })

  it('empty pool → no-accounts', async () => {
    const h = makeHarness([])
    expect(await h.picker.pick()).toEqual({ account: null, reason: 'no-accounts' })
  })

  it('disabled and expired accounts never participate', async () => {
    const h = makeHarness([
      meta({ name: 'off', enabled: false }),
      meta({ name: 'dead', status: 'expired' }),
      meta({ name: 'unv', status: 'unverified' })
    ])
    expect(await h.picker.pick()).toEqual({ account: null, reason: 'no-accounts' })
  })
})

describe('U4 · selection + banner', () => {
  it('picks the least-loaded account and pins the banner format', async () => {
    const h = makeHarness([meta({ name: 'alpha' }), meta({ name: 'bravo' })])
    h.setProbe('alpha', { ok: true, usage: usage({ u5: 0.9, u7: 0.5 }) })
    h.setProbe('bravo', {
      ok: true,
      usage: usage({ u5: 0.33, u7: 0.52, uoi: 0.34, soi: 'allowed', hasOi: true })
    })
    const r = await h.picker.pick()
    expect(r).toEqual({
      account: 'bravo',
      kind: 'oauth',
      banner: 'koloft: → bravo · 5h 33% · 7d 52% · fable 34%'
    })
  })

  it('no fable host anywhere → no fable segment, plus the "it will be billed" line', async () => {
    const h = makeHarness([meta({ name: 'bravo' })])
    h.setProbe('bravo', { ok: true, usage: usage({ u5: 0.1, u7: 0.2 }) })
    const r = await h.picker.pick()
    expect(r).toMatchObject({ banner: 'koloft: → bravo · 5h 10% · 7d 20%', warning: FABLE_GONE })
  })
})

describe('U4 · fable-host routing (rev2 D17/D19)', () => {
  it('an account whose fable bucket is spent stops hosting: pool routes on 5h/7d only', async () => {
    const h = makeHarness([meta({ name: 'burned' }), meta({ name: 'plain' })])
    // burned has an INCLUDED allowance and has spent it; plain has none at all
    h.setProbe('burned', {
      ok: true,
      usage: usage({ u5: 0.05, u7: 0.5, uoi: 0.99, soi: 'allowed', hasOi: true })
    })
    h.setProbe('plain', { ok: true, usage: usage({ u5: 0.6, u7: 0.8 }) })
    const r = await h.picker.pick()
    expect(r.account).toBe('burned') // opus route: oi discarded, burned is the idler
    if (r.account) expect(r.warning).toBe(FABLE_GONE)
    if (r.account) expect(r.banner).not.toContain('fable 99%')
  })

  it('a fable host outranks an idler with no included allowance', async () => {
    const h = makeHarness([meta({ name: 'host' }), meta({ name: 'idle' })])
    h.setProbe('host', {
      ok: true,
      usage: usage({ u5: 0.4, u7: 0.5, uoi: 0.4, soi: 'allowed', hasOi: true })
    })
    h.setProbe('idle', { ok: true, usage: usage({ u5: 0.01, u7: 0.02 }) })
    const r = await h.picker.pick()
    expect(r.account).toBe('host')
    if (r.account) expect(r.banner).toBe('koloft: → host · 5h 40% · 7d 50% · fable 40%')
  })

  // D19 health gate: hosting fable means routing REAL work there, so a host must be
  // healthy on 5h/7d too — a rejected-but-recovering account is not.
  it('rejected-inside-grace disqualifies a fable host even though it is not hard-limited', async () => {
    const alpha = usage({ uoi: 0.4, soi: 'allowed', hasOi: true, s5: 'rejected', r5: NOW_S + 1500 })
    const h = makeHarness([meta({ name: 'alpha' }), meta({ name: 'beta' })])
    h.setProbe('alpha', { ok: true, usage: alpha })
    h.setProbe('beta', { ok: true, usage: usage({ u5: 0.01, u7: 0.1 }) })
    const r = await h.picker.pick()
    expect(r.account).toBe('beta')
    if (r.account) expect(r.warning).toBe(FABLE_GONE)

    // control: the SAME account without the rejection does host
    const h2 = makeHarness([meta({ name: 'alpha' }), meta({ name: 'beta' })])
    h2.setProbe('alpha', { ok: true, usage: { ...alpha, s5: 'allowed', r5: 0 } })
    h2.setProbe('beta', { ok: true, usage: usage({ u5: 0.01, u7: 0.1 }) })
    expect((await h2.picker.pick()).account).toBe('alpha')
  })

  it('a 5h bucket near its ceiling disqualifies a fable host (D19 lower half)', async () => {
    const h = makeHarness([meta({ name: 'hot' }), meta({ name: 'cool' })])
    h.setProbe('hot', {
      ok: true,
      usage: usage({ u5: 0.86, uoi: 0.1, soi: 'allowed', hasOi: true })
    })
    h.setProbe('cool', { ok: true, usage: usage({ u5: 0.2 }) })
    const r = await h.picker.pick()
    expect(r.account).toBe('cool')
    if (r.account) expect(r.warning).toBe(FABLE_GONE)
  })

  // Eligibility reads RAW utilization: the reset discount is for ranking only. Seen
  // — fable 99% with the week resetting in 50 min discounted to ~15%, so the
  // account hosted, won as the idler, and the session's first hour had no allowance.
  it('a spent fable bucket about to reset is still not a host (no discount on eligibility)', async () => {
    const h = makeHarness([meta({ name: 'resetting' }), meta({ name: 'koh' })])
    h.setProbe('resetting', {
      ok: true,
      usage: usage({
        u5: 0,
        u7: 0.57,
        uoi: 0.99,
        soi: 'allowed',
        hasOi: true,
        r7: NOW_S + 3000,
        roi: NOW_S + 3000
      })
    })
    h.setProbe('koh', {
      ok: true,
      usage: usage({ u5: 0.38, u7: 0.13, uoi: 0.25, soi: 'allowed', hasOi: true })
    })
    const r = await h.picker.pick()
    expect(r.account).toBe('koh')
    if (r.account) expect(r.warning).toBeUndefined()
  })

  // …but a reading whose reset has already PASSED is void: the bucket is full again.
  // Snapshots never expire and a pick answers from cache, so the first launch after a
  // weekly reset scores the pre-reset 99% — that account must host, with no billing line.
  it('a spent fable reading whose reset has passed hosts again, without the billing line', async () => {
    const h = makeHarness([meta({ name: 'renewed' }), meta({ name: 'plain' })])
    h.setProbe('renewed', {
      ok: true,
      usage: usage({ uoi: 0.99, soi: 'allowed', hasOi: true, roi: NOW_S - 3600 })
    })
    h.setProbe('plain', { ok: true, usage: usage({ u5: 0.01 }) })
    const r = await h.picker.pick()
    expect(r.account).toBe('renewed')
    if (r.account) expect(r.warning).toBeUndefined()
  })

  it('a hot 5h reading whose reset has passed no longer disqualifies a fable host', async () => {
    const h = makeHarness([meta({ name: 'cooled' }), meta({ name: 'other' })])
    h.setProbe('cooled', {
      ok: true,
      usage: usage({ u5: 0.9, r5: NOW_S - 600, uoi: 0.3, soi: 'allowed', hasOi: true })
    })
    h.setProbe('other', {
      ok: true,
      usage: usage({ u5: 0.2, uoi: 0.5, soi: 'allowed', hasOi: true })
    })
    // fable route with both as hosts: cooled's 5h is void (0), other's is 0.2 → cooled
    expect((await h.picker.pick()).account).toBe('cooled')
  })

  it('a rejected 7d_oi bucket is not a host even below the stop line', async () => {
    const h = makeHarness([meta({ name: 'shut' }), meta({ name: 'plain' })])
    h.setProbe('shut', { ok: true, usage: usage({ uoi: 0.3, soi: 'rejected', hasOi: true }) })
    h.setProbe('plain', { ok: true, usage: usage({ u5: 0.5 }) })
    const r = await h.picker.pick()
    expect(r.account).toBe('shut') // still the idler on 5h/7d — but on the opus route
    if (r.account) expect(r.warning).toBe(FABLE_GONE)
  })

  it('two opus candidates tied on every layer still resolve — never no-usable', async () => {
    const h = makeHarness([meta({ name: 'twin-a' }), meta({ name: 'twin-b' })])
    h.setProbe('twin-a', { ok: true, usage: usage({ u5: 0.3, u7: 0.4 }) })
    h.setProbe('twin-b', { ok: true, usage: usage({ u5: 0.3, u7: 0.4 }) })
    const r = await h.picker.pick()
    expect(r.account).toBe('twin-a')
  })

  // near-equal accounts (every layer within EPS): the one whose weekly quota voids
  // clearly sooner still wins every launch — use it up before it resets…
  it('near-equal accounts: a clearly earlier weekly reset still wins every launch', async () => {
    const h = makeHarness([meta({ name: 'a' }), meta({ name: 'b' })])
    h.setProbe('a', {
      ok: true,
      usage: usage({ u5: 0.3, u7: 0.4, r5: NOW_S + 36_000, r7: NOW_S + 360_000 })
    })
    h.setProbe('b', {
      ok: true,
      usage: usage({ u5: 0.32, u7: 0.4, r5: NOW_S + 36_000, r7: NOW_S + 300_000 })
    })
    expect((await h.picker.pick()).account).toBe('b')
    expect((await h.picker.pick()).account).toBe('b')
  })

  // …but resets within 6h of each other say nothing, and list order used to hand
  // every new session to the same account.
  it('near-equal accounts resetting together rotate across launches instead of sticking to one', async () => {
    const h = makeHarness([meta({ name: 'a' }), meta({ name: 'b' })])
    h.setProbe('a', {
      ok: true,
      usage: usage({ u5: 0.3, u7: 0.4, r5: NOW_S + 36_000, r7: NOW_S + 360_000 })
    })
    h.setProbe('b', {
      ok: true,
      usage: usage({ u5: 0.32, u7: 0.4, r5: NOW_S + 36_000, r7: NOW_S + 350_000 })
    })
    const first = await h.picker.pick()
    const second = await h.picker.pick()
    expect([first.account, second.account].sort()).toEqual(['a', 'b'])
  })
})

describe('U4 · fable-priority switch (rev3 D20/D21)', () => {
  // D20: the switch decides whether the included fable allowance is a routing
  // dimension at all. Off, a healthy host stops collapsing the pool onto itself —
  // which is the whole point: 5h/7d load is the only thing left to rank on.
  it('switch off: a fable host no longer wins over an idler with no allowance', async () => {
    const pool = [meta({ name: 'host' }), meta({ name: 'idle' })]
    const usages: [string, UsageSnapshot][] = [
      ['host', usage({ u5: 0.4, u7: 0.5, uoi: 0.4, soi: 'allowed', hasOi: true })],
      ['idle', usage({ u5: 0.01, u7: 0.02 })]
    ]
    const off = makeHarness(pool, { fablePriority: false })
    for (const [n, u] of usages) off.setProbe(n, { ok: true, usage: u })
    const r = await off.picker.pick()
    // opus route: oi discarded → host s1 = 0.40, idle s1 = 0.01, gap > EPS
    expect(r).toEqual({
      account: 'idle',
      kind: 'oauth',
      banner: 'koloft: → idle · 5h 1% · 7d 2%',
      warning: FABLE_GONE
    })

    // control: the SAME pool with the switch on still routes on fable
    const on = makeHarness(pool)
    for (const [n, u] of usages) on.setProbe(n, { ok: true, usage: u })
    expect((await on.picker.pick()).account).toBe('host')
  })

  // D21: the billing line is judged on the PICKED account's own allowance, not on
  // whether the pool held a host. Switch off, the winner can still have fable left —
  // saying "this will be billed" there is a lie, and a lying warning trains the user
  // to skip the one line standing between them and a metered session.
  it('switch off + the picked account still holds allowance → no billing line', async () => {
    const pool = [meta({ name: 'busy' }), meta({ name: 'spare' })]
    const usages: [string, UsageSnapshot][] = [
      ['busy', usage({ u5: 0.6, u7: 0.1, uoi: 0.1, soi: 'allowed', hasOi: true })],
      ['spare', usage({ u5: 0.05, u7: 0.1, uoi: 0.8, soi: 'allowed', hasOi: true })]
    ]
    const off = makeHarness(pool, { fablePriority: false })
    for (const [n, u] of usages) off.setProbe(n, { ok: true, usage: u })
    // opus route: s1 0.05 (spare) vs 0.60 (busy). spare's allowance is 80% used —
    // deep, but NOT spent, so this launch is not about to be billed.
    expect(await off.picker.pick()).toEqual({
      account: 'spare',
      kind: 'oauth',
      banner: 'koloft: → spare · 5h 5% · 7d 10%'
    })

    // control: with the switch on, spare's 1.0 oi component sends the pick to busy
    const on = makeHarness(pool)
    for (const [n, u] of usages) on.setProbe(n, { ok: true, usage: u })
    expect((await on.picker.pick()).account).toBe('busy')
  })

  // the same judge, isolated from the switch: D19's health gate can empty the host
  // set while every allowance is still intact, and that is an opus route whose winner
  // is NOT about to be billed.
  it('switch on, no host (all 5h-hot) but the winner holds allowance → no billing line', async () => {
    const h = makeHarness([meta({ name: 'hot-a' }), meta({ name: 'hot-b' })])
    h.setProbe('hot-a', {
      ok: true,
      usage: usage({ u5: 0.86, u7: 0.1, uoi: 0.1, soi: 'allowed', hasOi: true })
    })
    h.setProbe('hot-b', {
      ok: true,
      usage: usage({ u5: 0.9, u7: 0.1, uoi: 0.1, soi: 'allowed', hasOi: true })
    })
    const r = await h.picker.pick()
    expect(r.account).toBe('hot-a') // 0.86 vs 0.90 — inside EPS, original order wins
    if (r.account) expect(r.warning).toBeUndefined()
  })
})

describe('U4 · cache short-circuit and single-flight', () => {
  it('a ≤30s-fresh snapshot for every enabled sub skips probing entirely', async () => {
    const h = makeHarness([meta({ name: 'bravo' })])
    h.setProbe('bravo', { ok: true, usage: usage({ u5: 0.1 }) })
    await h.picker.pick()
    expect(h.probeCalls).toEqual(['bravo'])
    await h.picker.pick() // same injected now → cache is 0s old
    expect(h.probeCalls).toEqual(['bravo']) // no second probe
  })

  it('concurrent picks coalesce onto one probe round', async () => {
    const h = makeHarness([meta({ name: 'bravo' })])
    h.setProbe('bravo', { ok: true, usage: usage({ u5: 0.1 }) })
    await Promise.all([h.picker.pick(), h.picker.pick(), h.picker.pick()])
    expect(h.probeCalls).toEqual(['bravo'])
  })

  // regression: the single-flight latch must RELEASE after its round settles. It once
  // stored `round.finally(...)` (a different promise than the one the cleanup compared
  // against), so it never cleared and every later round was skipped — usage froze at
  // the first reading for the life of the app and selection stopped following usage.
  it('past the fresh window a later pick probes AGAIN, and the new reading steers the pick after it', async () => {
    const h = makeHarness([meta({ name: 'a' }), meta({ name: 'b' })])
    h.setProbe('a', { ok: true, usage: usage({ u5: 0.1 }) })
    h.setProbe('b', { ok: true, usage: usage({ u5: 0.9 }) })
    expect((await h.picker.pick()).account).toBe('a')
    expect(h.probeCalls).toHaveLength(2)

    // usage flips while the app keeps running
    h.setProbe('a', { ok: true, usage: usage({ u5: 0.95 }) })
    h.setProbe('b', { ok: true, usage: usage({ u5: 0.05 }) })
    h.advance(31_000) // past FRESH_CACHE_MS
    expect((await h.picker.pick()).account).toBe('a') // answered from the cache it had
    expect(h.probeCalls).toHaveLength(4) // a real second round, not a stale replay
    // the round lands on its own schedule — wait for its EFFECT, not for a tick count
    await vi.waitFor(async () => {
      expect((await h.picker.pick()).account).toBe('b') // …which the next launch follows
    })
  })

  // The probe is a 4–5s call (claude-fable-5, measured) — far past any deadline a
  // launch can wait on. So the cache is the answer and the round is a refresh for the
  // NEXT launch: no snapshot ever expires, and a pick that has one never waits.
  it('a snapshot older than any window still scores — a stale reading beats round-robin', async () => {
    const h = makeHarness([meta({ name: 'a' }), meta({ name: 'b' })])
    h.setProbe('a', { ok: true, usage: usage({ u5: 0.9 }) })
    h.setProbe('b', { ok: true, usage: usage({ u5: 0.1 }) })
    expect((await h.picker.pick()).account).toBe('b')

    h.advance(3_600_000) // an hour later — every probe now fails
    h.setProbe('a', { ok: false, error: 'network' })
    h.setProbe('b', { ok: false, error: 'network' })
    const r = await h.picker.pick()
    expect(r.account).toBe('b') // the hour-old reading, not the cursor
    if (r.account) expect(r.banner).not.toContain('round-robin')
  })

  it('a pick holding any snapshot answers WITHOUT awaiting the round it starts', async () => {
    const h = makeHarness([meta({ name: 'a' }), meta({ name: 'b' })])
    h.setProbe('a', { ok: true, usage: usage({ u5: 0.1 }) })
    h.setProbe('b', { ok: true, usage: usage({ u5: 0.9 }) })
    await h.picker.pick()
    h.advance(31_000)
    // a round that never resolves: the pick must not be inside it
    const deps = (h.picker as unknown as { deps: PickDeps }).deps
    deps.probe = () => new Promise<ProbeResult>(() => {})
    const t0 = Date.now()
    const r = await h.picker.pick()
    expect(Date.now() - t0).toBeLessThan(PICK_BUDGET_MS) // not even the budget was spent
    expect(r.account).toBe('a')
  })

  it('the fable-host gate reads the newest snapshot whatever its age', async () => {
    const h = makeHarness([meta({ name: 'a' })])
    h.setProbe('a', {
      ok: true,
      usage: usage({ u5: 0.1, uoi: 0.2, soi: 'allowed', hasOi: true })
    })
    const fresh = await h.picker.pick()
    if (fresh.account) expect(fresh.warning).toBeUndefined() // fable route, no metered line

    h.advance(3_600_000)
    h.setProbe('a', { ok: false, error: 'network' })
    const r = await h.picker.pick()
    expect(r.account).toBe('a')
    if (r.account) {
      expect(r.banner).toContain('fable 20%') // still the fable route
      expect(r.warning).toBeUndefined()
    }
  })

  it('the banner discloses the reading age once it is stale, and not before', async () => {
    const h = makeHarness([meta({ name: 'bravo' })])
    h.setProbe('bravo', { ok: true, usage: usage({ u5: 0.1, u7: 0.2 }) })
    const fresh = await h.picker.pick()
    if (fresh.account) expect(fresh.banner).toBe('koloft: → bravo · 5h 10% · 7d 20%')

    h.advance(14 * 60_000) // still inside STALE_MS — the numbers still read as live
    h.setProbe('bravo', { ok: false, error: 'network' })
    const mid = await h.picker.pick()
    if (mid.account) expect(mid.banner).toBe('koloft: → bravo · 5h 10% · 7d 20%')

    h.advance(8 * 60_000) // 22 min old
    const old = await h.picker.pick()
    if (old.account) expect(old.banner).toBe('koloft: → bravo · 5h 10% · 7d 20% · 22 min ago')
  })

  it('forget() drops a snapshot so a re-added name is never scored on the old account', async () => {
    const h = makeHarness([meta({ name: 'a' }), meta({ name: 'b' })])
    h.setProbe('a', { ok: true, usage: usage({ u5: 0.9 }) })
    h.setProbe('b', { ok: true, usage: usage({ u5: 0.1 }) })
    expect((await h.picker.pick()).account).toBe('b')

    h.picker.forget('oauth', 'b') // the row was removed from the pool
    h.advance(31_000)
    h.setProbe('b', { ok: false, error: 'network' })
    expect((await h.picker.pick()).account).toBe('a') // b has no reading at all now
  })

  it('cacheUsage (settings-panel refresh) feeds the SAME cache selection scores from', async () => {
    const h = makeHarness([meta({ name: 'a' }), meta({ name: 'b' })])
    // no probe results configured: probing fails, so only injected snapshots exist —
    // proving the panel's refresh alone is enough to steer the next pick
    h.picker.cacheUsage('oauth', 'a', usage({ u5: 0.9 }))
    h.picker.cacheUsage('oauth', 'b', usage({ u5: 0.1 }))
    expect((await h.picker.pick()).account).toBe('b')
  })
})

describe('U4 · two-tier pool (D11 + grace)', () => {
  const subs = [meta({ name: 's1' }), meta({ name: 's2' })]
  const api = meta({ name: 'api-main', kind: 'apikey' })

  it('all subs hard-limited + enabled API key → metered fallback whose banner says so', async () => {
    const h = makeHarness([...subs, api])
    h.setProbe('s1', { ok: true, usage: walled() })
    h.setProbe('s2', { ok: true, usage: walled() })
    const r = await h.picker.pick()
    expect(r).toMatchObject({ account: 'api-main', kind: 'apikey' })
    if (r.account) expect(r.banner).toContain('metered')
  })

  it('rejected but resetting INSIDE grace → not hard-limited, stays on subscriptions', async () => {
    const h = makeHarness([...subs, api])
    h.setProbe('s1', { ok: true, usage: walled() })
    h.setProbe('s2', { ok: true, usage: usage({ u5: 1, s5: 'rejected', r5: NOW_S + 300 }) })
    const r = await h.picker.pick()
    expect(r).toMatchObject({ account: 's2', kind: 'oauth' }) // lighter pen wins too
  })

  it('MIXED case: one probe failed + rest rejected → NO metered fallback (flaps must not spend)', async () => {
    const h = makeHarness([...subs, api])
    h.setProbe('s1', { ok: true, usage: walled() })
    h.setProbe('s2', { ok: false, error: 'network' })
    const r = await h.picker.pick()
    expect(r).toMatchObject({ kind: 'oauth' }) // s1 — the only scored candidate
    expect(r.account).toBe('s1')
  })

  it('all hard-limited, NO api key → plain leximax, banner names the reset', async () => {
    const h = makeHarness(subs)
    h.setProbe('s1', { ok: true, usage: walled({ r5: NOW_S + 7200 }) })
    h.setProbe('s2', { ok: true, usage: walled({ r5: NOW_S + 3600 }) })
    const r = await h.picker.pick()
    // pen: s1 → min(1, 7200/1800)=1, s2 → 1 as well (≥grace both) — p5 differs:
    // s1: 1×7200/10800=0.667+1, s2: 1×3600/10800=0.333+1 → s2 (earlier reset) wins
    expect(r.account).toBe('s2')
    if (r.account) expect(r.banner).toContain('every account rate-limited')
  })

  // Snapshots no longer expire, but the metered switch is the one branch that SPENDS
  // — it keeps the pre-cache-first freshness bound so an old wall cannot bill anyone.
  it('an old wall reading never spends: the metered switch keeps its freshness bound', async () => {
    const h = makeHarness([...subs, api])
    h.setProbe('s1', { ok: true, usage: walled() })
    h.setProbe('s2', { ok: true, usage: walled() })
    expect((await h.picker.pick()).account).toBe('api-main') // fresh wall → metered

    h.advance(3 * 60_000) // the wall still stands (reset is 2h out) but the reading is old
    h.setProbe('s1', { ok: false, error: 'network' })
    h.setProbe('s2', { ok: false, error: 'network' })
    const r = await h.picker.pick()
    // stays on the free tier rather than guessing with money
    expect(r).toMatchObject({ kind: 'oauth' })
    if (r.account) expect(r.banner).toContain('every account rate-limited')
  })

  it('a custom endpoint shares the fallback tier and its banner names the model', async () => {
    const custom = meta({ name: 'glm', kind: 'custom', model: 'glm-5.2' })
    const h = makeHarness([...subs, custom])
    h.setProbe('s1', { ok: true, usage: walled() })
    h.setProbe('s2', { ok: true, usage: walled() })
    const r = await h.picker.pick()
    expect(r).toMatchObject({ account: 'glm', kind: 'custom' })
    // switching endpoint also switches MODEL — the banner has to say which
    if (r.account) expect(r.banner).toContain('glm-5.2')
  })

  it('a custom endpoint never outranks a healthy subscription', async () => {
    const custom = meta({ name: 'glm', kind: 'custom', model: 'glm-5.2' })
    const h = makeHarness([...subs, custom])
    h.setProbe('s1', { ok: true, usage: usage({ u5: 0.8 }) })
    h.setProbe('s2', { ok: true, usage: walled() })
    const r = await h.picker.pick()
    expect(r).toMatchObject({ account: 's1', kind: 'oauth' })
  })

  it('subscription-free pool: API keys round-robin as the only tier', async () => {
    const h = makeHarness([api, meta({ name: 'api-2', kind: 'apikey' })])
    const first = await h.picker.pick()
    const second = await h.picker.pick()
    expect(first.account).not.toBe(second.account)
    if (first.account) expect(first.banner).toContain('metered')
  })
})

describe('U4 · degradation ladder', () => {
  it('every probe fails → round-robin with a persistent cursor, launch never blocked', async () => {
    const h = makeHarness([meta({ name: 'a' }), meta({ name: 'b' })])
    // default probe result is network failure
    const r1 = await h.picker.pick()
    const r2 = await h.picker.pick()
    expect(r1.account).not.toBeNull()
    expect(r2.account).not.toBeNull()
    expect(r1.account).not.toBe(r2.account) // cursor advanced
    if (r1.account) expect(r1.banner).toContain('round-robin')
  })

  // disc() reads a reset that has already passed as "this window's data is void" (0),
  // so a snapshot old enough to outlive its own resets scores every account a flat 0.
  // The reset tie-break must read those elapsed resets as void too — else, with the
  // two dead resets days apart (the usual shape for independent subscriptions), every
  // launch goes to whichever account's reset died first. A pool with nothing to say
  // must spread, not pick a favourite.
  it('a pool scored flat zero carries no signal — spread instead of hammering one account', async () => {
    const h = makeHarness([meta({ name: 'a' }), meta({ name: 'b' })])
    h.setProbe('a', {
      ok: true,
      usage: usage({ u5: 0.8, u7: 0.5, r5: NOW_S + 3600, r7: NOW_S + 3600 })
    })
    h.setProbe('b', {
      ok: true,
      usage: usage({ u5: 0.2, u7: 0.1, r5: NOW_S + 3600, r7: NOW_S + 9 * 3600 })
    })
    expect((await h.picker.pick()).account).toBe('b') // fresh: the idler wins on merit

    h.advance(48 * 3_600_000) // both resets long past, 8h apart (> tie window); probes stay down
    h.setProbe('a', { ok: false, error: 'network' })
    h.setProbe('b', { ok: false, error: 'network' })
    const first = await h.picker.pick()
    const second = await h.picker.pick()
    expect([first.account, second.account].sort()).toEqual(['a', 'b'])
  })

  it('a single failed account drops out of the round without blocking the rest', async () => {
    const h = makeHarness([meta({ name: 'good' }), meta({ name: 'flaky' })])
    h.setProbe('good', { ok: true, usage: usage({ u5: 0.4 }) })
    h.setProbe('flaky', { ok: false, error: 'network' })
    const r = await h.picker.pick()
    expect(r.account).toBe('good')
  })

  it('probe round exceeding the 2s budget → cache/round-robin answer, not a hang', async () => {
    const h = makeHarness([meta({ name: 'slow' })])
    // a probe that never resolves inside the test window
    const never = new Promise<ProbeResult>(() => {})
    const deps = (h.picker as unknown as { deps: PickDeps }).deps
    deps.probe = () => never
    const t0 = Date.now()
    const r = await h.picker.pick()
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(4000) // 2s budget + slack, NOT the probe's lifetime
    expect(r.account).toBe('slow') // round-robin fallback
    if (r.account) expect(r.banner).toContain('round-robin')
  }, 10_000)
})
