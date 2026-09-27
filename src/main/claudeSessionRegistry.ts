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

interface RegistryEntry {
  pid: number
  procStart: string
  name?: string
}

// CC§11
function readRegistry(dir: string): Map<string, RegistryEntry[]> {
  const bySession = new Map<string, RegistryEntry[]>()
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return bySession
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    let entry: { pid?: unknown; sessionId?: unknown; procStart?: unknown; name?: unknown }
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
    } catch {
      continue
    }
    if (typeof entry.sessionId !== 'string') continue
    if (typeof entry.pid !== 'number' || typeof entry.procStart !== 'string') continue
    const entries = bySession.get(entry.sessionId) ?? []
    entries.push({
      pid: entry.pid,
      procStart: entry.procStart,
      name: typeof entry.name === 'string' && entry.name ? entry.name : undefined
    })
    bySession.set(entry.sessionId, entries)
  }
  return bySession
}

// CC§11
async function liveEntry(
  entries: RegistryEntry[] | undefined,
  startOf: typeof processStartUtc
): Promise<RegistryEntry | null> {
  for (const entry of entries ?? []) {
    const started = await startOf(entry.pid)
    if (started && sameStart(started, entry.procStart)) return entry
  }
  return null
}

export async function runningClaudePid(
  sessionId: string,
  dir = REGISTRY_DIR,
  startOf = processStartUtc
): Promise<number | null> {
  return (await liveEntry(readRegistry(dir).get(sessionId), startOf))?.pid ?? null
}

export function claudePeerNames(
  dir = REGISTRY_DIR,
  startOf = processStartUtc
): (sessionId: string) => Promise<string | null> {
  const registry = readRegistry(dir)
  return async (sessionId) => (await liveEntry(registry.get(sessionId), startOf))?.name ?? null
}
