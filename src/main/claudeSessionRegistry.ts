import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { setTimeout as sleep } from 'timers/promises'

const REGISTRY_DIR = path.join(os.homedir(), '.claude', 'sessions')
const POLL_WHILE_THE_REGISTRY_FOLDER_IS_MISSING_MS = 500
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

function liveEntryOf(
  sessionId: string,
  dir: string,
  startOf: typeof processStartUtc
): Promise<RegistryEntry | null> {
  return liveEntry(readRegistry(dir).get(sessionId), startOf)
}

export async function runningClaudePid(
  sessionId: string,
  dir = REGISTRY_DIR,
  startOf = processStartUtc
): Promise<number | null> {
  return (await liveEntryOf(sessionId, dir, startOf))?.pid ?? null
}

export async function messagingSocketOf(
  sessionId: string,
  dir = REGISTRY_DIR,
  startOf = processStartUtc
): Promise<string | null> {
  return (await liveEntryOf(sessionId, dir, startOf))?.messagingSocketPath ?? null
}

// CC§11
export async function claudeShowsAPanel(
  sessionId: string,
  dir = REGISTRY_DIR,
  startOf = processStartUtc
): Promise<boolean | undefined> {
  const status = (await liveEntryOf(sessionId, dir, startOf))?.status
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
    let poll: ReturnType<typeof setInterval> | undefined
    let settled = false
    const settle = (socket: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearInterval(poll)
      watcher?.close()
      resolve(socket)
    }
    const check = (): void =>
      void messagingSocketOf(sessionId, dir, startOf).then((socket) => socket && settle(socket))
    const deadline = setTimeout(
      () => void messagingSocketOf(sessionId, dir, startOf).then(settle),
      Math.max(0, ms)
    )
    const watch = (): void => {
      try {
        watcher = fs.watch(dir, check)
        clearInterval(poll)
      } catch {}
    }
    watch()
    if (!watcher)
      poll = setInterval(() => {
        watch()
        check()
      }, POLL_WHILE_THE_REGISTRY_FOLDER_IS_MISSING_MS)
    check()
  })
}

// CC§11
export const LIVE_REGISTRY_ON_A_MACHINE_SH = `for f in "$HOME"/.claude/sessions/*.json; do p=\${f##*/}; kill -0 "\${p%.json}" 2>/dev/null && cat "$f" && printf '\\0'; done; :`

interface EntryOnMachine {
  sessionId?: unknown
  kind?: unknown
  messagingSocketPath?: unknown
  status?: unknown
}

// CC§5 CC§11
function tabEntriesOnMachine(liveRegistry: string, sessionId: string): EntryOnMachine[] {
  return liveRegistry.split('\0').flatMap((text) => {
    let entry: EntryOnMachine
    try {
      entry = JSON.parse(text)
    } catch {
      return []
    }
    return entry.sessionId === sessionId && entry.kind !== 'bg' ? [entry] : []
  })
}

export function tabSocketOnMachine(liveRegistry: string, sessionId: string): string | null {
  for (const { messagingSocketPath } of tabEntriesOnMachine(liveRegistry, sessionId))
    if (typeof messagingSocketPath === 'string' && messagingSocketPath) return messagingSocketPath
  return null
}

// CC§11
export function claudeShowsAPanelOnMachine(
  liveRegistry: string,
  sessionId: string
): boolean | undefined {
  const status = tabEntriesOnMachine(liveRegistry, sessionId).find(
    (entry) => typeof entry.status === 'string'
  )?.status
  return status === undefined ? undefined : status === 'waiting'
}

const REGISTRY_ON_A_MACHINE_IS_READ_AGAIN_AFTER_MS = 1000

export async function whenMessagingSocketOnMachine(
  sessionId: string,
  ms: number,
  readLiveRegistry: () => Promise<string>
): Promise<string | null> {
  const deadline = Date.now() + ms
  for (;;) {
    const socket = tabSocketOnMachine(await readLiveRegistry(), sessionId)
    if (socket || Date.now() >= deadline) return socket
    await sleep(REGISTRY_ON_A_MACHINE_IS_READ_AGAIN_AFTER_MS)
  }
}

export function claudePeerNames(
  dir = REGISTRY_DIR,
  startOf = processStartUtc
): (sessionId: string) => Promise<string | null> {
  const registry = readRegistry(dir)
  return async (sessionId) => (await liveEntry(registry.get(sessionId), startOf))?.name ?? null
}
