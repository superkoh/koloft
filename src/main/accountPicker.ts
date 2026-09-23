import type { AccountKind, AccountMeta, UsageSnapshot } from '@shared/types'
import { fableExhausted, STALE_MS } from '@shared/accountUsage'
import { ageLabel } from '@shared/freshnessOps'
import {
  leximaxFinalists,
  scoreSnapshot,
  type Candidate,
  type ProbeResult,
  type ScoreRoute
} from './usageProbe'

/**
 * Pick orchestration (answer deadline + two-tier pool). All timing/degradation lives HERE, in
 * main — the shim's 3s poll is only the "main is dead" last resort:
 *
 *   fresh(≤30s) cache for every enabled sub → skip probing entirely
 *   else start a single-flight probe round; a pick that already holds ANY snapshot
 *     answers from cache at once and lets the round land for the next launch, a pick
 *     with nothing cached awaits it ≤ budget (2s)
 *   per account: its newest snapshot, whatever its age — only a never-probed account
 *     is out of the ranking
 *   candidates → leximax, then earliest weekly reset (resets within 6h of each other
 *     tie → round-robin over those finalists); ALL hard-limited AND
 *     fully-probed AND recently read → API-key tier
 *   no candidates at all → round-robin (persistent in-run cursor)
 *
 * Deps are injected so the unit suite drives it without wall clocks or sockets.
 */

/** probe-dedupe window: a reading younger than this needs no round at all. NOT a
 *  scoring bound — snapshots never expire (see snapshotFor). */
export const FRESH_CACHE_MS = 30_000
export const PICK_BUDGET_MS = 2_000
/** Must EXCEED the pick budget: the round outlives the pick that started it and warms
 *  the cache for the next launch. At 1.8s it never could — a
 *  claude-fable-5 probe takes 4.0–5.1s (n=8), so every routine probe was aborted
 *  before it could answer and every launch fell through to a blind round-robin.
 *  Per REQUEST, not per account: an oauth probe re-posts on the fallback model after a
 *  headerless 4xx (usageProbe.ts), so one account can hold the round for 2× this. */
export const PROBE_TIMEOUT_MS = 10_000
/** Snapshots never expire for RANKING (see snapshotFor) — but the metered switch is
 *  the one branch that spends the user's money, and it keeps the bound the rest of the
 *  pick gave up: an hour-old "everything is walled" reading must not reach for a
 *  billed API key. Falling back to a walled subscription is recoverable; a bill is not. */
export const METERED_MAX_AGE_MS = 120_000
/** a fable host must also be healthy on its 5h bucket — hosting means real work lands
 *  there, and an account this close to the ceiling walls mid-session (D19) */
export const HOST_5H_STOP = 0.85
/** printed whenever the PICKED account has no included fable allowance left, so running
 *  fable NOW spends money. Never deduped — the one line that costs the user.
 *  D21: judged per account, not per pool. With fablePriority off (D20) a pool can
 *  still hold allowance while this launch's account does not — and a line that says
 *  "billed" when it is not teaches the user to skip the one warning that matters. */
export const FABLE_EXHAUSTED_LINE =
  'koloft: this account has no fable allowance left -- running fable now will be billed to usage credits'

export interface PickDeps {
  listAccounts(): AccountMeta[]
  multiAccountOn(): boolean
  /** D20 — user setting: false ranks on 5h/7d only and makes every account eligible */
  fablePriority(): boolean
  /** resolve the account's secret (Keychain); null = missing entry */
  readSecret(kind: AccountKind, name: string): Promise<string | null>
  /** receives the full meta so the caller can pick the probe model per account (§08: a known no-fable account's routine probe skips the fable model) */
  probe(a: AccountMeta, secret: string): Promise<ProbeResult>
  /** probe side-effects: status transitions (401 double-confirm) + fable badge */
  onProbeOutcome(name: string, kind: AccountKind, result: ProbeResult): void
  now(): number
}

