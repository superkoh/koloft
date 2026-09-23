// The world clock's arithmetic, kept out of the component so it can be judged by tests
// in plain Node (the renderer has no DOM test layer).

/** the city half of an IANA id: `America/Argentina/Buenos_Aires` → `Buenos Aires` */
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

/** +1 when `tz` is already on tomorrow's date relative to `localTz`, −1 on yesterday's */
export function dayDelta(tz: string, now: Date, localTz: string): -1 | 0 | 1 {
  const there = calendarDay(tz, now)
  const here = calendarDay(localTz, now)
  return there > here ? 1 : there < here ? -1 : 0
}

function wallClockMs(tz: string, now: Date): number {
  return new Date(now.toLocaleString('en-US', { timeZone: tz })).getTime()
}

/** the chip's title: the id plus how far its clock sits from the local one */
export function zoneTitle(tz: string, now: Date, localTz: string): string {
  const h = Math.round(((wallClockMs(tz, now) - wallClockMs(localTz, now)) / 36e5) * 2) / 2
  if (h === 0) return `${tz} · Same time as here`
  const n = Math.abs(h)
  return `${tz} · ${n} hour${n === 1 ? '' : 's'} ${h > 0 ? 'ahead' : 'behind'}`
}

/** always 24-hour `HH:MM`, whatever the system clock is set to */
export function formatTime(tz: string, now: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(now)
}

/** the ids worth offering, A→Z by city: real places plus plain `UTC` (which V8's list
 *  leaves out) — `Etc/GMT+5` and the other bare aliases have no city, and their "name"
 *  reads backwards to most people */
export function cityZones(all: string[]): string[] {
  const places = all.filter((z) => z.includes('/') && !z.startsWith('Etc/'))
  return [...new Set([...places, 'UTC'])].sort((a, b) => cityOf(a).localeCompare(cityOf(b)))
}

const MATCH_LIMIT = 8

/** autocomplete over `cityZones` output: a query is a city prefix (any word of it) or a
 *  substring of the city or id; city-prefix hits come first. Zones already shown are left out. */
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
