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

function readNamedDrop(dir: string, name: string, handlerFor: DropHandlerFor): Promise<void> {
  if (!name.endsWith('.json')) return Promise.resolve()
  const handle = handlerFor(name)
  if (!handle) return Promise.resolve()
  const full = path.join(dir, name)
  return readJsonDrop(full, 0, (obj) => handle(obj, full))
}

async function readInWriteOrder(
  dir: string,
  handlerFor: DropHandlerFor,
  inWriteOrder: InWriteOrder
): Promise<void> {
  const names = await fs.promises.readdir(dir)
  const written = await Promise.all(
    names
      .filter((name) => name.endsWith('.json') && inWriteOrder(name) && handlerFor(name))
      .map((name) =>
        fs.promises.stat(path.join(dir, name)).then(
          (st) => ({ name, at: st.mtimeMs }),
          () => null
        )
      )
  )
  // PLATFORM§28
  for (const { name } of written.flatMap((w) => (w ? [w] : [])).sort((a, b) => a.at - b.at))
    await readNamedDrop(dir, name, handlerFor)
}

function onePassAtATime(
  dir: string,
  handlerFor: DropHandlerFor,
  inWriteOrder: InWriteOrder
): () => void {
  const eachOnce = oncePerName(handlerFor)
  let running = false
  let wantedAgain = false
  const pass = (): void => {
    if (running) {
      wantedAgain = true
      return
    }
    running = true
    readInWriteOrder(dir, eachOnce, inWriteOrder)
      .catch(() => {})
      .finally(() => {
        running = false
        if (wantedAgain) {
          wantedAgain = false
          pass()
        }
      })
  }
  return pass
}

function sweepJsonDrops(
  dir: string,
  sweepFor: DropHandlerFor,
  inWriteOrder: InWriteOrder,
  passInWriteOrder: () => void
): void {
  fs.readdir(dir, (err, names) => {
    if (err) return
    for (const name of names)
      if (name.endsWith('.json') && !inWriteOrder(name)) void readNamedDrop(dir, name, sweepFor)
    passInWriteOrder()
  })
}

function watchWith(
  dir: string,
  handlerFor: DropHandlerFor,
  inWriteOrder: InWriteOrder,
  passInWriteOrder: () => void
): fs.FSWatcher | null {
  try {
    return fs.watch(dir, (_event, filename) => {
      if (!filename) return
      const name = filename.toString()
      if (!name.endsWith('.json')) return
      // PLATFORM§28
      if (inWriteOrder(name)) passInWriteOrder()
      else void readNamedDrop(dir, name, handlerFor)
    })
  } catch {
    return null
  }
}

export function watchJsonDrops(
  dir: string,
  handlerFor: DropHandlerFor,
  inWriteOrder: InWriteOrder = noDropInWriteOrder
): fs.FSWatcher | null {
  return watchWith(dir, handlerFor, inWriteOrder, onePassAtATime(dir, handlerFor, inWriteOrder))
}

// PLATFORM§28
const SWEEP_FOR_A_LOST_DROP_MS = 1000

export function watchAndSweepJsonDrops(
  dir: string,
  handlerFor: DropHandlerFor,
  sweepFor: DropHandlerFor = handlerFor,
  inWriteOrder: InWriteOrder = noDropInWriteOrder
): fs.FSWatcher | null {
  const passInWriteOrder = onePassAtATime(dir, handlerFor, inWriteOrder)
  const watcher = watchWith(dir, handlerFor, inWriteOrder, passInWriteOrder)
  if (watcher) {
    const sweep = setInterval(
      () => sweepJsonDrops(dir, sweepFor, inWriteOrder, passInWriteOrder),
      SWEEP_FOR_A_LOST_DROP_MS
    ).unref()
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
