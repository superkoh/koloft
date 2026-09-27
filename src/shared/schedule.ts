import type { Schedule } from '@shared/types'

const MIN = 60_000
const DAY_MIN = 24 * 60

export function parseHHMM(at: string): { h: number; m: number } | null {
  if (typeof at !== 'string' || !/^\d\d:\d\d$/.test(at)) return null
  const h = Number(at.slice(0, 2))
  const m = Number(at.slice(3, 5))
  if (h > 23 || m > 59) return null
  return { h, m }
}

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n)
}

export function isValidSchedule(x: unknown): x is Schedule {
  if (!x || typeof x !== 'object') return false
  const s = x as Record<string, unknown>
  if (s.kind === 'daily') {
    return typeof s.at === 'string' && parseHHMM(s.at) !== null
  }
  if (s.kind === 'weekly') {
    if (typeof s.at !== 'string' || parseHHMM(s.at) === null) return false
    const days = s.days
    if (!Array.isArray(days) || days.length < 1 || days.length > 6) return false
    let prev = -1
    for (const d of days) {
      if (!isInt(d) || d < 0 || d > 6 || d <= prev) return false
      prev = d
    }
    return true
  }
  if (s.kind === 'every') {
    if (!isInt(s.n)) return false
    if (s.unit === 'minutes') return s.n >= 1 && s.n <= 720
    if (s.unit === 'hours') return s.n >= 1 && s.n <= 24
    return false
  }
  return false
}

function mins(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

function candidate(y: number, mo: number, date: number, h: number, mi: number): Date {
  let t = new Date(y, mo, date, h, mi, 0, 0)
  const want = h * 60 + mi
  if (mins(t) === want) return t
  for (let i = 0; i < DAY_MIN; i++) {
    const prev = new Date(t.getTime() - MIN)
    if (prev.getDate() !== t.getDate()) break
    if (mins(prev) < want) break
    t = prev
  }
  return t
}

const NOON_NO_DST_SNAP_CAN_SHIFT_THE_DAY = 12

export function nextRun(s: Schedule, from: Date): Date {
  if (s.kind === 'every') {
    const step = s.unit === 'minutes' ? s.n : s.n * 60
    let t = new Date(from.getTime())
    t.setSeconds(0, 0)
    const twoDaysPlusDstDaySlack = 2 * DAY_MIN + DAY_MIN
    for (let i = 0; i < twoDaysPlusDstDaySlack; i++) {
      t = new Date(t.getTime() + MIN)
      if (t.getTime() > from.getTime() && mins(t) % step === 0) return t
    }
    return t
  }
  const hm = parseHHMM(s.at)
  const { h, mi } = { h: hm ? hm.h : 0, mi: hm ? hm.m : 0 }
  const y = from.getFullYear()
  const mo = from.getMonth()
  const date = from.getDate()
  for (let d = 0; d <= 7; d++) {
    const weekday = new Date(y, mo, date + d, NOON_NO_DST_SNAP_CAN_SHIFT_THE_DAY, 0, 0, 0).getDay()
    if (s.kind === 'weekly' && !s.days.includes(weekday)) continue
    const t = candidate(y, mo, date + d, h, mi)
    if (t.getTime() > from.getTime()) return t
  }
  return candidate(y, mo, date + 1, h, mi)
}

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function p2(n: number): string {
  return String(n).padStart(2, '0')
}

function speechTime(at: string): string {
  const hm = parseHHMM(at)
  if (!hm) return at
  return `${hm.h}:${p2(hm.m)}`
}

export function describeSchedule(s: Schedule): string {
  if (s.kind === 'daily') return `Every day at ${speechTime(s.at)}`
  if (s.kind === 'weekly') {
    const set = [...s.days].sort((a, b) => a - b)
    const isWeekdays = set.length === 5 && set.every((d) => d >= 1 && d <= 5)
    if (isWeekdays) return `Weekdays at ${speechTime(s.at)}`
    if (set.length === 2 && set[0] === 0 && set[1] === 6) return `Weekends at ${speechTime(s.at)}`
    const names = DOW_ORDER.filter((d) => set.includes(d)).map((d) => DOW[d])
    return `${names.join(', ')} at ${speechTime(s.at)}`
  }
  if (s.n === 1) return s.unit === 'minutes' ? 'Every minute' : 'Every hour'
  return `Every ${s.n} ${s.unit}`
}

function dayGap(t: Date, now: Date): number {
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0)
  const b = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 12, 0, 0, 0)
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * MIN))
}

function clock(t: Date): string {
  return `${p2(t.getHours())}:${p2(t.getMinutes())}`
}

export function describeWhen(t: Date, now: Date): string {
  const g = dayGap(t, now)
  if (g === 0) return `today ${clock(t)}`
  if (g === 1) return `tomorrow ${clock(t)}`
  if (g === -1) return `yesterday ${clock(t)}`
  if (g >= -6 && g <= 6) return `${DOW[t.getDay()]} ${clock(t)}`
  return `${t.getDate()} ${MON[t.getMonth()]} ${clock(t)}`
}
