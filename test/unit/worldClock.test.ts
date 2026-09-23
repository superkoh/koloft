import { describe, it, expect } from 'vitest'
import {
  cityOf,
  cityZones,
  dayDelta,
  formatTime,
  matchZones,
  zoneTitle
} from '../../src/renderer/src/worldClock'

// 23:30 in Los Angeles: London and Tokyo are already on the 8th,
// Honolulu (UTC−10) is still on the 7th
const LATE_LA = new Date('2026-09-08T06:30:00Z')

describe('dayDelta', () => {
  it('reads tomorrow / today / yesterday against the local calendar day', () => {
    expect(dayDelta('Europe/London', LATE_LA, 'America/Los_Angeles')).toBe(1)
    expect(dayDelta('Pacific/Honolulu', LATE_LA, 'America/Los_Angeles')).toBe(0)
    expect(dayDelta('America/Los_Angeles', LATE_LA, 'Asia/Tokyo')).toBe(-1)
  })
})

describe('zoneTitle', () => {
  it('names the zone and its whole-hour distance from the local one', () => {
    expect(zoneTitle('Asia/Tokyo', LATE_LA, 'America/Los_Angeles')).toMatch(
      /^Asia\/Tokyo .*16 hours ahead/
    )
    expect(zoneTitle('Pacific/Honolulu', LATE_LA, 'America/Los_Angeles')).toMatch(/3 hours behind/)
    expect(zoneTitle('America/Los_Angeles', LATE_LA, 'America/Los_Angeles')).not.toMatch(
      /ahead|behind/
    )
  })
})

describe('formatTime', () => {
  it('is 24-hour HH:MM, midnight as 00', () => {
    expect(formatTime('America/Los_Angeles', LATE_LA)).toBe('23:30')
    expect(formatTime('Europe/London', LATE_LA)).toBe('07:30')
    expect(formatTime('Asia/Kolkata', new Date('2026-09-07T18:30:00Z'))).toBe('00:00')
  })
})

describe('cityOf', () => {
  it('takes the last segment and restores its spaces', () => {
    expect(cityOf('America/Argentina/Buenos_Aires')).toBe('Buenos Aires')
    expect(cityOf('Asia/Ho_Chi_Minh')).toBe('Ho Chi Minh')
  })
})

describe('autocomplete', () => {
  const ALL = [
    'Arctic/Longyearbyen',
    'America/New_York',
    'Europe/London',
    'Asia/Ho_Chi_Minh',
    'America/Los_Angeles',
    'Etc/GMT+5'
  ]

  it('offers real places and UTC (which the system list omits), A→Z by city', () => {
    expect(cityZones(ALL)).toEqual([
      'Asia/Ho_Chi_Minh',
      'Europe/London',
      'Arctic/Longyearbyen',
      'America/Los_Angeles',
      'America/New_York',
      'UTC'
    ])
    expect(matchZones('utc', cityZones(ALL), [])).toEqual(['UTC'])
  })

  it('matches a city-word prefix before an id substring, and skips zones already shown', () => {
    const zones = cityZones(ALL)
    expect(matchZones('lon', zones, [])).toEqual(['Europe/London', 'Arctic/Longyearbyen'])
    expect(matchZones('lon', zones, ['Europe/London'])).toEqual(['Arctic/Longyearbyen'])
    expect(matchZones('chi minh', zones, [])).toEqual(['Asia/Ho_Chi_Minh'])
    expect(matchZones('york', zones, [])).toEqual(['America/New_York'])
    expect(matchZones('amer', zones, [])).toEqual(['America/Los_Angeles', 'America/New_York'])
    expect(matchZones('', zones, [])).toEqual([])
  })
})
