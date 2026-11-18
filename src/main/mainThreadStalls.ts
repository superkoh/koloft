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
const BEATS_PER_STUCK_LIMIT = 5
export const THE_WHOLE_PROCESS_WAS_PAUSED_IF_THE_WATCH_WOKE_LATE_BY_MS = 2000

export interface StuckWatchDeps {
  stuckAfterMs: number
  now(): number
  beats(): number
  beatAfter(seen: number, withinMs?: number): boolean
  stuck(): void
  resumed(afterMs: number): void
}

// PLATFORM§70
export function watchOneBeat(d: StuckWatchDeps): void {
  const seen = d.beats()
  const from = d.now()
  if (d.beatAfter(seen, d.stuckAfterMs)) return
  const wokeLateByMs = d.now() - from - d.stuckAfterMs
  if (wokeLateByMs >= THE_WHOLE_PROCESS_WAS_PAUSED_IF_THE_WATCH_WOKE_LATE_BY_MS) return
  d.stuck()
  d.beatAfter(seen)
  d.resumed(d.now() - from)
}

export interface StuckWatchData {
  beats: SharedArrayBuffer
  pid: number
  log: string
  samplesDir: string
  stuckAfterMs: number
}

// PLATFORM§70
export function beatForTheStuckWatch(
  startWatch: (data: StuckWatchData) => { unref(): void },
  data: Omit<StuckWatchData, 'beats'>
): void {
  const beats = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const beat = new Int32Array(beats)
  startWatch({ ...data, beats }).unref()
  setInterval(() => {
    Atomics.add(beat, 0, 1)
    Atomics.notify(beat, 0)
  }, data.stuckAfterMs / BEATS_PER_STUCK_LIMIT).unref()
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
