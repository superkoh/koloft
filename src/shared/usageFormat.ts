/**
 * Presentation + aggregation helpers for the usage sub-row, kept out of React
 * so the unit tests exercise the exact production logic (not a re-implementation).
 */
import type { SessionUsage } from './types'

/** Ring colour band for a context-fill fraction (0..1+, may exceed 1):
 *  green `< 50%`, amber `< 80%`, red `≥ 80%` — the ccusage statusline thresholds. */
export function ctxLevel(pct: number): 'g' | 'y' | 'r' {
  if (pct < 0.5) return 'g'
  if (pct < 0.8) return 'y'
  return 'r'
}

/** Whole-percent display for a context-fill fraction (0.34 → 34). */
export function ctxPercent(pct: number): number {
  return Math.round(pct * 100)
}

/** Session cost, per the design: `< $10` → 2 decimals, `< $100` → 1, `≥ $100` →
 *  integer. Always `$`-prefixed. Tier is picked from the ROUNDED value so rounding
 *  can't spill across a boundary (9.997 → "$10.0", 99.96 → "$100" — never "$10.00"
 *  or "$100.0"), mirroring kLabel's guard below. */
export function formatCost(usd: number): string {
  const r2 = Math.round(usd * 100) / 100
  if (r2 < 10) return '$' + r2.toFixed(2)
  const r1 = Math.round(usd * 10) / 10
  if (r1 < 100) return '$' + r1.toFixed(1)
  return '$' + Math.round(usd)
}

/** Format a `k` value (<1000): one decimal below 100, whole number at/above — and
 *  never let rounding spill a decimal into 3 digits (99.95 → "100", not "100.0"). */
function kLabel(k: number): string {
  if (k >= 100) return String(Math.round(k))
  const r = Math.round(k * 10) / 10
  return r >= 100 ? String(Math.round(r)) : r.toFixed(1)
}

/** Compact token count: `840`, `2.1k`, `128k`, `1.48M`. Rounding never spills into
 *  the next magnitude — `999_900 → "1.00M"` (never "1000k"), `99_950 → "100k"`
 *  (never the 5-char "100.0k"). */
export function formatTokens(n: number): string {
  if (!isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  // cut over to M just below 1,000,000 so k rounding can't reach "1000k"
  if (n < 999_500) return kLabel(n / 1000) + 'k'
  const m = n / 1_000_000
  return (m >= 100 ? String(Math.round(m)) : m < 10 ? m.toFixed(2) : m.toFixed(1)) + 'M'
}

/** `YYYY-MM-DD` in LOCAL time for an ISO string / epoch ms; '' when unparseable.
 *  Shared by the tracker (today-cost day bucket) and the renderer (stale-day gate)
 *  so both agree on where the local day boundary falls. */
export function localDayKey(ts: unknown): string {
  const d = typeof ts === 'string' || typeof ts === 'number' ? new Date(ts) : new Date(NaN)
  if (isNaN(d.getTime())) return ''
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** A usage block's today-cost, but only when its bucket is the current LOCAL day
 *  (`today` = `localDayKey(Date.now())`). An idle session's total therefore self-
 *  expires at midnight even without a fresh main-process emit. */
export function todayCostFor(usage: SessionUsage | undefined, today: string): number {
  if (!usage || usage.todayCostUsd == null) return 0
  return usage.todayDayKey === today ? usage.todayCostUsd : 0
}
