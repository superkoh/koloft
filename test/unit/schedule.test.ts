process.env.TZ = 'America/Los_Angeles'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Schedule } from '@shared/types'
import {
  describeSchedule,
  describeWhen,
  isValidSchedule,
  nextRun,
  parseHHMM
} from '@shared/schedule'

function at(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0)
}

function wall(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

describe('the pinned time zone', () => {
  it('is America/Los_Angeles for this file, with both summer and winter offsets, proving Node re-read TZ when it was assigned', () => {
    expect(new Date(2026, 6, 1).getTimezoneOffset()).toBe(420)
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(480)
  })
})

describe('parseHHMM', () => {
  it('reads a zero-padded 24-hour time', () => {
    expect(parseHHMM('00:00')).toEqual({ h: 0, m: 0 })
    expect(parseHHMM('09:05')).toEqual({ h: 9, m: 5 })
    expect(parseHHMM('23:59')).toEqual({ h: 23, m: 59 })
  })

  it('refuses anything else', () => {
    for (const s of ['9:00', '09:0', '0900', '24:00', '23:60', '09:00:00', ' 09:00', '', 'ab:cd']) {
      expect(parseHHMM(s), s).toBeNull()
    }
  })
})

describe('isValidSchedule', () => {
  it('accepts the three kinds inside their limits', () => {
    const ok: unknown[] = [
      { kind: 'daily', at: '00:00' },
      { kind: 'daily', at: '23:59' },
      { kind: 'weekly', days: [1], at: '09:00' },
      { kind: 'weekly', days: [0, 1, 2, 3, 4, 6], at: '09:00' },
      { kind: 'every', n: 1, unit: 'minutes' },
      { kind: 'every', n: 720, unit: 'minutes' },
      { kind: 'every', n: 1, unit: 'hours' },
      { kind: 'every', n: 24, unit: 'hours' }
    ]
    for (const s of ok) expect(isValidSchedule(s), JSON.stringify(s)).toBe(true)
  })

  it('refuses a bad shape, a bad time, days that are not 1-6 ascending unique 0-6 (seven is stored as daily), or an every-N past 720 minutes or 24 hours (BB-E14)', () => {
    const bad: unknown[] = [
      null,
      'daily',
      {},
      { kind: 'monthly', at: '09:00' },
      { kind: 'daily' },
      { kind: 'daily', at: '9:00' },
      { kind: 'weekly', at: '09:00' },
      { kind: 'weekly', days: [], at: '09:00' },
      { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], at: '09:00' },
      { kind: 'weekly', days: [3, 1], at: '09:00' },
      { kind: 'weekly', days: [1, 1], at: '09:00' },
      { kind: 'weekly', days: [7], at: '09:00' },
      { kind: 'weekly', days: [-1], at: '09:00' },
      { kind: 'weekly', days: [1.5], at: '09:00' },
      { kind: 'every', n: 0, unit: 'minutes' },
      { kind: 'every', n: 721, unit: 'minutes' },
      { kind: 'every', n: 25, unit: 'hours' },
      { kind: 'every', n: 1.5, unit: 'minutes' },
      { kind: 'every', n: 5, unit: 'days' }
    ]
    for (const s of bad) expect(isValidSchedule(s), JSON.stringify(s)).toBe(false)
  })
})

describe('nextRun — daily and weekly', () => {
  it('is strictly after `from`, so the same minute never fires twice', () => {
    const s: Schedule = { kind: 'daily', at: '21:00' }
    expect(wall(nextRun(s, at(2026, 9, 2, 20, 59)))).toBe('2026-09-02 21:00')
    expect(wall(nextRun(s, at(2026, 9, 2, 21, 0)))).toBe('2026-09-03 21:00')
  })

  it('picks the next allowed weekday', () => {
    const s: Schedule = { kind: 'weekly', days: [1, 5], at: '09:00' }
    expect(wall(nextRun(s, at(2026, 9, 2, 10, 0)))).toBe('2026-09-04 09:00')
    expect(wall(nextRun(s, at(2026, 9, 4, 10, 0)))).toBe('2026-09-07 09:00')
  })
})

describe('BB-E14: "Repeat every N" is anchored to midnight, not to the save time', () => {
  it('every 30 minutes lands on :00 and :30', () => {
    const s: Schedule = { kind: 'every', n: 30, unit: 'minutes' }
    expect(wall(nextRun(s, at(2026, 9, 2, 10, 7)))).toBe('2026-09-02 10:30')
    expect(wall(nextRun(s, at(2026, 9, 2, 10, 30)))).toBe('2026-09-02 11:00')
  })

  it('every 45 minutes walks 00:00, 00:45, 01:30, 02:15 … and restarts at midnight', () => {
    const s: Schedule = { kind: 'every', n: 45, unit: 'minutes' }
    expect(wall(nextRun(s, at(2026, 9, 2, 10, 7)))).toBe('2026-09-02 10:30')
    expect(wall(nextRun(s, at(2026, 9, 2, 23, 50)))).toBe('2026-09-03 00:00')
  })

  it('every 120 minutes from 10:07 is noon', () => {
    expect(wall(nextRun({ kind: 'every', n: 120, unit: 'minutes' }, at(2026, 9, 2, 10, 7)))).toBe(
      '2026-09-02 12:00'
    )
  })

  it('every 5 hours is 00, 05, 10, 15, 20 and then midnight again', () => {
    const s: Schedule = { kind: 'every', n: 5, unit: 'hours' }
    expect(wall(nextRun(s, at(2026, 9, 2, 21, 0)))).toBe('2026-09-03 00:00')
    expect(wall(nextRun(s, at(2026, 9, 2, 9, 15)))).toBe('2026-09-02 10:00')
  })
})