export type PickResponse =
  | {
      account: string
      kind: AccountKind
      banner: string
      /** second stderr line, its OWN field rather than a newline inside `banner`: the
       *  shim lifts each value out of the res file with a plain sed capture and prints
       *  it with `printf '%s'`, so a JSON-escaped newline would arrive as the two
       *  literal characters backslash + n and print that way. Under D18 this line is
       *  the only thing standing between the user and a metered fable session — it
       *  must not depend on escape expansion surviving a sed round-trip. */
      warning?: string
    }
  | { account: null; reason: 'disabled' | 'no-accounts' | 'no-usable' }

function pct(v: number): string {
  return `${Math.round(v * 100)}%`
}

/** Snapshots never expire, so the numbers below can be hours old — past the age the
 *  capsule stops trusting them at (STALE_MS, where it fades the bar), say so instead
 *  of printing a reading the user takes for live. Same threshold and same words as
 *  every other surface: the wording is @shared/freshnessOps' ageLabel. */
function bannerFor(
  name: string,
  u: UsageSnapshot | undefined,
  hasOi: boolean,
  nowMs: number
): string {
  if (!u) return `koloft: → ${name}`
  let s = `koloft: → ${name} · 5h ${pct(u.u5)} · 7d ${pct(u.u7)}`
  if (hasOi) s += ` · fable ${pct(u.uoi)}`
  if (nowMs - u.at > STALE_MS) s += ` · ${ageLabel(u.at, nowMs)}`
  return s
}

/** Fallback-tier accounts must SAY what they cost / what they change: an API key
 *  bills per token, a custom endpoint also answers with a different model entirely. */
function fallbackTag(a: AccountMeta): string {
  return a.kind === 'custom'
    ? `${a.name} (custom endpoint${a.model ? ` · ${a.model}` : ''})`
    : `${a.name} (API key, metered)`
}

function fallbackBanner(a: AccountMeta): string {
  return `koloft: → ${fallbackTag(a)}`
}

