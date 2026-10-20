import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUSY_MARKER, MachineRoom, signalLog } from '../../src/main/machineRoom'

const CORES = 10
let regDir: string
let now: number
let lines: string[]

beforeEach(() => {
  regDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-room-'))
  now = 1_000_000
  lines = []
})

afterEach(() => {
  fs.rmSync(regDir, { recursive: true, force: true })
})

const room = (): MachineRoom =>
  new MachineRoom({
    regDir,
    cores: CORES,
    read: async () => ({ pressure: 1, load1: 0 }),
    now: () => now,
    log: (l) => lines.push(l)
  })

function feed(r: MachineRoom, seconds: number, reading: { pressure: number; load1: number }): void {
  for (let s = 0; s < seconds; s += 5) {
    r.observe(reading)
    now += 5_000
  }
}

const marked = (): boolean => fs.existsSync(path.join(regDir, BUSY_MARKER))

describe('when the machine counts as busy, and when roomy again', () => {
  it('memory pressure at warning makes it busy at once', () => {
    const r = room()
    r.observe({ pressure: 2, load1: 1 })
    expect(r.busy).toBe(true)
  })

  it('holds, and leaves the marker for the hooks, only while busy and background work is running', () => {
    const r = room()
    r.observe({ pressure: 2, load1: 1 })
    expect(r.holding).toBe(false)
    expect(marked()).toBe(false)
    r.backgroundWorkRunning(true)
    expect(r.holding).toBe(true)
    expect(marked()).toBe(true)
    r.backgroundWorkRunning(false)
    expect(marked()).toBe(false)
  })

  it('a load at three times the cores makes it busy only once it lasts 30 s', () => {
    const r = room()
    feed(r, 25, { pressure: 1, load1: 3 * CORES })
    expect(r.busy).toBe(false)
    feed(r, 10, { pressure: 1, load1: 3 * CORES })
    expect(r.busy).toBe(true)
  })

  it('a short spike of load does not make it busy', () => {
    const r = room()
    feed(r, 20, { pressure: 1, load1: 5 * CORES })
    feed(r, 5, { pressure: 1, load1: 1 })
    feed(r, 20, { pressure: 1, load1: 5 * CORES })
    expect(r.busy).toBe(false)
  })

  it('it turns roomy only after a full minute calm, with load under twice the cores', () => {
    const r = room()
    r.observe({ pressure: 2, load1: 1 })
    feed(r, 55, { pressure: 1, load1: 2 * CORES - 1 })
    expect(r.busy).toBe(true)
    feed(r, 10, { pressure: 1, load1: 2 * CORES - 1 })
    expect(r.busy).toBe(false)
    expect(marked()).toBe(false)
  })

  it('load between twice and three times the cores keeps a busy machine busy', () => {
    const r = room()
    r.observe({ pressure: 2, load1: 1 })
    feed(r, 300, { pressure: 1, load1: 2.5 * CORES })
    expect(r.busy).toBe(true)
  })

  it('a stale marker from a Koloft that quit while busy is cleared at start', () => {
    fs.writeFileSync(path.join(regDir, BUSY_MARKER), '')
    room()
    expect(marked()).toBe(false)
  })

  it('writes one signal line a minute and one at each change, for tuning the thresholds', () => {
    const r = room()
    feed(r, 120, { pressure: 1, load1: 1 })
    r.observe({ pressure: 2, load1: 1 })
    expect(lines.length).toBe(3)
    expect(lines[2]).toMatch(/busy · memory pressure 2 · load 1\.0 on 10 cores/)
  })
})

describe('the signal log the thresholds are tuned from', () => {
  it('keeps whole timestamped lines, and never grows past two megabytes', () => {
    const file = path.join(regDir, 'machine.log')
    const log = signalLog(file)
    log('first')
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z first\n$/)
    const line = 'x'.repeat(1000)
    for (let i = 0; i < 2200; i++) log(line)
    const text = fs.readFileSync(file, 'utf8')
    expect(text.length).toBeLessThanOrEqual(2 * 2 ** 20)
    expect(text).not.toContain('first')
    expect(
      text
        .split('\n')
        .filter(Boolean)
        .every((l) => l.endsWith(line))
    ).toBe(true)
  })
})
