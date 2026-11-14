import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MachineRoom, signalLog } from '../../src/main/machineRoom'

let dir: string
let lines: string[]

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-room-'))
  lines = []
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

let saidCritical: number

const room = (): MachineRoom => {
  saidCritical = 0
  return new MachineRoom({
    read: async () => ({ pressure: 1 }),
    log: (l) => lines.push(l),
    memoryStaysCritical: () => saidCritical++
  })
}

function feed(r: MachineRoom, readings: number, pressure: number): void {
  for (let i = 0; i < readings; i++) r.observe({ pressure })
}

describe('when memory counts as critical', () => {
  it('says so from the second critical reading in a row, and at every reading while it lasts', () => {
    const r = room()
    r.observe({ pressure: 4 })
    expect(saidCritical).toBe(0)
    expect(r.memoryStaysCritical).toBe(false)
    r.observe({ pressure: 4 })
    expect(saidCritical).toBe(1)
    expect(r.memoryStaysCritical).toBe(true)
    feed(r, 3, 4)
    expect(saidCritical).toBe(4)
  })

  it('a single critical reading between calmer ones says nothing', () => {
    const r = room()
    r.observe({ pressure: 4 })
    r.observe({ pressure: 2 })
    r.observe({ pressure: 4 })
    expect(saidCritical).toBe(0)
  })

  it('memory at warning says nothing, however long it lasts', () => {
    const r = room()
    feed(r, 120, 2)
    expect(saidCritical).toBe(0)
    expect(r.memoryStaysCritical).toBe(false)
  })

  it('is over at the first reading below critical', () => {
    const r = room()
    feed(r, 5, 4)
    r.observe({ pressure: 2 })
    expect(r.memoryStaysCritical).toBe(false)
  })
})

describe('the signal log the tiers are counted from', () => {
  it('gets one line each time the memory pressure level changes, none while it stays', () => {
    const r = room()
    feed(r, 12, 1)
    feed(r, 12, 2)
    feed(r, 2, 4)
    r.observe({ pressure: 1 })
    expect(lines).toEqual([
      '[koloft] machine: memory pressure 1',
      '[koloft] machine: memory pressure 2',
      '[koloft] machine: memory pressure 4',
      '[koloft] machine: memory pressure 1'
    ])
  })

  it('keeps whole timestamped lines, and trims itself back under two megabytes', async () => {
    const file = path.join(dir, 'machine.log')
    const log = signalLog(file)
    log('first')
    await vi.waitFor(
      () => expect(fs.readFileSync(file, 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z first\n$/),
      { timeout: 10_000 }
    )
    const line = 'x'.repeat(1000)
    for (const batch of ['one', 'two', 'three']) {
      for (let i = 0; i < 800; i++) log(line)
      log(batch)
      await vi.waitFor(
        () => {
          const whole = fs.readFileSync(file, 'utf8')
          expect(whole).toMatch(new RegExp(` ${batch}\\n$`))
          expect(whole.length).toBeLessThanOrEqual(2 * 2 ** 20)
        },
        { timeout: 10_000 }
      )
    }
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines.some((l) => l.endsWith(' first'))).toBe(false)
    expect(
      lines.every(
        (l) => l.endsWith(line) || ['one', 'two', 'three'].some((b) => l.endsWith(` ${b}`))
      )
    ).toBe(true)
  })
})
