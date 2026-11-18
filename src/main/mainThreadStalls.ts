export const LOOK_EVERY_MS = 25
export const LOGGED_ONCE_A_LOOK_COMES_LATE_BY_MS = 50

export interface StallWatchDeps {
  log(line: string): void
  now(): number
  cpuMs(): number
}

// PLATFORM§70
export class StallWatch {
  private lastAt: number
  private lastCpu: number

  constructor(private readonly d: StallWatchDeps) {
    this.lastAt = d.now()
    this.lastCpu = d.cpuMs()
  }

  look(): void {
    const at = this.d.now()
    const cpu = this.d.cpuMs()
    const gap = at - this.lastAt
    if (gap - LOOK_EVERY_MS >= LOGGED_ONCE_A_LOOK_COMES_LATE_BY_MS)
      this.d.log(
        `main thread took no new work in the ${Math.round(gap)} ms before this line, and was on the CPU for ${Math.round(cpu - this.lastCpu)} ms of them`
      )
    this.lastAt = at
    this.lastCpu = cpu
  }
}

export const STUCK_AFTER_MS = 5000

export interface StuckWatchData {
  beats: SharedArrayBuffer
  pid: number
  samplesDir: string
  stuckAfterMs: number
}

export type AskedForABeatAt = number
export type WhatTheMainThreadWasIn = string

interface StuckWatch {
  on(event: 'message', listener: (said: AskedForABeatAt | WhatTheMainThreadWasIn) => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
  unref(): void
}

// PLATFORM§70
export function answerTheStuckWatch(
  startWatch: (data: StuckWatchData) => StuckWatch,
  data: Omit<StuckWatchData, 'beats'>,
  log: (line: string) => void
): void {
  const beats = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const beat = new Int32Array(beats)
  let theLastAskWaitedMs = 0
  const watch = startWatch({ ...data, beats })
  watch.on('message', (said: AskedForABeatAt | WhatTheMainThreadWasIn) => {
    if (typeof said === 'number') {
      theLastAskWaitedMs = Date.now() - said
      Atomics.add(beat, 0, 1)
      Atomics.notify(beat, 0)
      return
    }
    log(
      `main thread took no new work for at least ${theLastAskWaitedMs} ms; what it was in ${data.stuckAfterMs} ms into that: ${said}`
    )
  })
  watch.on('error', (error) => log(`the watch for a stuck main thread stopped: ${error}`))
  watch.unref()
}

function mainThreadCpuMs(): number {
  const { user, system } = process.threadCpuUsage()
  return (user + system) / 1000
}

// PLATFORM§70
export class StallWatchWhileFocused {
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly log: (line: string) => void) {}

  follow(aWindowHasFocus: boolean): void {
    if (!aWindowHasFocus) {
      clearInterval(this.timer)
      this.timer = undefined
      return
    }
    if (this.timer) return
    const watch = new StallWatch({
      log: this.log,
      now: () => performance.now(),
      cpuMs: mainThreadCpuMs
    })
    this.timer = setInterval(() => watch.look(), LOOK_EVERY_MS)
  }
}
