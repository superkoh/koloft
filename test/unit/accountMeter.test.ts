import { describe, it, expect } from 'vitest'
import {
  ageLabel,
  fableLevel,
  resetIn,
  resetLabel
} from '../../src/renderer/src/components/accountMeter'
import { FABLE_STOP } from '@shared/accountUsage'

const MIN = 60_000
/** local-time instants so the expectations hold in any TZ the suite runs under */
const at = (y: number, mo: number, d: number, h: number, mi: number): number =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
const sec = (ms: number): number => Math.floor(ms / 1000)

describe('resetLabel', () => {
  const now = at(2026, 8, 15, 12, 0)

  it('drops the date for a reset later today', () => {
    expect(resetLabel(sec(at(2026, 8, 15, 14, 30)), now)).toBe('14:30')
  })

  it('carries month-day once the reset leaves today', () => {
    expect(resetLabel(sec(at(2026, 8, 19, 21, 0)), now)).toBe('8-19 21:00')
    // an earlier clock time on another day is still another day
    expect(resetLabel(sec(at(2026, 8, 14, 9, 5)), now)).toBe('8-14 09:05')
  })

  it('does not read a next-year reset as today', () => {
    const eve = at(2026, 12, 31, 23, 40)
    expect(resetLabel(sec(at(2027, 1, 1, 0, 10)), eve)).toBe('1-1 00:10')
    // same month+day, one year apart — the year must be part of the comparison
    expect(resetLabel(sec(at(2027, 12, 31, 23, 40)), eve)).toBe('12-31 23:40')
  })
})

describe('resetIn', () => {
  const now = at(2026, 8, 15, 12, 0)
  const inMin = (m: number): number => sec(now + m * MIN)

  it.each([
    [1, 'in 1m'],
    [22, 'in 22m'],
    [59, 'in 59m'],
    [60, 'in 1h 00m'],
    [62, 'in 1h 02m'],
    [242, 'in 4h 02m'],
    [300, 'in 5h 00m']
  ])('%s minutes out → %s', (mins, label) => {
    expect(resetIn(inMin(mins), now)).toBe(label)
  })

  it('never rounds a live reset down to "in 0m"', () => {
    expect(resetIn(sec(now + 30_000), now)).toBe('in 1m')
  })

  it('reports a reset instant that has passed as due', () => {
    expect(resetIn(sec(now), now)).toBe('due')
    expect(resetIn(sec(now - 5 * MIN), now)).toBe('due')
  })
})

describe('ageLabel', () => {
  const now = at(2026, 8, 15, 12, 0)

  it('stays silent under two minutes', () => {
    expect(ageLabel(now, now)).toBeNull()
    expect(ageLabel(now - 2 * MIN + 1000, now)).toBeNull()
  })

  it('labels the snapshot age from two minutes on', () => {
    expect(ageLabel(now - 2 * MIN, now)).toBe('cached 2m')
    expect(ageLabel(now - 17 * MIN, now)).toBe('cached 17m')
  })
})

describe('fableLevel', () => {
  it('paints a rejected fable bucket bad however low the number is', () => {
    expect(fableLevel(0.12, 'rejected')).toBe('bad')
  })

  it('keeps the fable-only thresholds for a bucket still serving', () => {
    expect(fableLevel(0.84, 'ok')).toBe('')
    expect(fableLevel(0.85, 'ok')).toBe('warn')
    expect(fableLevel(0.9, 'ok')).toBe('warn')
    expect(fableLevel(FABLE_STOP, 'ok')).toBe('bad')
  })
})
