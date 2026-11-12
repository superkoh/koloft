import fs from 'fs'
import path from 'path'
import { AGY_LOGS_FOLDER } from '@shared/agyBrain'
import type { DirChangeListener, DirChanges } from '@shared/types'
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
  changed: Set<string> | null
  folderId: string
  changedWithNoViewer: boolean
}
const dirWatchers = new Map<string, DirWatch>()
const DIR_CHANGE_DEBOUNCE_MS = 300
const CHANGED_PATHS_PAST_WHICH_EVERY_OPEN_FOLDER_RELISTS = 500

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

// PLATFORM§28
function noteChange(root: string, entry: DirWatch, filename: string | Buffer | null): void {
  if (!entry.changed) return
  const rel = filename?.toString()
  if (!rel || entry.changed.size >= CHANGED_PATHS_PAST_WHICH_EVERY_OPEN_FOLDER_RELISTS) {
    entry.changed = null
    return
  }
  const full = path.join(root, rel)
  entry.changed.add(path.basename(rel) === '.gitignore' ? path.dirname(full) : full)
}

function changesOf(changedPaths: Set<string>): DirChanges {
  const paths = [...changedPaths]
  return { listsChanged: [...new Set(paths.map((p) => path.dirname(p)))], replacedTrees: paths }
}

// PLATFORM§69
const FOLDERS_KEPT_WATCHED_AFTER_THEIR_LAST_VIEWER_LEFT = 8
const keptWithNoViewerOldestFirst: string[] = []

function noLongerKept(root: string): void {
  const kept = keptWithNoViewerOldestFirst.indexOf(root)
  if (kept !== -1) keptWithNoViewerOldestFirst.splice(kept, 1)
}

function forget(root: string, entry: DirWatch): void {
  closeWatcher(entry)
  dirWatchers.delete(root)
  noLongerKept(root)
}

// PLATFORM§69
async function folderIdOf(root: string): Promise<string | undefined> {
  try {
    const st = await fs.promises.stat(root)
    return `${st.dev}:${st.ino}`
  } catch {
    return undefined
  }
}

const stepsOfAFolder = new Map<string, Promise<unknown>>()

function inOrderFor<T>(root: string, step: () => T | Promise<T>): Promise<T> {
  const run = (stepsOfAFolder.get(root) ?? Promise.resolve()).then(step)
  const settled = run.catch(() => undefined)
  stepsOfAFolder.set(root, settled)
  void settled.then(() => {
    if (stepsOfAFolder.get(root) === settled) stepsOfAFolder.delete(root)
  })
  return run
}

function reportSoon(root: string, entry: DirWatch, onChange: DirChangeListener): void {
  if (entry.timer) return
  entry.timer = setTimeout(() => {
    entry.timer = null
    const changed = entry.changed
    entry.changed = new Set()
    onChange(root, changed ? changesOf(changed) : undefined)
  }, DIR_CHANGE_DEBOUNCE_MS)
}

function attachWatcher(root: string, entry: DirWatch, onChange: DirChangeListener): void {
  entry.watcher.on('change', (_event, filename) => {
    if (watchIgnored(filename)) return
    if (entry.count === 0) {
      entry.changedWithNoViewer = true
      return
    }
    noteChange(root, entry, filename)
    reportSoon(root, entry, onChange)
  })
  entry.watcher.on('error', () => {
    if (entry.count === 0) {
      forget(root, entry)
      return
    }
    entry.changed = null
    try {
      entry.watcher.close()
    } catch {}
    try {
      entry.watcher = fs.watch(root, { recursive: true })
      void folderIdOf(root).then((id) => (entry.folderId = id ?? entry.folderId))
      attachWatcher(root, entry, onChange)
    } catch {
      if (entry.timer) clearTimeout(entry.timer)
      dirWatchers.delete(root)
    }
  })
}

export function watchDir(root: string, onChange: DirChangeListener): Promise<boolean> {
  return inOrderFor(root, () => watchDirNow(root, onChange))
}

async function watchDirNow(root: string, onChange: DirChangeListener): Promise<boolean> {
  const watched = dirWatchers.get(root)
  if (watched && watched.count > 0) {
    watched.count++
    return true
  }
  const folderId = await folderIdOf(root)
  const kept = dirWatchers.get(root)
  if (kept && folderId !== kept.folderId) forget(root, kept)
  else if (kept) {
    noLongerKept(root)
    kept.changed = kept.changedWithNoViewer ? null : new Set()
    if (kept.changedWithNoViewer) reportSoon(root, kept, onChange)
    kept.changedWithNoViewer = false
    kept.count++
    return true
  }
  if (folderId === undefined) return false
  let watcher: fs.FSWatcher
  try {
    watcher = fs.watch(root, { recursive: true })
  } catch {
    return false
  }
  const entry: DirWatch = {
    watcher,
    count: 1,
    timer: null,
    changed: new Set(),
    folderId,
    changedWithNoViewer: false
  }
  attachWatcher(root, entry, onChange)
  dirWatchers.set(root, entry)
  return true
}

export function unwatchDir(root: string): void {
  void inOrderFor(root, () => unwatchDirNow(root))
}

function unwatchDirNow(root: string): void {
  const entry = dirWatchers.get(root)
  if (!entry) return
  if (entry.count === 0 || --entry.count > 0) return
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.changedWithNoViewer = true
  }
  entry.timer = null
  keptWithNoViewerOldestFirst.push(root)
  while (keptWithNoViewerOldestFirst.length > FOLDERS_KEPT_WATCHED_AFTER_THEIR_LAST_VIEWER_LEFT) {
    const oldest = keptWithNoViewerOldestFirst[0]
    const kept = dirWatchers.get(oldest)
    if (kept) forget(oldest, kept)
    else keptWithNoViewerOldestFirst.shift()
  }
}

export function closeAllDirWatchers(): void {
  for (const entry of dirWatchers.values()) closeWatcher(entry)
  dirWatchers.clear()
  keptWithNoViewerOldestFirst.length = 0
}
