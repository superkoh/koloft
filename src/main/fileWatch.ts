import fs from 'fs'
import path from 'path'
import { AGY_LOGS_FOLDER } from '@shared/agyBrain'
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

export type DirChangeListener = (root: string, changedDirs?: string[]) => void

interface DirWatch {
  watcher: fs.FSWatcher
  count: number
  timer: ReturnType<typeof setTimeout> | null
  changed: Set<string> | null
}
const dirWatchers = new Map<string, DirWatch>()
const DIR_CHANGE_DEBOUNCE_MS = 300

function watchIgnored(filename: string | Buffer | null): boolean {
  if (!filename) return false
  const rel = typeof filename === 'string' ? filename : filename.toString()
  // AGY§8
  return !passesHeavy(rel) || rel.split(path.sep).includes(AGY_LOGS_FOLDER)
}

function closeWatcher(entry: DirWatch): void {
  if (entry.timer) clearTimeout(entry.timer)
  try {
    entry.watcher.close()
  } catch {}
}

function noteChange(root: string, entry: DirWatch, filename: string | Buffer | null): void {
  if (!entry.changed) return
  const rel = filename === null ? '' : filename.toString()
  if (!rel || path.basename(rel) === '.gitignore') {
    entry.changed = null
    return
  }
  const full = path.join(root, rel)
  entry.changed.add(full)
  entry.changed.add(path.dirname(full))
}

function attachWatcher(root: string, entry: DirWatch, onChange: DirChangeListener): void {
  entry.watcher.on('change', (_event, filename) => {
    if (watchIgnored(filename)) return
    noteChange(root, entry, filename)
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      const changed = entry.changed
      entry.changed = new Set()
      onChange(root, changed ? [...changed] : undefined)
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

export function watchDir(root: string, onChange: DirChangeListener): boolean {
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
  const entry: DirWatch = { watcher, count: 1, timer: null, changed: new Set() }
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
