import type { AccountView, UsageSnapshot } from './types'

/**
 * Pure view logic for the titlebar usage capsule (the unit suite is its contract).
 * Everything here is a pure function of (views, now) — `now` is always a parameter —
 * so the unit suite pins each rule with hand-derived values.
 */

/** snapshot age beyond which the capsule fades a bar ("faded = don't trust this") */
export const STALE_MS = 15 * 60_000
/** non-walled fill ceiling: the top rail is reserved for walled/defunct bars */
export const CAP = 0.92
/** rejected-with-reset-≥GRACE = the wall is worth reacting to (mirrors the picker) */
export const GRACE = 1_800
/** fable utilization at or past which the included allowance is treated as closed —
 *  the last percent buys nothing but a mid-turn rejection (shared with the picker). */
export const FABLE_STOP = 0.97

/** Rejected on 5h or 7d with reset ≥ GRACE away — the picker's hard-limit rule.
 *  A full fable bucket is deliberately NOT a hard limit (see usageProbe.ts). */
export function hardLimited(u: UsageSnapshot, nowSec: number): boolean {
  return (
    (u.s5 === 'rejected' && u.r5 - nowSec >= GRACE) ||
    (u.s7 === 'rejected' && u.r7 - nowSec >= GRACE)
  )
}

export type WindowTone = 'ok' | 'soon' | 'due' | 'hard'

/**
 * One window's wall, in the four flavours §2.1 separates (D15): only 'hard'
 * means "this account cannot be scheduled" — 'soon' heals inside GRACE and 'due'
 * is a reset the snapshot simply hasn't caught up with (D7 polls nothing).
 * A missing reset header ('hard' at r === 0) promises no return, so it counts.
 */
export function windowTone(s: string, r: number, nowSec: number): WindowTone {
  if (s !== 'rejected') return 'ok'
  if (r === 0) return 'hard'
  if (r <= nowSec) return 'due'
  return r - nowSec < GRACE ? 'soon' : 'hard'
}

/** Hard-walled on 5h or 7d — the badge, the walled count and `usable` all read this. */
export function accountWalled(u: UsageSnapshot, nowSec: number): boolean {
  return windowTone(u.s5, u.r5, nowSec) === 'hard' || windowTone(u.s7, u.r7, nowSec) === 'hard'
}

/** The included allowance is closed: rejected outright, or so close to it that the
 *  last percent buys nothing but a mid-turn rejection. */
export function fableExhausted(u: UsageSnapshot): boolean {
  return u.soi === 'rejected' || u.uoi >= FABLE_STOP
}

export type MeterLevel = '' | 'warn' | 'bad'

/** The Settings meter's 70/90 color thresholds — single source for both UIs. */
export function meterLevel(v: number): MeterLevel {
  return v >= 0.9 ? 'bad' : v >= 0.7 ? 'warn' : ''
}

export type CapsuleGlyph =
  | { kind: 'grey' }
  | { kind: 'empty' }
  | { kind: 'walled'; stale: boolean }
  | {
      kind: 'bar'
      frac: number
      level: MeterLevel
      stale: boolean
      /** null = no fable layer. `spent` renders full-height (the allowance is closed);
       *  otherwise the layer draws at `frac`, already capped by the same top rail. */
      fable: null | { frac: number; spent: boolean }
    }

/** One enabled OAuth account → its bar. */
export function capsuleGlyph(a: AccountView, nowMs: number): CapsuleGlyph {
  if (a.status !== 'ok') return { kind: 'grey' }
  const u = a.usage
  if (!u) return { kind: 'empty' }
  const stale = nowMs - u.at > STALE_MS
  // only a HARD 5h/7d wall closes the bar (D15 tri-state, popover badge parity) —
  // a wall clearing inside GRACE or already past draws min(u,1) like any tight bar,
  // and a full fable bucket still runs non-fable models
  if (accountWalled(u, Math.floor(nowMs / 1000))) return { kind: 'walled', stale }
  // the fable bucket rides its own layer: it neither raises the bar nor colors it,
  // or an account with nothing left but fable would read as nearly exhausted
  const binding = Math.max(u.u5, u.u7)
  const fable = !u.hasOi
    ? null
    : fableExhausted(u)
      ? { frac: CAP, spent: true }
      : { frac: Math.min(u.uoi, CAP), spent: false }
  return {
    kind: 'bar',
    frac: Math.min(binding, CAP),
    level: meterLevel(binding),
    stale,
    fable
  }
}

/** All subscriptions hard-limited (or none usable) while a metered account stands by. */
export function meteredArmed(views: AccountView[], nowSec: number): boolean {
  const hasMetered = views.some((a) => a.enabled && (a.kind === 'apikey' || a.kind === 'custom'))
  if (!hasMetered) return false
  const subs = views.filter((a) => a.kind === 'oauth' && a.enabled && a.status === 'ok')
  // zero usable subscriptions → the metered tier IS the pool (picker does the same)
  return subs.every((a) => (a.usage ? hardLimited(a.usage, nowSec) : false))
}

