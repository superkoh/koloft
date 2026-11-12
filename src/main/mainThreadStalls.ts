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

function mainThreadCpuMs(): number {
  const { user, system } = process.threadCpuUsage()
  return (user + system) / 1000
}

// PLATFORM§70
export class StallWatchWhileFocused {
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly log: (line: string) => void) {}

  focused(): void {
    if (this.timer) return
    const watch = new StallWatch({
      log: this.log,
      now: () => performance.now(),
      cpuMs: mainThreadCpuMs
    })
    this.timer = setInterval(() => watch.look(), LOOK_EVERY_MS)
  }

  blurred(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }
}
