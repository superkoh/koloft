import fs from 'fs'
import { passesHeavy } from './fileTree'

// Per-file change watcher behind the preview pane's auto-refresh. fs.watchFile (stat
// polling) rather than fs.watch: it follows the *path*, not the inode, so an editor's
// atomic write-temp-then-rename replacement keeps being observed. Same 500ms cadence
// as the sessionTracker's jsonl polling.
const POLL_INTERVAL = 500

type StatsListener = (curr: fs.Stats, prev: fs.Stats) => void

interface Entry {
  count: number
  listener: StatsListener
}

const entries = new Map<string, Entry>()

/** Start (or ref) watching absolute path `p`. `onChange(p, curr)` fires on any observed
 *  stat change — content writes, deletion (stats zero out) and recreation alike. The
 *  stats come along because the editor's conflict check compares the very fingerprint
 *  (mtime + size) the poll already read. Only the first registration's callback is kept:
 *  every caller passes the same renderer-push closure, so a per-ref callback list would
 *  be dead weight. */
export function watchFile(p: string, onChange: (p: string, curr: fs.Stats) => void): void {
  const existing = entries.get(p)
  if (existing) {
    existing.count++
    return
  }
  const listener: StatsListener = (curr, prev) => {
    // mtime moved, size moved, or existence flipped (a deleted path stats as all-zero)
    if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) onChange(p, curr)
  }
  fs.watchFile(p, { interval: POLL_INTERVAL }, listener)
  entries.set(p, { count: 1, listener })
}

export function unwatchFile(p: string): void {
  const e = entries.get(p)
  if (!e) return
  if (--e.count <= 0) {
    // pass the listener: a bare fs.unwatchFile(p) would also tear down any sibling
    // watch on the same path (the sessionTracker holds its own fs.watchFile listeners)
    fs.unwatchFile(p, e.listener)
    entries.delete(p)
  }
}

/** Renderer hard-reload / window teardown: React effect cleanup never ran, so drop
 *  every watcher here (mirrors closeAllDirWatchers for the dir watchers). */
export function closeAllFileWatchers(): void {
  for (const [p, e] of entries) fs.unwatchFile(p, e.listener)
  entries.clear()
}

// Recursive fs watchers for the file-tree root(s) the renderer is showing. Ref-counted
// by root so a re-mount / StrictMode double-effect can't double-watch; each change is
// coalesced into one debounced `onChange(root)` so an agent editing many files in a
// burst triggers a single refresh, not a storm.
interface DirWatch {
  watcher: fs.FSWatcher
  count: number
  timer: ReturnType<typeof setTimeout> | null
}
const dirWatchers = new Map<string, DirWatch>()

/** true when the changed path is under a dir the tree never shows (the same names
 *  listDir drops — a change under a tracked `build/` must refresh like any other).
 *  Critical: without this, `git status` rewriting `.git/index` would fire the watcher →
 *  renderer refetches git → writes `.git` again → a perpetual ~300ms loop. */
function watchIgnored(filename: string | Buffer | null): boolean {
  if (!filename) return false
  return !passesHeavy(typeof filename === 'string' ? filename : filename.toString())
}

function closeWatcher(entry: DirWatch): void {
  if (entry.timer) clearTimeout(entry.timer)
  try {
    entry.watcher.close()
  } catch {
    /* already closed */
  }
}

function attachWatcher(root: string, entry: DirWatch, onChange: (root: string) => void): void {
  entry.watcher.on('change', (_event, filename) => {
    if (watchIgnored(filename)) return
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      onChange(root)
    }, 300)
  })
  // A transient FSEvents error must not permanently kill live refresh: recreate the
  // watcher in place (preserving the ref count) rather than dropping the entry — the
  // renderer holds the only logical ref and never re-requests the same mount.
  entry.watcher.on('error', () => {
    try {
      entry.watcher.close()
    } catch {
      /* ignore */
    }
    try {
      entry.watcher = fs.watch(root, { recursive: true })
      attachWatcher(root, entry, onChange)
    } catch {
      if (entry.timer) clearTimeout(entry.timer)
      dirWatchers.delete(root)
    }
  })
}

/** Start (or ref) a recursive watch of `root`. Answers false when the watch could not
 *  start (network mount, EMFILE, no recursive support): the tree still works, but the
 *  caller must refresh some other way, because no change will ever be reported. */
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

/** Close every watcher on renderer reload / window teardown: the renderer's effect
 *  cleanup doesn't run on a hard reload, so without this FSWatchers leak and their ref
 *  counts stay pinned. The renderer re-watches its current root on remount. */
export function closeAllDirWatchers(): void {
  for (const entry of dirWatchers.values()) closeWatcher(entry)
  dirWatchers.clear()
}
