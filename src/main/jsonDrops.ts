import fs from 'fs'
import path from 'path'

const MID_WRITE_PARSE_RETRIES = 3
const MID_WRITE_RETRY_MS = 60
export function readJsonDrop(
  full: string,
  attempt: number,
  handle: (obj: unknown) => void
): Promise<void> {
  return new Promise((done) => {
    fs.readFile(full, 'utf8', (err, data) => {
      if (err) return done()
      let obj: unknown
      try {
        obj = JSON.parse(data)
      } catch {
        if (attempt < MID_WRITE_PARSE_RETRIES) {
          setTimeout(
            () => void readJsonDrop(full, attempt + 1, handle).then(done),
            MID_WRITE_RETRY_MS
          )
        } else done()
        return
      }
      try {
        handle(obj)
      } finally {
        done()
      }
    })
  })
}

export function writeWholeBeforeVisible(dest: string, text: string): void {
  const tmp = `${dest}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, dest)
}

export type DropHandlerFor = (name: string) => ((obj: unknown, full: string) => void) | null

export type InWriteOrder = (name: string) => boolean

const noDropInWriteOrder: InWriteOrder = () => false

function readNamedDrop(
  dir: string,
  name: string,
  handlerFor: DropHandlerFor,
  after: Promise<void> = Promise.resolve()
): Promise<void> {
  if (!name.endsWith('.json')) return after
  const handle = handlerFor(name)
  if (!handle) return after
  const full = path.join(dir, name)
  const read = (): Promise<void> => readJsonDrop(full, 0, (obj) => handle(obj, full))
  return after.then(read, read)
}

function sweepJsonDrops(dir: string, handlerFor: DropHandlerFor): void {
  fs.readdir(dir, (err, names) => {
    if (err) return
    for (const name of names) void readNamedDrop(dir, name, handlerFor)
  })
}

export function watchJsonDrops(
  dir: string,
  handlerFor: DropHandlerFor,
  inWriteOrder: InWriteOrder = noDropInWriteOrder
): fs.FSWatcher | null {
  let earlierDrops = Promise.resolve()
  try {
    return fs.watch(dir, (_event, filename) => {
      if (!filename) return
      const name = filename.toString()
      if (inWriteOrder(name)) earlierDrops = readNamedDrop(dir, name, handlerFor, earlierDrops)
      else void readNamedDrop(dir, name, handlerFor)
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
  sweepFor: DropHandlerFor = handlerFor,
  inWriteOrder: InWriteOrder = noDropInWriteOrder
): fs.FSWatcher | null {
  const watcher = watchJsonDrops(dir, handlerFor, inWriteOrder)
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