describe('BB-E15: daylight saving time', () => {
  it('runs a missing wall-clock time on the first minute that exists after the gap', () => {
    const s: Schedule = { kind: 'daily', at: '02:30' }
    expect(wall(nextRun(s, at(2026, 3, 8, 1, 0)))).toBe('2026-03-08 03:00')
  })

  it('runs a doubled wall-clock time once', () => {
    const s: Schedule = { kind: 'daily', at: '01:30' }
    const first = nextRun(s, at(2026, 11, 1, 0, 0))
    expect(wall(first)).toBe('2026-11-01 01:30')
    expect(first.getTimezoneOffset()).toBe(420)
    expect(wall(nextRun(s, first))).toBe('2026-11-02 01:30')
  })

  describe('a zone whose gap starts at midnight (Santiago, Havana, Asunción, Beirut): the walk back from the missing minute must not run into yesterday', () => {
    const PINNED = process.env.TZ
    beforeAll(() => {
      process.env.TZ = 'America/Santiago'
    })
    afterAll(() => {
      process.env.TZ = PINNED
    })

    it('runs on the first minute that exists, still on the DST day', () => {
      expect(new Date(2026, 8, 6, 0, 30).getHours()).toBe(1)
      const s: Schedule = { kind: 'daily', at: '00:30' }
      expect(wall(nextRun(s, at(2026, 9, 5, 12, 0)))).toBe('2026-09-06 01:00')
      expect(wall(nextRun(s, at(2026, 9, 6, 12, 0)))).toBe('2026-09-07 00:30')
    })
  })
})

describe('describeSchedule', () => {
  it('says every day, weekdays, weekends and a list of days', () => {
    expect(describeSchedule({ kind: 'daily', at: '21:00' })).toBe('Every day at 21:00')
    expect(describeSchedule({ kind: 'daily', at: '09:00' })).toBe('Every day at 9:00')
    expect(describeSchedule({ kind: 'weekly', days: [1, 2, 3, 4, 5], at: '09:00' })).toBe(
      'Weekdays at 9:00'
    )
    expect(describeSchedule({ kind: 'weekly', days: [0, 6], at: '09:00' })).toBe('Weekends at 9:00')
    expect(describeSchedule({ kind: 'weekly', days: [1, 3, 5], at: '09:00' })).toBe(
      'Mon, Wed, Fri at 9:00'
    )
  })

  it('starts the day list on Monday and ends it on Sunday', () => {
    expect(describeSchedule({ kind: 'weekly', days: [0, 1], at: '09:00' })).toBe('Mon, Sun at 9:00')
  })

  it('drops the number when it is one', () => {
    expect(describeSchedule({ kind: 'every', n: 1, unit: 'minutes' })).toBe('Every minute')
    expect(describeSchedule({ kind: 'every', n: 30, unit: 'minutes' })).toBe('Every 30 minutes')
    expect(describeSchedule({ kind: 'every', n: 1, unit: 'hours' })).toBe('Every hour')
    expect(describeSchedule({ kind: 'every', n: 2, unit: 'hours' })).toBe('Every 2 hours')
  })
})

describe('BB-E30: the words for times and schedules', () => {
  const now = at(2026, 9, 2, 10, 0)

  it('describeWhen names the day in everyday words', () => {
    expect(describeWhen(at(2026, 9, 2, 21, 0), now)).toBe('today 21:00')
    expect(describeWhen(at(2026, 9, 3, 9, 0), now)).toBe('tomorrow 09:00')
    expect(describeWhen(at(2026, 9, 1, 21, 0), now)).toBe('yesterday 21:00')
    expect(describeWhen(at(2026, 9, 5, 9, 0), now)).toBe('Sat 09:00')
    expect(describeWhen(at(2026, 9, 12, 9, 0), now)).toBe('12 Sep 09:00')
  })

  it('counts whole days, not 24-hour blocks', () => {
    expect(describeWhen(at(2026, 9, 3, 0, 5), now)).toBe('tomorrow 00:05')
    expect(describeWhen(at(2026, 9, 8, 9, 0), now)).toBe('Tue 09:00')
    expect(describeWhen(at(2026, 9, 10, 9, 0), now)).toBe('10 Sep 09:00')
  })
})
