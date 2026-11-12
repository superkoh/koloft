import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MachineRoom, signalLog, signalLogOffTheMainThread } from '../../src/main/machineRoom'

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

  it.each([
    ['written at once', signalLog],
    ['written off the main thread', signalLogOffTheMainThread]
  ])(
    '%s, it keeps whole timestamped lines in the order written, and never grows past two megabytes',
    async (_how, make) => {
      const file = path.join(dir, 'machine.log')
      const write = make(file)
      const log = async (line: string): Promise<void> => write(line)
      await log('first')
      expect(fs.readFileSync(file, 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z first\n$/)
      const line = 'x'.repeat(1000)
      let last = Promise.resolve()
      for (let i = 0; i < 2200; i++) last = log(`${i} ${line}`)
      await last
      const text = fs.readFileSync(file, 'utf8')
      expect(text.length).toBeLessThanOrEqual(2 * 2 ** 20)
      expect(text).not.toContain('first')
      const kept = text.split('\n').filter(Boolean)
      expect(kept.every((l) => l.endsWith(line))).toBe(true)
      const numbers = kept.map((l) => Number(l.split(' ')[1]))
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
      expect(numbers.at(-1)).toBe(2199)
    }
  )
})
