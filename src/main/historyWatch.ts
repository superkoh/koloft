import fs from 'fs'
import path from 'path'
import type { BackendAvailability } from '@shared/types'

export interface HistoryStore {
  dir(env: NodeJS.ProcessEnv): string
  holdsASession(rel: string): boolean
  settleMs: number
}

// PLATFORM§40
export function watchHistory(store: HistoryStore, dir: string, relist: () => void): () => void {
  const watchedSince = Date.now()
  const seen = new Set<string>()
  let watcher: fs.FSWatcher | undefined
  let settle: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const soon = (): void => {
    clearTimeout(settle)
    settle = setTimeout(relist, store.settleMs)
  }
  const changed = (rel: string): void => {
    if (!store.holdsASession(rel)) return
    const found = fs.statSync(path.join(dir, rel), { throwIfNoEntry: false })
    if (found) {
      if (seen.has(rel)) return
      seen.add(rel)
      if (found.birthtimeMs > 0 && found.birthtimeMs < watchedSince) return
    } else {
      for (const known of seen)
        if (known === rel || known.startsWith(rel + path.sep)) seen.delete(known)
    }
    soon()
  }
  const watch = (target: string, recursive: boolean, onName: (name: string) => void): void => {
    try {
      const w = fs.watch(target, { recursive }, (_event, name) => {
        if (name) onName(name.toString())
      })
      w.on('error', () => {
        w.close()
        if (watcher === w) watcher = undefined
        if (!fs.existsSync(target)) attach()
      })
      watcher = w
    } catch {
      watcher = undefined
    }
  }
  // PLATFORM§28
  const attach = (): void => {
    watcher?.close()
    watcher = undefined
    if (closed) return
    if (fs.existsSync(dir)) {
      watch(dir, true, changed)
      soon()
      return
    }
    let above = path.dirname(dir)
    while (!fs.existsSync(above) && path.dirname(above) !== above) above = path.dirname(above)
    const toward = path.relative(above, dir).split(path.sep)[0]
    watch(above, false, (name) => {
      if (name === toward) attach()
    })
    if (fs.existsSync(path.join(above, toward))) attach()
  }
  attach()
  return () => {
    closed = true
    watcher?.close()
    clearTimeout(settle)
  }
}

export interface ListsHistory {
  readonly historyStore: HistoryStore
  readonly defaultEnv: NodeJS.ProcessEnv | undefined
  availability(): Promise<BackendAvailability>
  refreshHistoryStartedNow(): Promise<void>
}

export async function watchHistoryOf(sessions: ListsHistory): Promise<void> {
  await sessions.availability()
  const store = sessions.historyStore
  watchHistory(
    store,
    store.dir(sessions.defaultEnv ?? process.env),
    () => void sessions.refreshHistoryStartedNow().catch(() => undefined)
  )
}
