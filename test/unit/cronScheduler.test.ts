import { describe, expect, it, vi } from 'vitest'
import type { CronJob, Schedule } from '@shared/types'
import { MISS_WINDOW_MS, seedLastDue, tick } from '../../src/main/cronScheduler'

// Which minutes count as due, and which of those Koloft may still run. The runner's
// half of these rules (what it then does with a verdict) is cronRunner.test.ts.

let n = 0
function job(schedule: Schedule, over: Partial<CronJob> = {}): CronJob {
  return {
    id: `j${++n}`,
    workspacePath: '/ws/a',
    name: 'Nightly report',
    task: '/daily-report',
    schedule,
    permission: 'same',
    enabled: true,
    createdAt: 0,
    history: [],
    ...over
  }
}

/** local wall clock, month 1-based */
function at(mo: number, d: number, h: number, mi: number, s = 0): number {
  return new Date(2026, mo - 1, d, h, mi, s, 0).getTime()
}

function wall(t: number): string {
  const d = new Date(t)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

describe('BB-E16: boot seeds the clock; a failure consumes its minute', () => {
  it('reports a due from just before boot as missed, never as a run to start', () => {
    const j = job({ kind: 'daily', at: '09:00' })
    const boot = at(9, 2, 9, 3)
    const seeded = seedLastDue([j], boot)
    const out = tick([j], at(9, 2, 9, 3, 20), seeded, boot)
    expect(out.missed.map((d) => wall(d.dueAt))).toEqual(['09:00'])
    expect(out.fire).toEqual([])
  })

  it('says nothing about a due older than the seeded window', () => {
    // Koloft was off all night; the 08:00 job gets no line at all, not one per day
    const j = job({ kind: 'daily', at: '08:00' })
    const boot = at(9, 2, 9, 3)
    const out = tick([j], at(9, 2, 9, 3, 20), seedLastDue([j], boot), boot)
    expect(out.missed).toEqual([])
    expect(out.fire).toEqual([])
  })

  it('never reports the same minute twice, whatever the runner did with it', () => {
    const j = job({ kind: 'daily', at: '09:00' })
    const boot = at(9, 2, 8, 0)
    const lastDue = new Map([[j.id, at(9, 2, 9, 0)]]) // a verdict for 09:00 was already reached
    const out = tick([j], at(9, 2, 9, 0, 20), lastDue, boot)
    expect(out.fire).toEqual([])
    expect(out.missed).toEqual([])
  })

  it('seeds five minutes before boot, and only enabled jobs', () => {
    const on = job({ kind: 'daily', at: '09:00' })
    const off = job({ kind: 'daily', at: '09:00' }, { enabled: false })
    const boot = at(9, 2, 9, 3)
    const seeded = seedLastDue([on, off], boot)
    expect(seeded.get(on.id)).toBe(boot - MISS_WINDOW_MS)
    expect(seeded.has(off.id)).toBe(false)
  })

  it('writes a line only for the few dues inside the seeded window, not one per missed minute', () => {
    // this job was due every minute for the week Koloft was closed
    const j = job({ kind: 'every', n: 1, unit: 'minutes' })
    const boot = at(9, 2, 10, 3)
    const out = tick([j], at(9, 2, 10, 3, 20), seedLastDue([j], boot), boot)
    expect(out.missed.map((d) => wall(d.dueAt))).toEqual(['09:59', '10:00', '10:01', '10:02'])
    expect(out.fire.map((d) => wall(d.dueAt))).toEqual(['10:03'])
  })
})

describe('BB-E23: editing or switching a job on again re-arms it from now', () => {
  it('seeds a job with no entry and replays nothing', () => {
    // switched off at 10:00, on again at 15:00 — setEnabled dropped its entry
    const j = job({ kind: 'every', n: 1, unit: 'minutes' })
    const boot = at(9, 2, 9, 0)
    const first = tick([j], at(9, 2, 15, 0, 10), new Map(), boot)
    expect(first.fire).toEqual([])
    expect(first.missed).toEqual([])
    expect(first.lastDue.get(j.id)).toBe(at(9, 2, 15, 0, 10))

    const second = tick([j], at(9, 2, 15, 1, 10), first.lastDue, boot)
    expect(second.fire.map((d) => wall(d.dueAt))).toEqual(['15:01'])
    expect(second.missed).toEqual([])
  })

  it('starts a changed schedule at the minute after the edit', () => {
    // saved at 10:00:30 as `every 1 minutes`; save dropped the old entry
    const j = job({ kind: 'every', n: 1, unit: 'minutes' })
    const boot = at(9, 2, 9, 0)
    const seeded = tick([j], at(9, 2, 10, 0, 30), new Map(), boot).lastDue
    const out = tick([j], at(9, 2, 10, 1, 0), seeded, boot)
    expect(out.fire.map((d) => wall(d.dueAt))).toEqual(['10:01'])
    expect(out.missed).toEqual([])
  })

  it('never reaches a verdict for a job that is switched off', () => {
    const j = job({ kind: 'every', n: 1, unit: 'minutes' }, { enabled: false })
    const boot = at(9, 2, 9, 0)
    const out = tick([j], at(9, 2, 10, 3, 20), new Map([[j.id, at(9, 2, 10, 0)]]), boot)
    expect(out.fire).toEqual([])
    expect(out.missed).toEqual([])
  })
})

describe('the spin guard', () => {
  it('stops after one line when nextRun stands still', async () => {
    // a broken clock must cost one wrong line, not a frozen app: without the
    // guard this test never returns
    vi.resetModules()
    const stuck = at(9, 2, 10, 0)
    vi.doMock('@shared/schedule', () => ({ nextRun: () => new Date(stuck) }))
    const mod = await import('../../src/main/cronScheduler')
    const j = job({ kind: 'daily', at: '10:00' })
    const out = mod.tick(
      [j],
      at(9, 2, 10, 0, 20),
      new Map([[j.id, at(9, 2, 9, 59)]]),
      at(9, 2, 8, 0)
    )
    expect(out.fire.length + out.missed.length).toBe(1)
    vi.doUnmock('@shared/schedule')
    vi.resetModules()
  })
})
