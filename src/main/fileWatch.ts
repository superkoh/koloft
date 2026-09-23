import fs from 'fs'
import { passesHeavy } from './fileTree'

// PLATFORM§28
const POLL_INTERVAL = 500

type StatsListener = (curr: fs.Stats, prev: fs.Stats) => void

interface Entry {
  count: number
  listener: StatsListener
}

const entries = new Map<string, Entry>()

export function watchFile(p: string, onChange: (p: string, curr: fs.Stats) => void): void {
  const existing = entries.get(p)
  if (existing) {
    existing.count++
    return
  }
  const listener: StatsListener = (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) onChange(p, curr)
  }
  fs.watchFile(p, { interval: POLL_INTERVAL }, listener)
  entries.set(p, { count: 1, listener })
}

export function unwatchFile(p: string): void {
  const e = entries.get(p)
  if (!e) return
  if (--e.count <= 0) {
    // PLATFORM§28
    fs.unwatchFile(p, e.listener)
    entries.delete(p)
  }
}

export function closeAllFileWatchers(): void {
  for (const [p, e] of entries) fs.unwatchFile(p, e.listener)
  entries.clear()
}

interface DirWatch {
  watcher: fs.FSWatcher
  count: number
  timer: ReturnType<typeof setTimeout> | null
}
const dirWatchers = new Map<string, DirWatch>()
const DIR_CHANGE_DEBOUNCE_MS = 300

function watchIgnored(filename: string | Buffer | null): boolean {
  if (!filename) return false
  return !passesHeavy(typeof filename === 'string' ? filename : filename.toString())
}

function closeWatcher(entry: DirWatch): void {
  if (entry.timer) clearTimeout(entry.timer)
  try {
    entry.watcher.close()
  } catch {}
}

function attachWatcher(root: string, entry: DirWatch, onChange: (root: string) => void): void {
  entry.watcher.on('change', (_event, filename) => {
    if (watchIgnored(filename)) return
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      onChange(root)
    }, DIR_CHANGE_DEBOUNCE_MS)
  })
  entry.watcher.on('error', () => {
    try {
      entry.watcher.close()
    } catch {}
    try {
      entry.watcher = fs.watch(root, { recursive: true })
      attachWatcher(root, entry, onChange)
    } catch {
      if (entry.timer) clearTimeout(entry.timer)
      dirWatchers.delete(root)
    }
  })
}

export function watchDir(root: string, onChange: (root: string) => void): boolean {
  const existing = dirWatchers.get(root)
  if (existing) {
    existing.count++
    return true
  }
  let watcher: fs.FSWatcher
  try {
    watcher = fs.watch(root, { recursive: true })
  } catch {
    return false
  }
  const entry: DirWatch = { watcher, count: 1, timer: null }
  attachWatcher(root, entry, onChange)
  dirWatchers.set(root, entry)
  return true
}

export function unwatchDir(root: string): void {
  const entry = dirWatchers.get(root)
  if (!entry) return
  if (--entry.count <= 0) {
    closeWatcher(entry)
    dirWatchers.delete(root)
  }
}

export function closeAllDirWatchers(): void {
  for (const entry of dirWatchers.values()) closeWatcher(entry)
  dirWatchers.clear()
}
