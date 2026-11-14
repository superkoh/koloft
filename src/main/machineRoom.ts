import fs from 'fs'
import { execFile } from 'child_process'

export interface MachineReading {
  pressure: number | null
}

export const READ_THE_MACHINE_EVERY_MS = 5_000
// PLATFORM§59
export const MEMORY_PRESSURE_CRITICAL = 4
const CRITICAL_READINGS_IN_A_ROW_BEFORE_ACTING = 2

export interface MachineRoomDeps {
  read(): Promise<MachineReading>
  log(line: string): void
  memoryStaysCritical?(): void
}

export class MachineRoom {
  private criticalReadingsInARow = 0
  private pressureLogged: number | null | undefined

  constructor(private d: MachineRoomDeps) {}

  get memoryStaysCritical(): boolean {
    return this.criticalReadingsInARow >= CRITICAL_READINGS_IN_A_ROW_BEFORE_ACTING
  }

  async tick(): Promise<void> {
    this.observe(await this.d.read())
  }

  observe(r: MachineReading): void {
    const memoryCritical = r.pressure !== null && r.pressure >= MEMORY_PRESSURE_CRITICAL
    this.criticalReadingsInARow = memoryCritical ? this.criticalReadingsInARow + 1 : 0
    if (r.pressure !== this.pressureLogged) {
      this.pressureLogged = r.pressure
      this.d.log(`[koloft] machine: memory pressure ${r.pressure ?? '-'}`)
    }
    if (this.memoryStaysCritical) this.d.memoryStaysCritical?.()
  }
}

const SIGNAL_LOG_MAX_BYTES = 2 * 2 ** 20
const SIGNAL_LOG_KEEPS_BYTES = 2 ** 20
const NEWLINE = 0x0a

// PLATFORM§69
export function signalLog(file: string): (line: string) => void {
  const waiting: string[] = []
  let waitingLength = 0
  let size: number | undefined
  let writing = false
  const write = async (): Promise<void> => {
    writing = true
    while (waiting.length) {
      const text = waiting.splice(0).join('')
      waitingLength = 0
      try {
        size ??= await fs.promises
          .stat(file)
          .then((s) => s.size)
          .catch(() => 0)
        await fs.promises.appendFile(file, text)
        size += Buffer.byteLength(text)
        if (size <= SIGNAL_LOG_MAX_BYTES) continue
        const tail = (await fs.promises.readFile(file)).subarray(-SIGNAL_LOG_KEEPS_BYTES)
        const kept = tail.subarray(tail.indexOf(NEWLINE) + 1)
        await fs.promises.writeFile(file, kept)
        size = kept.length
      } catch {
        size = undefined
      }
    }
    writing = false
  }
  return (line) => {
    const entry = `${new Date().toISOString()} ${line}\n`
    waiting.push(entry)
    waitingLength += entry.length
    while (waiting.length > 1 && waitingLength > SIGNAL_LOG_KEEPS_BYTES)
      waitingLength -= waiting.shift()!.length
    if (!writing) void write()
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
      return { pressure: j.pressure ?? 1 }
    } catch {
      return { pressure: 1 }
    }
  }
  return { pressure: await memoryPressure() }
}
