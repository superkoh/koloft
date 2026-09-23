import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'

const REGISTRY_DIR = path.join(os.homedir(), '.claude', 'sessions')

// CC§11
function processStartUtc(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { env: { ...process.env, TZ: 'UTC' }, timeout: 3000 },
      (err, stdout) => resolve(err ? null : stdout.trim() || null)
    )
  })
}

const sameStart = (a: string, b: string): boolean =>
  a.replace(/\s+/g, ' ') === b.replace(/\s+/g, ' ')

// CC§11
export async function runningClaudePid(
  sessionId: string,
  dir = REGISTRY_DIR,
  startOf = processStartUtc
): Promise<number | null> {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    let entry: { pid?: unknown; sessionId?: unknown; procStart?: unknown }
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
    } catch {
      continue
    }
    if (entry.sessionId !== sessionId) continue
    if (typeof entry.pid !== 'number' || typeof entry.procStart !== 'string') continue
    const started = await startOf(entry.pid)
    if (started && sameStart(started, entry.procStart)) return entry.pid
  }
  return null
}
