import type { BackendId, UsageRow } from '@shared/types'
import { costUsdOf, resolvePricing } from '@shared/pricing'
import { localDayKey } from '@shared/usageFormat'

export type UsageRange = '7d' | '30d' | '90d' | 'all'
export type UsageGroup = 'day' | 'session' | 'workspace' | 'model'

const RANGE_DAYS: Record<Exclude<UsageRange, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90
}

const DAY_MS = 24 * 60 * 60 * 1000
const NOON_HOUR = 12

export interface UsageLine {
  key: string
  backends: BackendId[]
  workspace: string
  sessions: number
  days: number
  models: string[]
  tokens: number
  costUsd: number
  priced: boolean
}

export interface UsageDay {
  day: string
  costUsd: number
  byBackend: Partial<Record<BackendId, number>>
}

const tokensOf = (r: UsageRow): number => r.inTok + r.outTok + r.cacheReadTok + r.cacheWriteTok

function costOf(r: UsageRow): number | null {
  const pricing = resolvePricing(r.model)
  return pricing ? costUsdOf(pricing, r) + r.surchargeUsd : null
}

export function dayBefore(today: Date, n: number): string {
  const noon = new Date(today.getFullYear(), today.getMonth(), today.getDate() - n, NOON_HOUR)
  return localDayKey(noon.getTime())
}

export function inRange(rows: UsageRow[], range: UsageRange, today: Date): UsageRow[] {
  if (range === 'all') return rows
  const first = dayBefore(today, RANGE_DAYS[range] - 1)
  return rows.filter((r) => r.day >= first)
}

export function chartDays(rows: UsageRow[], range: UsageRange, today: Date): UsageDay[] {
  const last = localDayKey(today.getTime())
  const first =
    range === 'all'
      ? rows.reduce((min, r) => (r.day < min ? r.day : min), last)
      : dayBefore(today, RANGE_DAYS[range] - 1)
  const days: UsageDay[] = []
  for (let n = 0; ; n++) {
    const day = localDayKey(new Date(`${first}T12:00:00`).getTime() + n * DAY_MS)
    if (!day || day > last) break
    days.push({ day, costUsd: 0, byBackend: {} })
  }
  const byDay = new Map(days.map((d) => [d.day, d]))
  for (const r of rows) {
    const d = byDay.get(r.day)
    const cost = costOf(r)
    if (!d || cost === null) continue
    d.costUsd += cost
    d.byBackend[r.backend] = (d.byBackend[r.backend] ?? 0) + cost
  }
  return days
}

const keyFor: Record<UsageGroup, (r: UsageRow) => string> = {
  day: (r) => r.day,
  session: (r) => r.sessionId,
  workspace: (r) => r.workspace,
  model: (r) => r.model
}

interface Sums {
  workspace: string
  backends: Set<BackendId>
  sessions: Set<string>
  days: Set<string>
  models: Set<string>
  tokens: number
  costUsd: number
  priced: boolean
}

export function grouped(rows: UsageRow[], by: UsageGroup): UsageLine[] {
  const acc = new Map<string, Sums>()
  for (const r of rows) {
    const key = keyFor[by](r)
    let sums = acc.get(key)
    if (!sums) {
      sums = {
        workspace: r.workspace,
        backends: new Set(),
        sessions: new Set(),
        days: new Set(),
        models: new Set(),
        tokens: 0,
        costUsd: 0,
        priced: false
      }
      acc.set(key, sums)
    }
    sums.backends.add(r.backend)
    sums.sessions.add(r.sessionId)
    sums.days.add(r.day)
    sums.models.add(r.model)
    sums.tokens += tokensOf(r)
    const cost = costOf(r)
    if (cost !== null) {
      sums.costUsd += cost
      sums.priced = true
    }
  }
  const lines = [...acc].map(([key, s]): UsageLine => ({
    key,
    workspace: s.workspace,
    backends: [...s.backends],
    sessions: s.sessions.size,
    days: s.days.size,
    models: [...s.models],
    tokens: s.tokens,
    costUsd: s.costUsd,
    priced: s.priced
  }))
  return by === 'day'
    ? lines.sort((a, b) => b.key.localeCompare(a.key))
    : lines.sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens)
}
