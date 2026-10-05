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
  messagingSocketPath?: string
  status?: string
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
    let entry: {
      pid?: unknown
      sessionId?: unknown
      procStart?: unknown
      name?: unknown
      messagingSocketPath?: unknown
      status?: unknown
    }
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
      name: typeof entry.name === 'string' && entry.name ? entry.name : undefined,
      messagingSocketPath:
        typeof entry.messagingSocketPath === 'string' && entry.messagingSocketPath
          ? entry.messagingSocketPath
          : undefined,
      status: typeof entry.status === 'string' ? entry.status : undefined
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

export async function messagingSocketOf(
  sessionId: string,
  dir = REGISTRY_DIR,
  startOf = processStartUtc
): Promise<string | null> {
  return (await liveEntry(readRegistry(dir).get(sessionId), startOf))?.messagingSocketPath ?? null
}

// CC§11
export async function claudeShowsAPanel(
  sessionId: string,
  dir = REGISTRY_DIR,
  startOf = processStartUtc
): Promise<boolean | undefined> {
  const status = (await liveEntry(readRegistry(dir).get(sessionId), startOf))?.status
  return status === undefined ? undefined : status === 'waiting'
}

export function whenMessagingSocket(
  sessionId: string,
  ms: number,
  dir = REGISTRY_DIR,
  startOf = processStartUtc
): Promise<string | null> {
  return new Promise((resolve) => {
    let watcher: fs.FSWatcher | undefined
    let settled = false
    const settle = (socket: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      watcher?.close()
      resolve(socket)
    }
    const check = (): void =>
      void messagingSocketOf(sessionId, dir, startOf).then((socket) => socket && settle(socket))
    const deadline = setTimeout(
      () => void messagingSocketOf(sessionId, dir, startOf).then(settle),
      Math.max(0, ms)
    )
    try {
      watcher = fs.watch(dir, check)
    } catch {}
    check()
  })
}

export function claudePeerNames(
  dir = REGISTRY_DIR,
  startOf = processStartUtc
): (sessionId: string) => Promise<string | null> {
  const registry = readRegistry(dir)
  return async (sessionId) => (await liveEntry(registry.get(sessionId), startOf))?.name ?? null
}