/** Oldest snapshot timestamp among the given rows — the popover header's age. */
export function oldestAt(views: AccountView[]): number | null {
  let oldest: number | null = null
  for (const a of views) {
    if (a.usage && (oldest === null || a.usage.at < oldest)) oldest = a.usage.at
  }
  return oldest
}

/** A snapshot older than this, once the popover is actually looked at, is worth a
 *  probe round — and the same window throttles the retry after a failed one. */
export const AUTO_PROBE_MS = 5 * 60_000

/**
 * The popover just opened: is a refresh due? Stale data (or none at all) says yes.
 *
 * Judged over the rows that can actually carry a number — enabled, alive OAuth
 * accounts. A metered row never has a snapshot and a dead one can never get one, so
 * neither is a reason to spend a round; and a row MISSING a snapshot counts as
 * infinitely stale, or a half-failed round (one account answered, two didn't) would
 * read as fresh off the surviving row and never be retried.
 *
 * `lastAttempt` is what keeps a hover cheap: a probe that keeps failing leaves those
 * rows empty forever, and without the throttle every pass of the mouse would fire
 * another round. A clock jumped backwards must not extend that throttle indefinitely.
 */
export function autoProbeDue(
  views: AccountView[],
  lastAttempt: number | null,
  nowMs: number
): boolean {
  if (lastAttempt !== null && nowMs >= lastAttempt && nowMs - lastAttempt <= AUTO_PROBE_MS)
    return false
  const rows = views.filter((a) => a.kind === 'oauth' && a.enabled && a.status === 'ok')
  if (rows.length === 0) return false
  let oldest = Infinity
  for (const a of rows) {
    if (!a.usage) return true
    if (a.usage.at < oldest) oldest = a.usage.at
  }
  return nowMs - oldest > AUTO_PROBE_MS
}

/** The pool reading (D10): equal-weight means over M — the enabled OAuth rows
 *  that can actually carry a number (`status === 'ok'` AND a snapshot). Everything a
 *  pool surface renders comes from this one fold, so the capsule bar, the POOL row
 *  and the aria string can never disagree on a denominator. */
export interface PoolSnapshot {
  /** |M| — the mean's denominator, shown as "N measured" so shrinkage is visible */
  measured: number
  /** live rows that can take a launch: ok AND not hard-walled (no snapshot counts —
   *  the picker will happily probe-and-pick an unmeasured account) */
  usable: number
  /** hard-walled members (D15 predicate — 'soon'/'due' are not walls) */
  walled: number
  /** mean member tension — each member folded the way its own bar folds */
  tension: number
  t5: number
  t7: number
  /** per-window mean over the hasOi subset; null = no plan carries an allowance */
  tfable: number | null
  fableSpentAll: boolean
  /** smallest FUTURE reset among walled members' hard windows — r=0 promises
   *  nothing and a past reset must never win the min (no 1970) */
  earliestBack: number | null
  oldestAt: number | null
}

export function poolSnapshot(members: AccountView[], nowMs: number): PoolSnapshot {
  const nowSec = Math.floor(nowMs / 1000)
  const live = members.filter((a) => a.kind === 'oauth' && a.enabled && a.status === 'ok')
  const M = live.filter((a) => a.usage !== undefined)
  const isWalled = (a: AccountView): boolean => accountWalled(a.usage as UsageSnapshot, nowSec)
  const walledRows = M.filter(isWalled)
  const usable = live.filter((a) => !a.usage || !accountWalled(a.usage, nowSec)).length
  const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length
  // T5/T7 deliberately have NO walled special case: a rejected window's utilization
  // is already ~100%, and face value is what lets the POOL number be eyeballed
  // against the column of member meters right below it (D10.1)
  const t5 = M.length ? mean(M.map((a) => Math.min((a.usage as UsageSnapshot).u5, 1))) : 0
  const t7 = M.length ? mean(M.map((a) => Math.min((a.usage as UsageSnapshot).u7, 1))) : 0
  const tension = M.length
    ? mean(
        M.map((a) => {
          const u = a.usage as UsageSnapshot
          return isWalled(a) ? 1 : Math.min(Math.max(u.u5, u.u7), 1)
        })
      )
    : 0
  const F = M.filter((a) => (a.usage as UsageSnapshot).hasOi)
  const tfable = F.length
    ? mean(
        F.map((a) => {
          const u = a.usage as UsageSnapshot
          return fableExhausted(u) ? 1 : Math.min(u.uoi, 1)
        })
      )
    : null
  const fableSpentAll = F.length > 0 && F.every((a) => fableExhausted(a.usage as UsageSnapshot))
  let earliestBack: number | null = null
  for (const a of walledRows) {
    const u = a.usage as UsageSnapshot
    for (const [s, r] of [
      [u.s5, u.r5],
      [u.s7, u.r7]
    ] as const) {
      // 'hard' with r>0 implies r ≥ now+GRACE, so every candidate is in the future
      if (
        windowTone(s, r, nowSec) === 'hard' &&
        r > 0 &&
        (earliestBack === null || r < earliestBack)
      )
        earliestBack = r
    }
  }
  return {
    measured: M.length,
    usable,
    walled: walledRows.length,
    tension,
    t5,
    t7,
    tfable,
    fableSpentAll,
    earliestBack,
    oldestAt: oldestAt(M)
  }
}

