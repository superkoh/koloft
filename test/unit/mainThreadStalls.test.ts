import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOOK_EVERY_MS,
  StallWatch,
  answerTheStuckWatch,
  type StuckWatchData
} from '../../src/main/mainThreadStalls'

function watch(): { lines: string[]; after(ms: number, cpuMs: number): void } {
  const lines: string[] = []
  let now = 0
  let cpu = 0
  const w = new StallWatch({ log: (l) => lines.push(l), now: () => now, cpuMs: () => cpu })
  return {
    lines,
    after: (ms, cpuMs) => {
      now += ms
      cpu += cpuMs
      w.look()
    }
  }
}

describe('the main-thread stall log', () => {
  it('logs a look that came 50 ms or more late, with how long the thread was gone and how much of it was on the CPU', () => {
    const w = watch()
    w.after(LOOK_EVERY_MS, 1)
    w.after(LOOK_EVERY_MS + 49, 0)
    expect(w.lines).toEqual([])
    w.after(212, 197)
    w.after(LOOK_EVERY_MS + 200, 0.4)
    expect(w.lines).toHaveLength(2)
    expect(w.lines[0]).toMatch(/\b212 ms\b.*\b197 ms\b/)
    expect(w.lines[1]).toMatch(/\b225 ms\b.*\b0 ms\b/)
  })
})

describe('the main thread answering the watch that looks for it being stuck', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers each ask with a beat, and once the watch names the sample it saved, logs that sample with how long the ask just before it had to wait: not the time the sample took, and not an older ask that waited through a sleep', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const fromTheWatch = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const lines: string[] = []
    let given!: StuckWatchData
    answerTheStuckWatch(
      (data) => {
        given = data
        return fromTheWatch
      },
      { pid: 1, samplesDir: '/samples', stuckAfterMs: 5000 },
      (line) => lines.push(line)
    )
    const beats = (): number => Atomics.load(new Int32Array(given.beats), 0)

    fromTheWatch.emit('message', Date.now() - 3)
    expect(beats()).toBe(1)
    const SEVEN_HOURS_MS = 7 * 3600_000
    fromTheWatch.emit('message', Date.now() - SEVEN_HOURS_MS)
    expect(beats()).toBe(2)
    expect(lines).toEqual([])

    vi.advanceTimersByTime(2000)
    fromTheWatch.emit('message', '/samples/one.txt')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`${SEVEN_HOURS_MS} ms`)
    expect(lines[0]).toContain('/samples/one.txt')

    const ASLEEP_FOR_MS = 8 * 3600_000
    fromTheWatch.emit('message', Date.now() - ASLEEP_FOR_MS)
    fromTheWatch.emit('message', Date.now() - 2)
    fromTheWatch.emit('message', Date.now() - 6000)
    fromTheWatch.emit('message', '/samples/two.txt')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain(' 6000 ms')
    expect(lines[1]).toContain('/samples/two.txt')
  })
})
