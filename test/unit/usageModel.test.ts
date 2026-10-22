process.env.TZ = 'America/Los_Angeles'

import { describe, expect, it } from 'vitest'
import type { UsageRow } from '../../src/shared/types'
import { chartDays, grouped, inRange } from '../../src/renderer/src/usageModel'

const TODAY = new Date('2026-10-22T10:00:00-07:00')

function row(o: Partial<UsageRow>): UsageRow {
  return {
    sessionId: 's1',
    day: '2026-10-22',
    model: 'claude-opus-5-5',
    backend: 'claude',
    workspace: '/ws',
    inTok: 1_000_000,
    outTok: 0,
    cacheWriteTok: 0,
    cacheReadTok: 0,
    surchargeUsd: 0,
    ...o
  }
}

describe('usageModel', () => {
  it('keeps only the days of the picked range, today counted as its last day', () => {
    const rows = [row({ day: '2026-10-16' }), row({ day: '2026-10-15' })]
    expect(inRange(rows, '7d', TODAY).map((r) => r.day)).toEqual(['2026-10-16'])
    expect(inRange(rows, 'all', TODAY)).toHaveLength(2)
  })

  it('draws one bar per day of the range, empty days included, with each agent part of a day', () => {
    const days = chartDays(
      [row({}), row({ backend: 'codex', model: 'gpt-6.1-sol', sessionId: 'c1' })],
      '7d',
      TODAY
    )
    expect(days.map((d) => d.day)).toEqual([
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22'
    ])
    expect(days[6].byBackend).toEqual({ claude: 4, codex: 2 })
    expect(days[6].costUsd).toBe(6)
  })

  it('adds the booked long-context surcharge to a priced row', () => {
    const [line] = grouped([row({ surchargeUsd: 0.5 })], 'model')
    expect(line.costUsd).toBe(4.5)
  })

  it('marks a line whose every model has no price, and counts its tokens', () => {
    const lines = grouped(
      [row({ model: 'muse-model', backend: 'muse', sessionId: 'm1' }), row({})],
      'session'
    )
    expect(lines.map((l) => [l.key, l.priced, l.tokens])).toEqual([
      ['s1', true, 1_000_000],
      ['m1', false, 1_000_000]
    ])
  })

  it('lists days newest first and every other grouping most costly first', () => {
    const rows = [
      row({ day: '2026-10-20', sessionId: 'a' }),
      row({ day: '2026-10-21', sessionId: 'b', inTok: 3_000_000 })
    ]
    expect(grouped(rows, 'day').map((l) => l.key)).toEqual(['2026-10-21', '2026-10-20'])
    expect(grouped(rows, 'session').map((l) => l.key)).toEqual(['b', 'a'])
  })
})
