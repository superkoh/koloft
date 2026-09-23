import type { Schedule } from '@shared/types'

/** The clock rules for scheduled jobs. Pure: no timers, no fs, no Electron.
 *  Shared because the form previews the very same words the card and the badge show.
 *
 *  Every sum here goes through Date's LOCAL getters and setters. A job set for
 *  "every day at 09:00" must fire at 09:00 on the wall clock in front of the
 *  person, on both sides of a daylight-saving jump — epoch arithmetic would drift
 *  it by an hour twice a year. */

const MIN = 60_000
const DAY_MIN = 24 * 60

/** strict `HH:MM`, 24 hour, zero padded. Anything else is null. */
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
      // ascending and unique fall out of one check: each day must beat the last
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

/** minutes since local midnight */
function mins(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

/** The moment on day `y-mo-date` whose local clock reads `at`.
 *
 *  On the spring-forward day that clock reading can be missing: the wall clock
 *  jumps 02:00 → 03:00, so 02:30 never happens. The Date constructor answers with
 *  a time past the gap (03:30), so we walk back one minute at a time for as long
 *  as the minute before is still at or after `at`, which lands on the first
 *  minute that does exist — 03:00. The job runs once, right after the gap.
 *  The other side (fall back, when a clock reading happens twice) needs nothing:
 *  the constructor picks one instant, and the next search starts from it.
 *
 *  The walk must never leave the day. Some zones put the gap AT midnight —
 *  Santiago, Havana, Asunción, Beirut all jump 00:00 → 01:00 — and one minute
 *  before 01:00 there reads 23:59 of the day before. Minutes-since-midnight then
 *  says 1439, which is "at or after" every possible `at`, so an unguarded walk
 *  would run all 1440 steps into yesterday and answer with a time in the past;
 *  `nextRun` would drop that day and the job would silently not run on it. */
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

/** The first moment the schedule names that is strictly after `from`. */
export function nextRun(s: Schedule, from: Date): Date {
  if (s.kind === 'every') {
    // Candidates are anchored to LOCAL midnight, not to the last run: minutes
    // since midnight must divide by the step. So "every 45 minutes" reads
    // 00:00, 00:45, 01:30 … and starts over at midnight every day — the same
    // list whatever time the job was saved, and no drift as it runs.
    const step = s.unit === 'minutes' ? s.n : s.n * 60
    let t = new Date(from.getTime())
    t.setSeconds(0, 0)
    const cap = 2 * DAY_MIN + DAY_MIN // 2 days of minutes, plus room for a DST day
    for (let i = 0; i < cap; i++) {
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
    // read the weekday off midday so a DST snap can never shift it a day
    const weekday = new Date(y, mo, date + d, 12, 0, 0, 0).getDay()
    if (s.kind === 'weekly' && !s.days.includes(weekday)) continue
    const t = candidate(y, mo, date + d, h, mi)
    if (t.getTime() > from.getTime()) return t
  }
  // unreachable for a valid schedule; answer a day out rather than throw
  return candidate(y, mo, date + 1, h, mi)
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0] // Mon … Sun
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function p2(n: number): string {
  return String(n).padStart(2, '0')
}

/** `9:00` — the hour keeps no leading zero here on purpose: this text is read as
 *  speech ("Every day at 9:00"), while a time stamp keeps both digits. */
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

/** whole local days from `now`'s day to `t`'s day; negative = in the past */
function dayGap(t: Date, now: Date): number {
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0)
  const b = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 12, 0, 0, 0)
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * MIN))
}

function clock(t: Date): string {
  return `${p2(t.getHours())}:${p2(t.getMinutes())}`
}

/** When something happened or will happen, in words. Works both ways in time. */
export function describeWhen(t: Date, now: Date): string {
  const g = dayGap(t, now)
  if (g === 0) return `today ${clock(t)}`
  if (g === 1) return `tomorrow ${clock(t)}`
  if (g === -1) return `yesterday ${clock(t)}`
  if (g >= -6 && g <= 6) return `${DOW[t.getDay()]} ${clock(t)}`
  return `${t.getDate()} ${MON[t.getMonth()]} ${clock(t)}`
}
