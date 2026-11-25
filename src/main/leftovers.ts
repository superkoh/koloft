import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ProcessTable } from './processTable'

export const ADOPTED_BY_LAUNCHD = 1

export function orphansByLaunchd(table: ProcessTable | null): Map<number, string> {
  return new Map(
    (table?.rows ?? [])
      .filter((row) => row.ppid === ADOPTED_BY_LAUNCHD)
      .map((row) => [row.pid, row.command])
  )
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// PLATFORM§3
export const SHORT_TMP_DIR = process.platform === 'darwin' ? '/tmp' : os.tmpdir()
export const MACOS_PID_AT_MOST_FIVE_DIGITS = '\\d{1,5}'
const OPEN_SHIM_TOKEN = `(${MACOS_PID_AT_MOST_FIVE_DIGITS})-[0-9a-f-]{36}$`
export const OPEN_SHIM_FOLDER = new RegExp(`^${OPEN_SHIM_TOKEN}`)
export const OPEN_REQUEST_FOLDER = new RegExp(`^koloft-cx-open-${OPEN_SHIM_TOKEN}`)

export const ownedByThisRun = (name: string): string => `${process.pid}-${name}`

export function removeFoldersLeftByEndedRuns(dir: string, ours: RegExp): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const owner = ours.exec(name)?.[1]
    if (owner && !pidAlive(Number(owner)))
      fs.rmSync(path.join(dir, name), { recursive: true, force: true })
  }
}
