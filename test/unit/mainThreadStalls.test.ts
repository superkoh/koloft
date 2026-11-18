import { describe, expect, it } from 'vitest'
import {
  LOOK_EVERY_MS,
  StallWatch,
  THE_WHOLE_PROCESS_WAS_PAUSED_IF_THE_WATCH_WOKE_LATE_BY_MS,
  watchOneBeat
} from '../../src/main/mainThreadStalls'

const STUCK_AFTER_MS = 5000

function stuckWatch(beatComesAfterMs: number, watchWakesLateByMs = 0): string[] {
  const said: string[] = []
  let now = 0
  watchOneBeat({
    stuckAfterMs: STUCK_AFTER_MS,
    now: () => now,
    beats: () => 7,
    beatAfter: (seen, withinMs) => {
      expect(seen).toBe(7)
      const waited = withinMs === undefined ? beatComesAfterMs - now : withinMs
      const cameInTime = now + waited >= beatComesAfterMs
      now = cameInTime ? beatComesAfterMs : now + waited + watchWakesLateByMs
      return cameInTime
    },
    stuck: () => said.push(`stuck at ${now}`),
    resumed: (afterMs) => said.push(`resumed after ${afterMs}`)
  })
  return said
}

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

describe('the watch that speaks while the main thread is still stuck', () => {
  it('says nothing while the main thread keeps beating', () => {
    expect(stuckWatch(STUCK_AFTER_MS - 1)).toEqual([])
  })

  it('says the main thread is stuck as soon as no beat came for the limit, not once it is back, and then how long it was gone', () => {
    const SEVEN_HOURS_MS = 7 * 3600_000
    expect(stuckWatch(SEVEN_HOURS_MS)).toEqual([
      `stuck at ${STUCK_AFTER_MS}`,
      `resumed after ${SEVEN_HOURS_MS}`
    ])
  })

  it('says nothing when the watch itself woke late, as after the Mac slept: then the whole process was paused, not the main thread stuck', () => {
    expect(stuckWatch(3600_000, THE_WHOLE_PROCESS_WAS_PAUSED_IF_THE_WATCH_WOKE_LATE_BY_MS)).toEqual(
      []
    )
  })
})
