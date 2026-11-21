import fs from 'fs'
import os from 'os'

const BOOT_CLOCK_SLACK_S = 5

function bootSecond(): number {
  return Math.round(Date.now() / 1000 - os.uptime())
}

function holder(file: string): { pid: number; boot: number } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown; boot?: unknown }
    return typeof raw.pid === 'number' && typeof raw.boot === 'number'
      ? { pid: raw.pid, boot: raw.boot }
      : null
  } catch {
    return null
  }
}

// ADR-0004
export function takeLock(file: string, alive: (pid: number) => boolean): boolean {
  const mine = JSON.stringify({ pid: process.pid, boot: bootSecond() })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, mine, { flag: 'wx' })
      return true
    } catch {
      const h = holder(file)
      if (h && Math.abs(h.boot - bootSecond()) <= BOOT_CLOCK_SLACK_S) {
        if (h.pid === process.pid) return true
        if (alive(h.pid)) return false
      }
      fs.rmSync(file, { force: true })
    }
  }
  return false
}

export function releaseLock(file: string): void {
  if (holder(file)?.pid === process.pid) fs.rmSync(file, { force: true })
}
