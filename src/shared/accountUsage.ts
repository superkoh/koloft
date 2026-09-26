import type { AccountView, UsageSnapshot } from './types'

export const STALE_MS = 15 * 60_000
export const CAP = 0.92
export const GRACE = 1_800
export const FABLE_STOP = 0.97

export function hardLimited(u: UsageSnapshot, nowSec: number): boolean {
  return (
    (u.s5 === 'rejected' && u.r5 - nowSec >= GRACE) ||
    (u.s7 === 'rejected' && u.r7 - nowSec >= GRACE)
  )
}

export type WindowTone = 'ok' | 'soon' | 'due' | 'hard'

// CC§7
export function windowTone(s: string, r: number, nowSec: number): WindowTone {
  if (s !== 'rejected') return 'ok'
  if (r === 0) return 'hard'
  if (r <= nowSec) return 'due'
  return r - nowSec < GRACE ? 'soon' : 'hard'
}

export function accountWalled(u: UsageSnapshot, nowSec: number): boolean {
  return windowTone(u.s5, u.r5, nowSec) === 'hard' || windowTone(u.s7, u.r7, nowSec) === 'hard'
}

export function fableExhausted(u: UsageSnapshot): boolean {
  return u.soi === 'rejected' || u.uoi >= FABLE_STOP
}

export type MeterLevel = '' | 'warn' | 'bad'

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
      fable: null | { frac: number; spent: boolean }
    }

export function capsuleGlyph(a: AccountView, nowMs: number): CapsuleGlyph {
  if (a.status !== 'ok') return { kind: 'grey' }
  const u = a.usage
  if (!u) return { kind: 'empty' }
  const stale = nowMs - u.at > STALE_MS
  if (accountWalled(u, Math.floor(nowMs / 1000))) return { kind: 'walled', stale }
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

export function meteredArmed(views: AccountView[], nowSec: number): boolean {
  const hasMetered = views.some((a) => a.enabled && (a.kind === 'apikey' || a.kind === 'custom'))
  if (!hasMetered) return false
  const subs = views.filter((a) => a.kind === 'oauth' && a.enabled && a.status === 'ok')
  return subs.every((a) => (a.usage ? hardLimited(a.usage, nowSec) : false))
}

export function oldestAt(views: AccountView[]): number | null {
  let oldest: number | null = null
  for (const a of views) {
    if (a.usage && (oldest === null || a.usage.at < oldest)) oldest = a.usage.at
  }
  return oldest
}

export const AUTO_PROBE_MS = 5 * 60_000

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

export interface PoolSnapshot {
  measured: number
  usable: number
  walled: number
  tension: number
  t5: number
  t7: number
  tfable: number | null
  fableSpentAll: boolean
  earliestBack: number | null
  oldestAt: number | null
}

// CC§7
export function poolSnapshot(members: AccountView[], nowMs: number): PoolSnapshot {
  const nowSec = Math.floor(nowMs / 1000)
  const live = members.filter((a) => a.kind === 'oauth' && a.enabled && a.status === 'ok')
  const M = live.filter((a) => a.usage !== undefined)
  const isWalled = (a: AccountView): boolean => accountWalled(a.usage as UsageSnapshot, nowSec)
  const walledRows = M.filter(isWalled)
  const usable = live.filter((a) => !a.usage || !accountWalled(a.usage, nowSec)).length
  const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length
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

export function poolGlyph(members: AccountView[], nowMs: number): CapsuleGlyph | null {
  const p = poolSnapshot(members, nowMs)
  if (p.measured < 2) return null
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
      return { kind: 'due', epoch: r, tone: 'faint' }
    case 'hard':
      return r > 0
        ? { kind: 'back', epoch: r, tone: 'red' }
        : { kind: 'walled', epoch: 0, tone: 'red' }
  }
}

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

export function popoverX(centerX: number, width: number, viewportW: number, margin = 8): number {
  return Math.max(margin, Math.min(centerX - width / 2, viewportW - margin - width))
}

// CODEX§15
export function windowLabel(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}
