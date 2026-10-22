import type { BackendId, UsageRow } from '@shared/types'
import { costUsdOf, resolvePricing } from '@shared/pricing'
import { localDayKey } from '@shared/usageFormat'

export type UsageRange = '7d' | '30d' | '90d' | 'all'
export type UsageGroup = 'day' | 'session' | 'workspace' | 'model'

export const RANGE_DAYS: Record<Exclude<UsageRange, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90
}

const DAY_MS = 24 * 60 * 60 * 1000

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

export const tokensOf = (r: UsageRow): number =>
  r.inTok + r.outTok + r.cacheReadTok + r.cacheWriteTok

export function costOf(r: UsageRow): number | null {
  const pricing = resolvePricing(r.model)
  return pricing ? costUsdOf(pricing, r) + r.surchargeUsd : null
}

export function dayBefore(today: Date, n: number): string {
  return localDayKey(today.getTime() - n * DAY_MS)
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

export function grouped(rows: UsageRow[], by: UsageGroup): UsageLine[] {
  const acc = new Map<
    string,
    UsageLine & { sessionSet: Set<string>; daySet: Set<string>; modelSet: Set<string> }
  >()
  for (const r of rows) {
    const key = keyFor[by](r)
    let line = acc.get(key)
    if (!line) {
      line = {
        key,
        backends: [],
        workspace: r.workspace,
        sessions: 0,
        days: 0,
        models: [],
        tokens: 0,
        costUsd: 0,
        priced: false,
        sessionSet: new Set(),
        daySet: new Set(),
        modelSet: new Set()
      }
      acc.set(key, line)
    }
    if (!line.backends.includes(r.backend)) line.backends.push(r.backend)
    line.sessionSet.add(r.sessionId)
    line.daySet.add(r.day)
    line.modelSet.add(r.model)
    line.tokens += tokensOf(r)
    const cost = costOf(r)
    if (cost !== null) {
      line.costUsd += cost
      line.priced = true
    }
  }
  const lines = [...acc.values()].map(({ sessionSet, daySet, modelSet, ...line }) => ({
    ...line,
    sessions: sessionSet.size,
    days: daySet.size,
    models: [...modelSet]
  }))
  return by === 'day'
    ? lines.sort((a, b) => b.key.localeCompare(a.key))
    : lines.sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens)
}
