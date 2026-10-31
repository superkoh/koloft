import type {
  AccountKind,
  AccountMeta,
  AccountView,
  BackendId,
  SessionInfo,
  UsageSnapshot
} from '@shared/types'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import {
  accountLine,
  fableExhausted,
  fiveHourStopped,
  homeRoom,
  keepsResumedSession,
  resetElapsed,
  usableAccounts
} from '@shared/accountUsage'
import {
  EPS,
  leximaxFinalists,
  scoreSnapshot,
  type Candidate,
  type ProbeResult,
  type Score,
  type ScoreRoute
} from './usageProbe'

export const SCORE_PER_LIVE_SESSION = 2 * EPS

export type LaunchedSession = Pick<SessionInfo, 'tabId' | 'account' | 'status'>

export function liveSessionsPerAccount(
  sessions: LaunchedSession[],
  exceptTab: string | undefined
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const s of sessions) {
    if (!s.account || s.tabId === exceptTab || s.status === 'idle') continue
    const key = s.account.toLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

export const FRESH_CACHE_MS = 30_000
export const PICK_BUDGET_MS = 2_000
// CC§7
export const PROBE_TIMEOUT_MS = 10_000
export const METERED_MAX_AGE_MS = 120_000
export const FABLE_EXHAUSTED_LINE =
  'koloft: this account has no fable allowance left -- running fable now will be billed to usage credits'

export interface PickDeps {
  listAccounts(): AccountMeta[]
  fablePriority(): boolean
  readSecret(kind: AccountKind, name: string): Promise<string | null>
  probe(a: AccountMeta, secret: string): Promise<ProbeResult>
  onProbeOutcome(name: string, kind: AccountKind, result: ProbeResult): void
  launchedSessions(): LaunchedSession[]
  recordPick(tabId: string, account: string): void
  now(): number
}

export type PickResponse =
  | {
      account: string
      kind: AccountKind
      banner: string
      warning?: string
    }
  | { account: null; reason: 'no-accounts' | 'no-usable' }

function bannerFor(
  name: string,
  u: UsageSnapshot | undefined,
  hasOi: boolean,
  nowMs: number
): string {
  if (!u) return accountLine(name, [])
  const parts = [
    ...(u.has5h ? [{ label: '5h', used: u.u5 }] : []),
    { label: '7d', used: u.u7 },
    ...(hasOi ? [{ label: 'fable', used: u.uoi }] : [])
  ]
  return accountLine(name, parts, { at: u.at, nowMs })
}

export function allLimitedNotice(a: AccountView, backend: BackendId): string | undefined {
  const room = homeRoom(a, Math.floor(Date.now() / 1000))
  if (!room?.walled) return undefined
  const agent = BACKEND_LABEL[backend]
  return `Every ${agent} account is at its limit, so ${agent} runs on ${a.name}, the first to reset (${fmtReset(room.backAt)}).`
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

function fiveHourBackAt(u: UsageSnapshot): number {
  return u.r5 > 0 ? u.r5 : Infinity
}

function wallBackAt(u: UsageSnapshot): number {
  const backs: number[] = []
  if (u.s5 === 'rejected' && u.r5 > 0) backs.push(u.r5)
  if (u.s7 === 'rejected' && u.r7 > 0) backs.push(u.r7)
  return backs.length > 0 ? Math.max(...backs) : Infinity
}

function soonest<T extends { snap: UsageSnapshot }>(
  list: T[],
  backAt: (u: UsageSnapshot) => number
): T {
  return list.reduce((a, b) => (backAt(b.snap) < backAt(a.snap) ? b : a))
}

function withLoad(score: Score, liveSessions: number): Score {
  return { ...score, s1: score.s1 + liveSessions * SCORE_PER_LIVE_SESSION }
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
    return usableAccounts(this.deps.listAccounts(), kinds)
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

  async pick(tabId?: string, resumedOn?: string): Promise<PickResponse> {
    const subs = this.eligible('oauth')
    const apis = this.eligible('apikey', 'custom')
    if (subs.length === 0 && apis.length === 0) return { account: null, reason: 'no-accounts' }

    if (subs.length > 0 && !subs.every((a) => this.snapshotFor(a, FRESH_CACHE_MS))) {
      const round = this.probeRound(subs)
      const nothingCached = subs.every((a) => !this.snapshotFor(a))
      if (nothingCached) {
        const budget = new Promise<void>((resolve) => setTimeout(resolve, PICK_BUDGET_MS))
        await Promise.race([round, budget])
      }
    }

    const res = this.keepResumed(subs, resumedOn) ?? this.decide(subs, apis, tabId)
    if (tabId && res.account) this.deps.recordPick(tabId, res.account)
    return res
  }

  private keepResumed(subs: AccountMeta[], resumedOn?: string): PickResponse | undefined {
    const name = resumedOn?.toLowerCase()
    const same = name ? subs.find((a) => a.name.toLowerCase() === name) : undefined
    if (!same) return undefined
    const snap = this.snapshotFor(same)
    const nowSec = Math.floor(this.deps.now() / 1000)
    if (snap && !keepsResumedSession(snap, nowSec)) return undefined
    return this.subscriptionPick(same.name, snap, false, nowSec)
  }

  private subscriptionPick(
    name: string,
    snap: UsageSnapshot | undefined,
    fableRoute: boolean,
    nowSec: number
  ): PickResponse {
    return {
      account: name,
      kind: 'oauth',
      banner: bannerFor(name, snap, fableRoute, this.deps.now()),
      ...(!snap || fableFree(snap, nowSec) ? {} : { warning: FABLE_EXHAUSTED_LINE })
    }
  }

  private decide(subs: AccountMeta[], apis: AccountMeta[], tabId?: string): PickResponse {
    if (subs.length === 0) {
      const a = this.roundRobin(apis)
      return { account: a.name, kind: a.kind, banner: fallbackBanner(a) }
    }

    const nowSec = Math.floor(this.deps.now() / 1000)
    const load = liveSessionsPerAccount(this.deps.launchedSessions(), tabId)
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
          return !sc.hardLimited && sc.pen === 0 && !fiveHourStopped(s, nowSec)
        })
    const route: ScoreRoute = fableHosts.length > 0 ? 'fable' : 'opus'

    const scored = withSnap.map(({ meta, snap }) => ({
      meta,
      snap,
      score: withLoad(scoreSnapshot(snap, nowSec, route), load.get(meta.name.toLowerCase()) ?? 0)
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

    const routed = route === 'fable' ? scored.filter((s) => fableHosts.includes(s.meta)) : scored
    const runnable = routed.filter((s) => !s.score.hardLimited)
    const open = runnable.filter((s) => !fiveHourStopped(s.snap, nowSec))
    const pool =
      open.length > 0
        ? open
        : runnable.length > 0
          ? [soonest(runnable, fiveHourBackAt)]
          : [soonest(routed, wallBackAt)]
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
    return this.subscriptionPick(win.meta.name, win.snap, route === 'fable', nowSec)
  }
}
