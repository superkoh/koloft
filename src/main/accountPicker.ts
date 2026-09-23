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

export const FRESH_CACHE_MS = 30_000
export const PICK_BUDGET_MS = 2_000
// CC§7
export const PROBE_TIMEOUT_MS = 10_000
export const METERED_MAX_AGE_MS = 120_000
export const HOST_5H_STOP = 0.85
export const FABLE_EXHAUSTED_LINE =
  'koloft: this account has no fable allowance left -- running fable now will be billed to usage credits'

export interface PickDeps {
  listAccounts(): AccountMeta[]
  multiAccountOn(): boolean
  fablePriority(): boolean
  readSecret(kind: AccountKind, name: string): Promise<string | null>
  probe(a: AccountMeta, secret: string): Promise<ProbeResult>
  onProbeOutcome(name: string, kind: AccountKind, result: ProbeResult): void
  now(): number
}

export type PickResponse =
  | {
      account: string
      kind: AccountKind
      banner: string
      warning?: string
    }
  | { account: null; reason: 'disabled' | 'no-accounts' | 'no-usable' }

function pct(v: number): string {
  return `${Math.round(v * 100)}%`
}

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

  private eligible(...kinds: AccountKind[]): AccountMeta[] {
    return this.deps
      .listAccounts()
      .filter((a) => kinds.includes(a.kind) && a.enabled && a.status === 'ok')
  }

  private probeRound(accounts: AccountMeta[]): Promise<void> {
    if (this.inFlight) return this.inFlight
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

  cacheUsage(kind: AccountKind, name: string, usage: UsageSnapshot): void {
    this.cache.set(`${kind}:${name.toLowerCase()}`, usage)
  }

  forget(kind: AccountKind, name: string): void {
    this.cache.delete(`${kind}:${name.toLowerCase()}`)
  }

  private snapshotFor(a: AccountMeta, maxAgeMs?: number): UsageSnapshot | undefined {
    const snap = this.cache.get(this.key(a))
    if (!snap) return undefined
    if (maxAgeMs === undefined) return snap
    return this.deps.now() - snap.at <= maxAgeMs ? snap : undefined
  }

  private roundRobin(accounts: AccountMeta[]): AccountMeta {
    const a = accounts[this.rrCursor % accounts.length]
    this.rrCursor = (this.rrCursor + 1) % Math.max(1, accounts.length)
    return a
  }

  async pick(): Promise<PickResponse> {
    if (!this.deps.multiAccountOn()) return { account: null, reason: 'disabled' }
    const subs = this.eligible('oauth')
    const apis = this.eligible('apikey', 'custom')
    if (subs.length === 0 && apis.length === 0) return { account: null, reason: 'no-accounts' }

    if (subs.length === 0) {
      const a = this.roundRobin(apis)
      return { account: a.name, kind: a.kind, banner: fallbackBanner(a) }
    }

    const allFresh = subs.every((a) => this.snapshotFor(a, FRESH_CACHE_MS))
    if (!allFresh) {
      const round = this.probeRound(subs)
      const nothingCached = subs.every((a) => !this.snapshotFor(a))
      if (nothingCached) {
        const budget = new Promise<void>((resolve) => setTimeout(resolve, PICK_BUDGET_MS))
        await Promise.race([round, budget])
      }
    }

    const nowSec = Math.floor(this.deps.now() / 1000)
    const withSnap: { meta: AccountMeta; snap: UsageSnapshot }[] = []
    for (const a of subs) {
      const snap = this.snapshotFor(a)
      if (snap) withSnap.push({ meta: a, snap })
    }

    if (withSnap.length === 0) {
      const a = this.roundRobin(subs)
      return {
        account: a.name,
        kind: 'oauth',
        banner: `koloft: probe failed, round-robin → ${a.name}`
      }
    }

    const fableHosts = !this.deps.fablePriority()
      ? []
      : subs.filter((a) => {
          const s = this.snapshotFor(a)
          if (!s || !fableFree(s, nowSec)) return false
          const sc = scoreSnapshot(s, nowSec, 'fable')
          if (sc.hardLimited || sc.pen !== 0) return false
          return resetElapsed(s.r5, nowSec) || s.u5 < HOST_5H_STOP
        })
    const route: ScoreRoute = fableHosts.length > 0 ? 'fable' : 'opus'

    const scored = withSnap.map(({ meta, snap }) => ({
      meta,
      snap,
      score: scoreSnapshot(snap, nowSec, route)
    }))

    const fullyProbed = withSnap.length === subs.length
    const allHard = scored.every((s) => s.score.hardLimited)
    const wallIsCurrent = withSnap.every(({ meta }) => this.snapshotFor(meta, METERED_MAX_AGE_MS))
    if (fullyProbed && allHard && wallIsCurrent && apis.length > 0) {
      const a = this.roundRobin(apis)
      return {
        account: a.name,
        kind: a.kind,
        banner: `koloft: every subscription rate-limited → ${fallbackTag(a)}`
      }
    }

    const pool = route === 'fable' ? scored.filter((s) => fableHosts.includes(s.meta)) : scored
    const cands: Candidate[] = pool.map((s) => ({ name: s.meta.name, score: s.score }))
    const finalists = leximaxFinalists(cands)
    const winner =
      finalists.length > 1
        ? this.roundRobin(finalists.map((c) => pool.find((s) => s.meta.name === c.name)!.meta)).name
        : finalists[0].name
    const win = scored.find((s) => s.meta.name === winner)!
    if (fullyProbed && allHard) {
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
