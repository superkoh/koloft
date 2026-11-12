import { describe, expect, it } from 'vitest'
import { LOOK_EVERY_MS, StallWatch } from '../../src/main/mainThreadStalls'

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
