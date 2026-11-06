import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'

export interface MachineReading {
  pressure: number | null
  load1: number
  backgroundWork?: boolean
}

export const READ_THE_MACHINE_EVERY_MS = 5_000
export const BUSY_AT_LOAD_PER_CORE = 3
const ROOMY_BELOW_LOAD_PER_CORE = 2
const LOAD_STAYS_HIGH_MS_BEFORE_BUSY = 30_000
const CALM_MS_BEFORE_ROOMY = 60_000
// PLATFORM§59
export const MEMORY_PRESSURE_WARNING = 2
export const GAP_AFTER_A_COMMAND_MS = 30_000
const SIGNAL_LINE_EVERY_MS = 60_000

export const BUSY_MARKER = 'machine-busy'
export const RELEASE_AFTER_FILE = 'release-after'

export interface MachineRoomDeps {
  regDir: string
  cores: number
  read(): Promise<MachineReading>
  now(): number
  log(line: string): void
}

export class MachineRoom {
  private busyNow = false
  private loadHighSince: number | undefined
  private calmSince: number | undefined
  private lastSignalLine = 0
  private ourWorkRunning = false
  private marked = false
  lastReading: MachineReading = { pressure: null, load1: 0 }

  constructor(private d: MachineRoomDeps) {
    fs.rmSync(this.marker(), { force: true })
  }

  get busy(): boolean {
    return this.busyNow
  }

  get holding(): boolean {
    return this.busyNow && this.ourWorkRunning
  }

  backgroundWorkRunning(running: boolean): void {
    this.ourWorkRunning = running
    this.syncMarker()
  }

  async tick(): Promise<void> {
    this.observe(await this.d.read())
  }

  observe(r: MachineReading): void {
    this.lastReading = r
    const now = this.d.now()
    const memoryTight = r.pressure !== null && r.pressure >= MEMORY_PRESSURE_WARNING
    const loadHigh = r.load1 >= BUSY_AT_LOAD_PER_CORE * this.d.cores
    const loadCalm = r.load1 < ROOMY_BELOW_LOAD_PER_CORE * this.d.cores
    this.loadHighSince = loadHigh ? (this.loadHighSince ?? now) : undefined
    const calm = !memoryTight && loadCalm
    this.calmSince = calm ? (this.calmSince ?? now) : undefined
    const wasBusy = this.busyNow
    if (!wasBusy) {
      const loadLongHigh =
        this.loadHighSince !== undefined &&
        now - this.loadHighSince >= LOAD_STAYS_HIGH_MS_BEFORE_BUSY
      if (memoryTight || loadLongHigh) this.busyNow = true
    } else if (this.calmSince !== undefined && now - this.calmSince >= CALM_MS_BEFORE_ROOMY) {
      this.busyNow = false
    }
    this.syncMarker()
    if (this.busyNow !== wasBusy || now - this.lastSignalLine >= SIGNAL_LINE_EVERY_MS) {
      this.lastSignalLine = now
      this.d.log(
        `[koloft] machine: ${this.busyNow ? 'busy' : 'roomy'} · memory pressure ${r.pressure ?? '-'} · load ${r.load1.toFixed(1)} on ${this.d.cores} cores`
      )
    }
  }

  private syncMarker(): void {
    if (this.holding === this.marked) return
    this.marked = this.holding
    if (this.marked) fs.writeFileSync(this.marker(), '')
    else fs.rmSync(this.marker(), { force: true })
  }

  private marker(): string {
    return path.join(this.d.regDir, BUSY_MARKER)
  }
}

const SIGNAL_LOG_MAX_BYTES = 2 * 2 ** 20
const SIGNAL_LOG_KEEPS_BYTES = 2 ** 20

export function signalLog(file: string): (line: string) => void {
  return (line) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
      if (fs.statSync(file).size <= SIGNAL_LOG_MAX_BYTES) return
      const text = fs.readFileSync(file, 'utf8')
      const tail = text.slice(-SIGNAL_LOG_KEEPS_BYTES)
      fs.writeFileSync(file, tail.slice(tail.indexOf('\n') + 1))
    } catch {}
  }
}

// PLATFORM§59
function memoryPressure(): Promise<number | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      'sysctl',
      ['-n', 'kern.memorystatus_vm_pressure_level'],
      { timeout: READ_THE_MACHINE_EVERY_MS },
      (err, stdout) => {
        const level = Number(String(stdout).trim())
        resolve(err || !Number.isFinite(level) ? null : level)
      }
    )
  })
}

export async function readTheMachine(): Promise<MachineReading> {
  const pretend = process.env.KOLOFT_TEST_MACHINE_FILE
  if (pretend) {
    try {
      const j = JSON.parse(fs.readFileSync(pretend, 'utf8')) as Partial<MachineReading>
      return { pressure: j.pressure ?? 1, load1: j.load1 ?? 0, backgroundWork: j.backgroundWork }
    } catch {
      return { pressure: 1, load1: 0 }
    }
  }
  return { pressure: await memoryPressure(), load1: os.loadavg()[0] }
}
