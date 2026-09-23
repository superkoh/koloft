// The clock rules are all local-time rules, so the suite pins a zone with a
// daylight-saving jump. Node re-reads TZ the moment this is assigned, and the
// first test below proves it took (an ESM import list is hoisted above this
// line, but nothing in the modules under test builds a Date while loading).
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

/** local wall clock, month is 1-based so the tests read like a calendar */
function at(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0)
}

/** what a person would read off the clock, for a readable failure message */
function wall(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

describe('the pinned time zone', () => {
  it('is America/Los_Angeles for this file', () => {
    // 420 min behind UTC in summer, 480 in winter — the DST cases below need both
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

  it('refuses a bad shape, a bad time, or days that are not 1-6 ascending unique 0-6', () => {
    const bad: unknown[] = [
      null,
      'daily',
      {},
      { kind: 'monthly', at: '09:00' },
      { kind: 'daily' },
      { kind: 'daily', at: '9:00' },
      { kind: 'weekly', at: '09:00' }, // no days
      { kind: 'weekly', days: [], at: '09:00' }, // too few
      { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], at: '09:00' }, // seven is stored as daily
      { kind: 'weekly', days: [3, 1], at: '09:00' }, // not ascending
      { kind: 'weekly', days: [1, 1], at: '09:00' }, // not unique
      { kind: 'weekly', days: [7], at: '09:00' }, // out of range
      { kind: 'weekly', days: [-1], at: '09:00' },
      { kind: 'weekly', days: [1.5], at: '09:00' },
      { kind: 'every', n: 0, unit: 'minutes' },
      { kind: 'every', n: 721, unit: 'minutes' }, // BB-E14
      { kind: 'every', n: 25, unit: 'hours' }, // BB-E14
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
    // is a Wednesday; Mon/Fri only
    const s: Schedule = { kind: 'weekly', days: [1, 5], at: '09:00' }
    expect(wall(nextRun(s, at(2026, 9, 2, 10, 0)))).toBe('2026-09-04 09:00') // Fri
    expect(wall(nextRun(s, at(2026, 9, 4, 10, 0)))).toBe('2026-09-07 09:00') // Mon
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
    //: the clock jumps 02:00 → 03:00, so 02:30 never happens
    const s: Schedule = { kind: 'daily', at: '02:30' }
    expect(wall(nextRun(s, at(2026, 3, 8, 1, 0)))).toBe('2026-03-08 03:00')
  })

  it('runs a doubled wall-clock time once', () => {
    //: 01:00–02:00 happens twice
    const s: Schedule = { kind: 'daily', at: '01:30' }
    const first = nextRun(s, at(2026, 11, 1, 0, 0))
    expect(wall(first)).toBe('2026-11-01 01:30')
    expect(first.getTimezoneOffset()).toBe(420) // the first 01:30, still on summer time
    expect(wall(nextRun(s, first))).toBe('2026-11-02 01:30') // not the second 01:30
  })

  // Los Angeles jumps at 02:00, so the walk back from the missing minute stays inside
  // the day. Some zones jump AT MIDNIGHT — Santiago, Havana, Asunción, Beirut — and
  // there the minute before 01:00 is 23:59 of the day before, whose minutes-since-
  // midnight (1439) is "at or after" every possible time. An unguarded walk runs into
  // yesterday and the job quietly skips the DST day altogether.
  //
  // Changing TZ here is safe: nothing in @shared/schedule builds a Date while loading,
  // and Node re-reads the zone on assignment (proved by the first assertion below).
  describe('a zone whose gap starts at midnight', () => {
    const PINNED = process.env.TZ
    beforeAll(() => {
      process.env.TZ = 'America/Santiago'
    })
    afterAll(() => {
      process.env.TZ = PINNED
    })

    it('runs on the first minute that exists, still on the DST day', () => {
      // in Santiago: 00:00 → 01:00, so 00:30 never happens
      expect(new Date(2026, 8, 6, 0, 30).getHours()).toBe(1)
      const s: Schedule = { kind: 'daily', at: '00:30' }
      expect(wall(nextRun(s, at(2026, 9, 5, 12, 0)))).toBe('2026-09-06 01:00')
      // and the day after is an ordinary 00:30 again
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
  // the case names Wed 10:00 (it calls the day Tue and 5 Sep Fri; the
  // real calendar says Wed and Sat — the dates are the case's, the day names are
  // the calendar's)
  const now = at(2026, 9, 2, 10, 0)

  it('describeWhen names the day in everyday words', () => {
    expect(describeWhen(at(2026, 9, 2, 21, 0), now)).toBe('today 21:00')
    expect(describeWhen(at(2026, 9, 3, 9, 0), now)).toBe('tomorrow 09:00')
    expect(describeWhen(at(2026, 9, 1, 21, 0), now)).toBe('yesterday 21:00')
    expect(describeWhen(at(2026, 9, 5, 9, 0), now)).toBe('Sat 09:00')
    expect(describeWhen(at(2026, 9, 12, 9, 0), now)).toBe('12 Sep 09:00')
  })

  it('counts whole days, not 24-hour blocks', () => {
    // 5 minutes later on the calendar's next day is still "tomorrow"
    expect(describeWhen(at(2026, 9, 3, 0, 5), now)).toBe('tomorrow 00:05')
    // and the sixth day out is still a day name, the eighth is a date
    expect(describeWhen(at(2026, 9, 8, 9, 0), now)).toBe('Tue 09:00')
    expect(describeWhen(at(2026, 9, 10, 9, 0), now)).toBe('10 Sep 09:00')
  })
})