/** The pool's own bar, drawn through the same glyph pipeline as a member bar.
 *  null = nothing to draw: an aggregate of fewer than two measured accounts is the
 *  one surviving member's level painted twice (D11). */
export function poolGlyph(members: AccountView[], nowMs: number): CapsuleGlyph | null {
  const p = poolSnapshot(members, nowMs)
  if (p.measured < 2) return null
  // a pool number is only as fresh as its stalest input
  const stale = p.oldestAt !== null && nowMs - p.oldestAt > STALE_MS
  if (p.walled === p.measured) return { kind: 'walled', stale }
  const fable = p.tfable === null ? null : { frac: Math.min(p.tfable, CAP), spent: p.fableSpentAll }
  return { kind: 'bar', frac: Math.min(p.tension, CAP), level: meterLevel(p.tension), stale, fable }
}

export type SublineKind = 'none' | 'time' | 'back' | 'due' | 'walled' | 'spent'
export interface Subline {
  kind: SublineKind
  epoch: number
  tone: 'faint' | 'amber' | 'red'
}

/** The resident reset subline under one meter cell (§4.2) — a state for every
 *  situation, because a line that sometimes vanishes is the old layout's disease.
 *  The fable column never inherits the account's wall colour: its bucket closing is
 *  routine, not an alarm. */
export function sublineFor(win: '5h' | '7d' | 'oi', u: UsageSnapshot, nowSec: number): Subline {
  if (win === 'oi') {
    if (fableExhausted(u)) return { kind: 'spent', epoch: u.roi, tone: 'faint' }
    return u.roi > 0
      ? { kind: 'time', epoch: u.roi, tone: 'faint' }
      : { kind: 'none', epoch: 0, tone: 'faint' }
  }
  const s = win === '5h' ? u.s5 : u.s7
  const r = win === '5h' ? u.r5 : u.r7
  switch (windowTone(s, r, nowSec)) {
    case 'ok':
      return r > 0
        ? { kind: 'time', epoch: r, tone: 'faint' }
        : { kind: 'none', epoch: 0, tone: 'faint' }
    case 'soon':
      return { kind: 'back', epoch: r, tone: 'amber' }
    case 'due':
      // never render a moment that already passed — the snapshot, not the account,
      // is what's behind (D7 polls nothing)
      return { kind: 'due', epoch: r, tone: 'faint' }
    case 'hard':
      return r > 0
        ? { kind: 'back', epoch: r, tone: 'red' }
        : { kind: 'walled', epoch: 0, tone: 'red' }
  }
}

/** Screen-reader summary for the capsule button, e.g.
 *  "4 accounts, pool 80%, highest 100%, 2 usable, 1 walled". The pool segment only
 *  exists when the pool bar does (measured ≥ 2); usable is always spoken — it is the
 *  one actionable number in the string. */
export function capsuleAria(views: AccountView[], nowMs: number): string {
  let highest = -1
  let walled = 0
  let fableSpent = 0
  for (const a of views) {
    const g = capsuleGlyph(a, nowMs)
    if (g.kind === 'walled') {
      walled++
      highest = Math.max(highest, 1)
    } else if (g.kind === 'bar' && a.usage) {
      highest = Math.max(highest, Math.min(1, Math.max(a.usage.u5, a.usage.u7)))
      if (g.fable?.spent) fableSpent++
    }
  }
  const p = poolSnapshot(views, nowMs)
  let out = `${views.length} account${views.length === 1 ? '' : 's'}`
  if (p.measured >= 2) out += `, pool ${Math.round(p.tension * 100)}%`
  if (highest >= 0) out += `, highest ${Math.round(highest * 100)}%`
  out += `, ${p.usable} usable`
  if (walled > 0) out += `, ${walled} walled`
  if (fableSpent > 0) out += `, ${fableSpent} fable spent`
  return out
}

/** Fixed-position left edge for a popover centered under `centerX`, clamped to the
 *  viewport with `margin` on both sides. */
export function popoverX(centerX: number, width: number, viewportW: number, margin = 8): number {
  return Math.max(margin, Math.min(centerX - width / 2, viewportW - margin - width))
}