function fmtReset(epoch: number): string {
  if (epoch <= 0) return '?'
  const d = new Date(epoch * 1000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** Is this account's INCLUDED fable allowance real and unspent — i.e. would a fable
 *  turn here be free? Deliberately without D19's health gate: a hot 5h bucket makes an
 *  account a poor host, not a billed one, and this predicate answers the money question
 *  (D21) as well as the first half of the host question.
 *  RAW utilization, no reset discount: disc() is a ranking device ("this quota voids
 *  soon, spend here"), but eligibility asks what is left RIGHT NOW. Discounted, an
 *  account at fable 99% with its week resetting in 50 minutes read as 15% — it was
 *  admitted as a host, won the pick as the idler, and the new session's first hour
 *  landed on an allowance with nothing in it (overage out_of_credits).
 *  The one thing kept from disc(): a reset that has already PASSED means the reading
 *  is void and the bucket is full again. Snapshots never expire and a pick answers from
 *  cache, so the first launch after a weekly reset scores the pre-reset reading. */
function fableFree(u: UsageSnapshot, nowSec: number): boolean {
  if (!u.hasOi) return false
  if (resetElapsed(u.roi, nowSec)) return true
  return !fableExhausted(u)
}

function resetElapsed(r: number, nowSec: number): boolean {
  return r > 0 && r <= nowSec
}

export class AccountPicker {
  private cache = new Map<string, UsageSnapshot>()
  private inFlight: Promise<void> | null = null
  private rrCursor = 0

  constructor(private deps: PickDeps) {}

  private key(a: AccountMeta): string {
    return `${a.kind}:${a.name.toLowerCase()}`
  }

  /** eligible = user-enabled and not known-dead/unverified */
  private eligible(...kinds: AccountKind[]): AccountMeta[] {
    return this.deps
      .listAccounts()
      .filter((a) => kinds.includes(a.kind) && a.enabled && a.status === 'ok')
  }

  /** one probe round over the given accounts, single-flighted: concurrent picks
   *  coalesce onto the same in-flight round instead of multiplying real requests */
  private probeRound(accounts: AccountMeta[]): Promise<void> {
    if (this.inFlight) return this.inFlight
    // `.catch` so one throwing probe cannot wedge the latch, and so the promise
    // STORED in inFlight is the same object the cleanup compares against — assigning
    // `round.finally(...)` here would store a different promise, the identity check
    // would never match, and the latch would stay set forever (freezing every later
    // probe round, i.e. usage snapshots that never refresh again).
    const round = (async (): Promise<void> => {
      await Promise.all(
        accounts.map(async (a) => {
          const secret = await this.deps.readSecret(a.kind, a.name)
          if (!secret) return
          const result = await this.deps.probe(a, secret)
          this.deps.onProbeOutcome(a.name, a.kind, result)
          if (result.ok && result.usage) this.cache.set(this.key(a), result.usage)
        })
      )
    })().catch(() => {})
    this.inFlight = round
    void round.then(() => {
      if (this.inFlight === round) this.inFlight = null
    })
    return round
  }

  /** Feed a snapshot obtained OUTSIDE a pick (the settings panel's refresh) into the
   *  same cache the scorer reads. Without this the panel and the picker keep
   *  independent copies: the user sees fresh bars while selection keeps scoring on an
   *  older set. */
  cacheUsage(kind: AccountKind, name: string, usage: UsageSnapshot): void {
    this.cache.set(`${kind}:${name.toLowerCase()}`, usage)
  }

  /** Drop a removed account's reading. Snapshots never expire, so without this a name
   *  re-added later (a different token, a different plan) would be scored — fable
   *  verdict included — on the deleted account's usage for the life of the app. */
  forget(kind: AccountKind, name: string): void {
    this.cache.delete(`${kind}:${name.toLowerCase()}`)
  }

  /** the newest reading for this account. `maxAgeMs` bounds the PROBE-dedupe question
   *  ("is a round needed?") only — scoring passes no bound: a probe costs 4–5s, far
   *  past any launch deadline, so the alternative to an old reading is not a fresh one
   *  but a blind round-robin. */
  private snapshotFor(a: AccountMeta, maxAgeMs?: number): UsageSnapshot | undefined {
    const snap = this.cache.get(this.key(a))
    if (!snap) return undefined
    if (maxAgeMs === undefined) return snap
    return this.deps.now() - snap.at <= maxAgeMs ? snap : undefined
  }

  /** round-robin over accounts with a cursor that advances across calls */
  private roundRobin(accounts: AccountMeta[]): AccountMeta {
    const a = accounts[this.rrCursor % accounts.length]
    this.rrCursor = (this.rrCursor + 1) % Math.max(1, accounts.length)
    return a
  }

  async pick(): Promise<PickResponse> {
    if (!this.deps.multiAccountOn()) return { account: null, reason: 'disabled' }
    const subs = this.eligible('oauth')
    // API keys and custom endpoints share the fallback tier: neither exposes a quota
    // to score, so both are "only when the measurable pool is walled" (D11)
    const apis = this.eligible('apikey', 'custom')
    if (subs.length === 0 && apis.length === 0) return { account: null, reason: 'no-accounts' }

    // subscription-free pool: the fallback tier IS the pool — nothing to block it
    if (subs.length === 0) {
      const a = this.roundRobin(apis)
      return { account: a.name, kind: a.kind, banner: fallbackBanner(a) }
    }

    // fresh-cache short-circuit: opening five tabs at once must not fire 5×N probes
    const allFresh = subs.every((a) => this.snapshotFor(a, FRESH_CACHE_MS))
    if (!allFresh) {
      // start the round every launch, but WAIT on it only when there is nothing to
      // answer from: a probe outlives any deadline a launch can hold (4–5s), so a
      // waited round is a guaranteed round-robin. Cached pick now, refreshed cache
      // for the next launch — the round's own 10s timeout is what lets it land.
      const round = this.probeRound(subs)
      const nothingCached = subs.every((a) => !this.snapshotFor(a))
      if (nothingCached) {
        const budget = new Promise<void>((resolve) => setTimeout(resolve, PICK_BUDGET_MS))
        await Promise.race([round, budget])
      }
    }

    // scoring runs in epoch SECONDS (reset headers are seconds); cache ages in ms
    const nowSec = Math.floor(this.deps.now() / 1000)
    const withSnap: { meta: AccountMeta; snap: UsageSnapshot }[] = []
    for (const a of subs) {
      const snap = this.snapshotFor(a)
      if (snap) withSnap.push({ meta: a, snap })
    }

    if (withSnap.length === 0) {
      // every enabled sub failed/timed out — never block the launch, round-robin
      const a = this.roundRobin(subs)
      return {
        account: a.name,
        kind: 'oauth',
        banner: `koloft: probe failed, round-robin → ${a.name}`
      }
    }

    // which quota this launch will spend is decided BEFORE ranking: an account can only
    // host fable if its own included allowance is real, unspent and healthy (D17/D19).
    // Judged on the same reading everything else is judged on, age and all: a 30s gate
    // here would go unsatisfiable the moment scoring stopped waiting for the network,
    // and an ALWAYS-printed "this will be billed" line is a line nobody reads.
    // D20: with the switch off there are no hosts by definition — fable stops being a
    // dimension, which drops the route to 'opus' and hands every account the pool back.
    const fableHosts = !this.deps.fablePriority()
      ? []
      : subs.filter((a) => {
          const s = this.snapshotFor(a)
          if (!s || !fableFree(s, nowSec)) return false
          const sc = scoreSnapshot(s, nowSec, 'fable')
          if (sc.hardLimited || sc.pen !== 0) return false
          // raw, like fableFree: the gate asks whether the bucket is hot NOW — and a
          // 5h bucket whose reset has passed is empty again, whatever the old reading
          return resetElapsed(s.r5, nowSec) || s.u5 < HOST_5H_STOP
        })
    const route: ScoreRoute = fableHosts.length > 0 ? 'fable' : 'opus'

    const scored = withSnap.map(({ meta, snap }) => ({
      meta,
      snap,
      score: scoreSnapshot(snap, nowSec, route)
    }))

    // metered fallback: EVERY enabled sub has a usable verdict AND all are hard-limited
    // (an account with no verdict blocks the switch — a Wi-Fi blink must not spend money)
    const fullyProbed = withSnap.length === subs.length
    const allHard = scored.every((s) => s.score.hardLimited)
    // …and every verdict is RECENT. Ranking runs on snapshots of any age, but "has a
    // verdict" would otherwise be true forever, and this is the branch that bills.
    const wallIsCurrent = withSnap.every(({ meta }) => this.snapshotFor(meta, METERED_MAX_AGE_MS))
    if (fullyProbed && allHard && wallIsCurrent && apis.length > 0) {
      const a = this.roundRobin(apis)
      return {
        account: a.name,
        kind: a.kind,
        banner: `koloft: every subscription rate-limited → ${fallbackTag(a)}`
      }
    }

    // on the fable route only the hosts are eligible; on the opus route everyone is
    const pool = route === 'fable' ? scored.filter((s) => fableHosts.includes(s.meta)) : scored
    const cands: Candidate[] = pool.map((s) => ({ name: s.meta.name, score: s.score }))
    // One finalist = a clear pick (an idler, or the near-equal whose weekly quota voids
    // soonest), take it. Several = near-equals on every layer AND resetting together —
    // this also covers the flat-zero pool: disc() reads an elapsed reset as "this
    // window's data is void", so snapshots that outlived their resets score 0/0/0.
    // Crowning one of those by list order handed EVERY launch to the same account;
    // spread over the finalists with the persistent cursor so back-to-back sessions rotate.
    const finalists = leximaxFinalists(cands)
    const winner =
      finalists.length > 1
        ? this.roundRobin(finalists.map((c) => pool.find((s) => s.meta.name === c.name)!.meta)).name
        : finalists[0].name
    const win = scored.find((s) => s.meta.name === winner)!
    if (fullyProbed && allHard) {
      // all walled, no API key: plain leximax already prefers the lightest penalty
      // (pen ∝ time-to-reset), i.e. the earliest unblock — no special branch
      const r = win.snap.s5 === 'rejected' ? win.snap.r5 : win.snap.r7
      return {
        account: win.meta.name,
        kind: 'oauth',
        banner: `koloft: every account rate-limited → ${win.meta.name} (${fmtReset(r)})`
      }
    }
    const banner = bannerFor(win.meta.name, win.snap, route === 'fable', this.deps.now())
    return {
      account: win.meta.name,
      kind: 'oauth',
      banner,
      ...(fableFree(win.snap, nowSec) ? {} : { warning: FABLE_EXHAUSTED_LINE })
    }
  }
}
