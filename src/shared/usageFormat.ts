import type { SessionUsage } from './types'

const CCUSAGE_STATUSLINE_AMBER_FROM = 0.5
const CCUSAGE_STATUSLINE_RED_FROM = 0.8

export function ctxLevel(pct: number): 'g' | 'y' | 'r' {
  if (pct < CCUSAGE_STATUSLINE_AMBER_FROM) return 'g'
  if (pct < CCUSAGE_STATUSLINE_RED_FROM) return 'y'
  return 'r'
}

export function ctxPercent(pct: number): number {
  return Math.round(pct * 100)
}

export function formatCost(usd: number): string {
  const r2 = Math.round(usd * 100) / 100
  if (r2 < 10) return '$' + r2.toFixed(2)
  const r1 = Math.round(usd * 10) / 10
  if (r1 < 100) return '$' + r1.toFixed(1)
  return '$' + Math.round(usd)
}

function kLabel(k: number): string {
  if (k >= 100) return String(Math.round(k))
  const r = Math.round(k * 10) / 10
  return r >= 100 ? String(Math.round(r)) : r.toFixed(1)
}

const SMALLEST_COUNT_THAT_WOULD_ROUND_TO_1000K = 999_500

export function formatTokens(n: number): string {
  if (!isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < SMALLEST_COUNT_THAT_WOULD_ROUND_TO_1000K) return kLabel(n / 1000) + 'k'
  const m = n / 1_000_000
  return (m >= 100 ? String(Math.round(m)) : m < 10 ? m.toFixed(2) : m.toFixed(1)) + 'M'
}

export function localDayKey(ts: unknown): string {
  const d = typeof ts === 'string' || typeof ts === 'number' ? new Date(ts) : new Date(NaN)
  if (isNaN(d.getTime())) return ''
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function todayCostFor(usage: SessionUsage | undefined, today: string): number {
  if (!usage || usage.todayCostUsd == null) return 0
  return usage.todayDayKey === today ? usage.todayCostUsd : 0
}
