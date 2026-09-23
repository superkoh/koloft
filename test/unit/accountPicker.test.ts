import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AccountMeta, UsageSnapshot } from '../../src/shared/types'
import {
  AccountPicker,
  FABLE_EXHAUSTED_LINE,
  PICK_BUDGET_MS,
  PROBE_TIMEOUT_MS,
  type PickDeps
} from '../../src/main/accountPicker'
import type { ProbeResult } from '../../src/main/usageProbe'

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

const FABLE_GONE = FABLE_EXHAUSTED_LINE

function walled(extra: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return usage({ u5: 1, s5: 'rejected', r5: NOW_S + 7200, ...extra })
}

interface Harness {
  picker: AccountPicker
  probeCalls: string[]
  setProbe(name: string, r: ProbeResult): void
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
    h.setProbe('burned', {
      ok: true,
      usage: usage({ u5: 0.05, u7: 0.5, uoi: 0.99, soi: 'allowed', hasOi: true })
    })
    h.setProbe('plain', { ok: true, usage: usage({ u5: 0.6, u7: 0.8 }) })
    const r = await h.picker.pick()
    expect(r.account).toBe('burned')
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

  it('a fable host must be healthy on 5h/7d too: rejected-inside-grace disqualifies it even though it is not hard-limited', async () => {
    const alpha = usage({ uoi: 0.4, soi: 'allowed', hasOi: true, s5: 'rejected', r5: NOW_S + 1500 })
    const h = makeHarness([meta({ name: 'alpha' }), meta({ name: 'beta' })])
    h.setProbe('alpha', { ok: true, usage: alpha })
    h.setProbe('beta', { ok: true, usage: usage({ u5: 0.01, u7: 0.1 }) })
    const r = await h.picker.pick()
    expect(r.account).toBe('beta')
    if (r.account) expect(r.warning).toBe(FABLE_GONE)

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

  it('a spent fable bucket about to reset is still not a host: eligibility reads raw utilization, the reset discount only ranks', async () => {
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
    expect((await h.picker.pick()).account).toBe('cooled')
  })

  it('a rejected 7d_oi bucket is not a host even below the stop line', async () => {
    const h = makeHarness([meta({ name: 'shut' }), meta({ name: 'plain' })])
    h.setProbe('shut', { ok: true, usage: usage({ uoi: 0.3, soi: 'rejected', hasOi: true }) })
    h.setProbe('plain', { ok: true, usage: usage({ u5: 0.5 }) })
    const r = await h.picker.pick()
    expect(r.account).toBe('shut')
    if (r.account) expect(r.warning).toBe(FABLE_GONE)
  })

  it("fable hosting is decided only by the usage snapshot's hasOi, never by the account's fable badge: a stale badge must never route a launch", async () => {
    const badged = makeHarness([
      meta({ name: 'badged', fable: 'yes' }),
      meta({ name: 'plain', fable: 'no' })
    ])
    badged.setProbe('badged', { ok: true, usage: usage({ u5: 0.4, u7: 0.2 }) })
    badged.setProbe('plain', { ok: true, usage: usage({ u5: 0.1, u7: 0.2 }) })
    expect(await badged.picker.pick()).toEqual({
      account: 'plain',
      kind: 'oauth',
      banner: 'koloft: → plain · 5h 10% · 7d 20%',
      warning: FABLE_GONE
    })

    const unbadged = makeHarness([
      meta({ name: 'host', fable: 'no' }),
      meta({ name: 'plain', fable: 'no' })
    ])
    unbadged.setProbe('host', {
      ok: true,
      usage: usage({ u5: 0.4, u7: 0.2, uoi: 0.2, soi: 'allowed', hasOi: true })
    })
    unbadged.setProbe('plain', { ok: true, usage: usage({ u5: 0.1, u7: 0.2 }) })
    expect(await unbadged.picker.pick()).toEqual({
      account: 'host',
      kind: 'oauth',
      banner: 'koloft: → host · 5h 40% · 7d 20% · fable 20%'
    })
  })

  it('two opus candidates tied on every layer still resolve — never no-usable', async () => {
    const h = makeHarness([meta({ name: 'twin-a' }), meta({ name: 'twin-b' })])
    h.setProbe('twin-a', { ok: true, usage: usage({ u5: 0.3, u7: 0.4 }) })
    h.setProbe('twin-b', { ok: true, usage: usage({ u5: 0.3, u7: 0.4 }) })
    const r = await h.picker.pick()
    expect(r.account).toBe('twin-a')
  })

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
  it('switch off: a fable host no longer wins over an idler with no allowance', async () => {
    const pool = [meta({ name: 'host' }), meta({ name: 'idle' })]
    const usages: [string, UsageSnapshot][] = [
      ['host', usage({ u5: 0.4, u7: 0.5, uoi: 0.4, soi: 'allowed', hasOi: true })],
      ['idle', usage({ u5: 0.01, u7: 0.02 })]
    ]
    const off = makeHarness(pool, { fablePriority: false })
    for (const [n, u] of usages) off.setProbe(n, { ok: true, usage: u })
    const r = await off.picker.pick()
    expect(r).toEqual({
      account: 'idle',
      kind: 'oauth',
      banner: 'koloft: → idle · 5h 1% · 7d 2%',
      warning: FABLE_GONE
    })

    const on = makeHarness(pool)
    for (const [n, u] of usages) on.setProbe(n, { ok: true, usage: u })
    expect((await on.picker.pick()).account).toBe('host')
  })

  it('switch off + the picked account still holds allowance → no billing line (judged on the picked account, not on the pool)', async () => {
    const pool = [meta({ name: 'busy' }), meta({ name: 'spare' })]
    const usages: [string, UsageSnapshot][] = [
      ['busy', usage({ u5: 0.6, u7: 0.1, uoi: 0.1, soi: 'allowed', hasOi: true })],
      ['spare', usage({ u5: 0.05, u7: 0.1, uoi: 0.8, soi: 'allowed', hasOi: true })]
    ]
    const off = makeHarness(pool, { fablePriority: false })
    for (const [n, u] of usages) off.setProbe(n, { ok: true, usage: u })
    expect(await off.picker.pick()).toEqual({
      account: 'spare',
      kind: 'oauth',
      banner: 'koloft: → spare · 5h 5% · 7d 10%'
    })

    const on = makeHarness(pool)
    for (const [n, u] of usages) on.setProbe(n, { ok: true, usage: u })
    expect((await on.picker.pick()).account).toBe('busy')
  })

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
    expect(r.account).toBe('hot-a')
    if (r.account) expect(r.warning).toBeUndefined()
  })
})

