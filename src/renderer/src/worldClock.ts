export function cityOf(tz: string): string {
  return tz.slice(tz.lastIndexOf('/') + 1).replace(/_/g, ' ')
}

function calendarDay(tz: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now)
}

export function dayDelta(tz: string, now: Date, localTz: string): -1 | 0 | 1 {
  const there = calendarDay(tz, now)
  const here = calendarDay(localTz, now)
  return there > here ? 1 : there < here ? -1 : 0
}

function wallClockMs(tz: string, now: Date): number {
  return new Date(now.toLocaleString('en-US', { timeZone: tz })).getTime()
}

export function zoneTitle(tz: string, now: Date, localTz: string): string {
  const h = Math.round(((wallClockMs(tz, now) - wallClockMs(localTz, now)) / 36e5) * 2) / 2
  if (h === 0) return `${tz} · Same time as here`
  const n = Math.abs(h)
  return `${tz} · ${n} hour${n === 1 ? '' : 's'} ${h > 0 ? 'ahead' : 'behind'}`
}

export function formatTime(tz: string, now: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(now)
}

export function cityZones(all: string[]): string[] {
  const places = all.filter((z) => z.includes('/') && !z.startsWith('Etc/'))
  return [...new Set([...places, 'UTC'])].sort((a, b) => cityOf(a).localeCompare(cityOf(b)))
}

const MATCH_LIMIT = 8

export function matchZones(query: string, zones: string[], exclude: string[]): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const taken = new Set(exclude)
  const prefix: string[] = []
  const rest: string[] = []
  for (const z of zones) {
    if (taken.has(z)) continue
    const city = cityOf(z).toLowerCase()
    if (city.startsWith(q) || city.split(' ').some((w) => w.startsWith(q))) prefix.push(z)
    else if (city.includes(q) || z.toLowerCase().includes(q)) rest.push(z)
  }
  return [...prefix, ...rest].slice(0, MATCH_LIMIT)
}
