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
        `main thread took no new work for ${Math.round(gap)} ms, on the CPU for ${Math.round(cpu - this.lastCpu)} ms of it`
      )
    this.lastAt = at
    this.lastCpu = cpu
  }
}

function mainThreadCpuMs(): number {
  const { user, system } = process.threadCpuUsage()
  return (user + system) / 1000
}

export function watchMainThreadStalls(log: (line: string) => void): void {
  const watch = new StallWatch({ log, now: () => performance.now(), cpuMs: mainThreadCpuMs })
  setInterval(() => watch.look(), LOOK_EVERY_MS).unref()
}