describe('U4 · cache short-circuit and single-flight', () => {
  it('a ≤30s-fresh snapshot for every enabled sub skips probing entirely', async () => {
    const h = makeHarness([meta({ name: 'bravo' })])
    h.setProbe('bravo', { ok: true, usage: usage({ u5: 0.1 }) })
    await h.picker.pick()
    expect(h.probeCalls).toEqual(['bravo'])
    await h.picker.pick()
    expect(h.probeCalls).toEqual(['bravo'])
  })

  it('concurrent picks coalesce onto one probe round', async () => {
    const h = makeHarness([meta({ name: 'bravo' })])
    h.setProbe('bravo', { ok: true, usage: usage({ u5: 0.1 }) })
    await Promise.all([h.picker.pick(), h.picker.pick(), h.picker.pick()])
    expect(h.probeCalls).toEqual(['bravo'])
  })

  it('past the fresh window a later pick probes AGAIN (the single-flight latch released), and the new reading steers the pick after it', async () => {
    const h = makeHarness([meta({ name: 'a' }), meta({ name: 'b' })])
    h.setProbe('a', { ok: true, usage: usage({ u5: 0.1 }) })
    h.setProbe('b', { ok: true, usage: usage({ u5: 0.9 }) })
    expect((await h.picker.pick()).account).toBe('a')
    expect(h.probeCalls).toHaveLength(2)

    h.setProbe('a', { ok: true, usage: usage({ u5: 0.95 }) })
    h.setProbe('b', { ok: true, usage: usage({ u5: 0.05 }) })
    h.advance(31_000)
    expect((await h.picker.pick()).account).toBe('a')
    expect(h.probeCalls).toHaveLength(4)
    await vi.waitFor(async () => {
      expect((await h.picker.pick()).account).toBe('b')
    })
  })

  // CC§7
  it('a probe that throws inside a round does not wedge the single-flight latch: once the fresh window has passed, a later pick starts a new round', async () => {
    const h = makeHarness([meta({ name: 'a' })])
    const deps = (h.picker as unknown as { deps: PickDeps }).deps
    const realProbe = deps.probe
    deps.probe = () => {
      throw new Error('socket hang up')
    }
    const failed = await h.picker.pick()
    if (failed.account) expect(failed.banner).toContain('round-robin')

    deps.probe = realProbe
    h.setProbe('a', { ok: true, usage: usage({ u5: 0.1, u7: 0.2 }) })
    h.advance(31_000)
    const r = await h.picker.pick()
    expect(h.probeCalls).toEqual(['a'])
    expect(r).toMatchObject({ account: 'a', banner: 'koloft: → a · 5h 10% · 7d 20%' })
  })

  it('PROBE_TIMEOUT_MS outlasts both the pick budget and the slowest measured claude-fable-5 probe (5.1 s, CC§7), so a round outlives the pick that started it and warms the cache; at 1.8 s every launch fell through to a blind round-robin', () => {
    const slowestMeasuredFableProbeMs = 5_100
    expect(PROBE_TIMEOUT_MS).toBeGreaterThan(PICK_BUDGET_MS)
    expect(PROBE_TIMEOUT_MS).toBeGreaterThan(slowestMeasuredFableProbeMs)
  })

  it('a snapshot older than any window still scores — a stale reading beats round-robin', async () => {
    const h = makeHarness([meta({ name: 'a' }), meta({ name: 'b' })])
    h.setProbe('a', { ok: true, usage: usage({ u5: 0.9 }) })
    h.setProbe('b', { ok: true, usage: usage({ u5: 0.1 }) })
    expect((await h.picker.pick()).account).toBe('b')

    h.advance(3_600_000)
    h.setProbe('a', { ok: false, error: 'network' })
    h.setProbe('b', { ok: false, error: 'network' })
    const r = await h.picker.pick()
    expect(r.account).toBe('b')
    if (r.account) expect(r.banner).not.toContain('round-robin')
  })

  it('a pick holding any snapshot answers WITHOUT awaiting the round it starts', async () => {
    const h = makeHarness([meta({ name: 'a' }), meta({ name: 'b' })])
    h.setProbe('a', { ok: true, usage: usage({ u5: 0.1 }) })
    h.setProbe('b', { ok: true, usage: usage({ u5: 0.9 }) })
    await h.picker.pick()
    h.advance(31_000)
    const deps = (h.picker as unknown as { deps: PickDeps }).deps
    deps.probe = () => new Promise<ProbeResult>(() => {})
    const t0 = Date.now()
    const r = await h.picker.pick()
    expect(Date.now() - t0).toBeLessThan(PICK_BUDGET_MS)
    expect(r.account).toBe('a')
  })

  it('the fable-host gate reads the newest snapshot whatever its age', async () => {
    const h = makeHarness([meta({ name: 'a' })])
    h.setProbe('a', {
      ok: true,
      usage: usage({ u5: 0.1, uoi: 0.2, soi: 'allowed', hasOi: true })
    })
    const fresh = await h.picker.pick()
    if (fresh.account) expect(fresh.warning).toBeUndefined()

    h.advance(3_600_000)
    h.setProbe('a', { ok: false, error: 'network' })
    const r = await h.picker.pick()
    expect(r.account).toBe('a')
    if (r.account) {
      expect(r.banner).toContain('fable 20%')
      expect(r.warning).toBeUndefined()
    }
  })

  it('the banner discloses the reading age once it is stale, and not before', async () => {
    const h = makeHarness([meta({ name: 'bravo' })])
    h.setProbe('bravo', { ok: true, usage: usage({ u5: 0.1, u7: 0.2 }) })
    const fresh = await h.picker.pick()
    if (fresh.account) expect(fresh.banner).toBe('koloft: → bravo · 5h 10% · 7d 20%')

    h.advance(14 * 60_000)
    h.setProbe('bravo', { ok: false, error: 'network' })
    const mid = await h.picker.pick()
    if (mid.account) expect(mid.banner).toBe('koloft: → bravo · 5h 10% · 7d 20%')

    h.advance(8 * 60_000)
    const old = await h.picker.pick()
    if (old.account) expect(old.banner).toBe('koloft: → bravo · 5h 10% · 7d 20% · 22 min ago')
  })

  it('forget() drops a snapshot so a re-added name is never scored on the old account', async () => {
    const h = makeHarness([meta({ name: 'a' }), meta({ name: 'b' })])
    h.setProbe('a', { ok: true, usage: usage({ u5: 0.9 }) })
    h.setProbe('b', { ok: true, usage: usage({ u5: 0.1 }) })
    expect((await h.picker.pick()).account).toBe('b')

    h.picker.forget('oauth', 'b')
    h.advance(31_000)
    h.setProbe('b', { ok: false, error: 'network' })
    expect((await h.picker.pick()).account).toBe('a')
  })

  it('cacheUsage (settings-panel refresh) feeds the SAME cache selection scores from', async () => {
    const h = makeHarness([meta({ name: 'a' }), meta({ name: 'b' })])
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
    expect(r).toMatchObject({ account: 's2', kind: 'oauth' })
  })

  it('MIXED case: one probe failed + rest rejected → NO metered fallback (flaps must not spend)', async () => {
    const h = makeHarness([...subs, api])
    h.setProbe('s1', { ok: true, usage: walled() })
    h.setProbe('s2', { ok: false, error: 'network' })
    const r = await h.picker.pick()
    expect(r).toMatchObject({ kind: 'oauth' })
    expect(r.account).toBe('s1')
  })

  it('all hard-limited, NO api key → plain leximax, banner names the reset', async () => {
    const h = makeHarness(subs)
    h.setProbe('s1', { ok: true, usage: walled({ r5: NOW_S + 7200 }) })
    h.setProbe('s2', { ok: true, usage: walled({ r5: NOW_S + 3600 }) })
    const r = await h.picker.pick()
    expect(r.account).toBe('s2')
    if (r.account) expect(r.banner).toContain('every account rate-limited')
  })

  it('an old wall reading never spends: the metered switch keeps its freshness bound', async () => {
    const h = makeHarness([...subs, api])
    h.setProbe('s1', { ok: true, usage: walled() })
    h.setProbe('s2', { ok: true, usage: walled() })
    expect((await h.picker.pick()).account).toBe('api-main')

    h.advance(3 * 60_000)
    h.setProbe('s1', { ok: false, error: 'network' })
    h.setProbe('s2', { ok: false, error: 'network' })
    const r = await h.picker.pick()
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
    const r1 = await h.picker.pick()
    const r2 = await h.picker.pick()
    expect(r1.account).not.toBeNull()
    expect(r2.account).not.toBeNull()
    expect(r1.account).not.toBe(r2.account)
    if (r1.account) expect(r1.banner).toContain('round-robin')
  })

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
    expect((await h.picker.pick()).account).toBe('b')

    h.advance(48 * 3_600_000)
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
    const never = new Promise<ProbeResult>(() => {})
    const deps = (h.picker as unknown as { deps: PickDeps }).deps
    deps.probe = () => never
    const t0 = Date.now()
    const r = await h.picker.pick()
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(4000)
    expect(r.account).toBe('slow')
    if (r.account) expect(r.banner).toContain('round-robin')
  }, 10_000)
})
