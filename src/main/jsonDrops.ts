import fs from 'fs'
import path from 'path'

const MID_WRITE_PARSE_RETRIES = 3
const MID_WRITE_RETRY_MS = 60
export function readJsonDrop(full: string, attempt: number, handle: (obj: unknown) => void): void {
  fs.readFile(full, 'utf8', (err, data) => {
    if (err) return
    let obj: unknown
    try {
      obj = JSON.parse(data)
    } catch {
      if (attempt < MID_WRITE_PARSE_RETRIES) {
        setTimeout(() => readJsonDrop(full, attempt + 1, handle), MID_WRITE_RETRY_MS)
      }
      return
    }
    handle(obj)
  })
}

export function writeWholeBeforeVisible(dest: string, text: string): void {
  const tmp = `${dest}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, dest)
}

type DropHandlerFor = (name: string) => ((obj: unknown, full: string) => void) | null

function readNamedDrop(dir: string, name: string, handlerFor: DropHandlerFor): void {
  if (!name.endsWith('.json')) return
  const handle = handlerFor(name)
  if (!handle) return
  const full = path.join(dir, name)
  readJsonDrop(full, 0, (obj) => handle(obj, full))
}

function sweepJsonDrops(dir: string, handlerFor: DropHandlerFor): void {
  fs.readdir(dir, (err, names) => {
    if (err) return
    for (const name of names) readNamedDrop(dir, name, handlerFor)
  })
}

export function watchJsonDrops(dir: string, handlerFor: DropHandlerFor): fs.FSWatcher | null {
  try {
    return fs.watch(dir, (_event, filename) => {
      if (filename) readNamedDrop(dir, filename.toString(), handlerFor)
    })
  } catch {
    return null
  }
}

// PLATFORM§28
const SWEEP_FOR_A_LOST_DROP_MS = 1000

export function watchAndSweepJsonDrops(
  dir: string,
  handlerFor: DropHandlerFor,
  sweepFor: DropHandlerFor = handlerFor
): fs.FSWatcher | null {
  const watcher = watchJsonDrops(dir, handlerFor)
  if (watcher) {
    const sweep = setInterval(() => sweepJsonDrops(dir, sweepFor), SWEEP_FOR_A_LOST_DROP_MS).unref()
    watcher.on('close', () => clearInterval(sweep))
  }
  return watcher
}

export function oncePerName(handlerFor: DropHandlerFor): DropHandlerFor {
  const handled = new Set<string>()
  return (name) => {
    if (handled.has(name)) return null
    const handle = handlerFor(name)
    return (
      handle &&
      ((obj, full): void => {
        if (handled.has(name)) return
        handled.add(name)
        handle(obj, full)
      })
    )
  }
}
