import fs from 'fs'
import os from 'os'
import path from 'path'
import type { BackendAvailability, BackendId } from '@shared/types'
import { museHome } from './museSessionLog'
import { AGY_APP_DIR, ownersGeminiDir } from './agyStore'

export interface HistoryStore {
  dir(env: NodeJS.ProcessEnv): string
  holdsASession(rel: string, there: boolean): boolean
  settleMs: number
}

// CODEX§15
const CODEX_LISTS_A_NEW_ROLLOUT_WITHIN_MS = 1000
// MUSE§5
const MUSE_LISTS_A_NEW_SESSION_WITHIN_MS = 6000
// AGY§8
const AGY_LISTS_A_NEW_CONVERSATION_WITHIN_MS = 1500
const MUSE_SESSION_FOLDER_DEPTH = 4

// MUSE§2 MUSE§5
const museBookkeeping = (part: string): boolean => part.startsWith('.') || part === 'subagent'

export const HISTORY_STORES: Record<Exclude<BackendId, 'claude'>, HistoryStore> = {
  // CODEX§15
  codex: {
    dir: (env) => path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'),
    holdsASession: () => true,
    settleMs: CODEX_LISTS_A_NEW_ROLLOUT_WITHIN_MS
  },
  muse: {
    dir: (env) => path.join(museHome(env), 'sessions'),
    holdsASession: (rel, there) => {
      const parts = rel.split(path.sep)
      if (parts.some(museBookkeeping)) return false
      return (
        parts.at(-1) === 'session.jsonl' || (!there && parts.length <= MUSE_SESSION_FOLDER_DEPTH)
      )
    },
    settleMs: MUSE_LISTS_A_NEW_SESSION_WITHIN_MS
  },
  // AGY§8
  agy: {
    dir: (env) => path.join(ownersGeminiDir(env), AGY_APP_DIR, 'conversations'),
    holdsASession: (rel) => !rel.includes(path.sep) && rel.endsWith('.db'),
    settleMs: AGY_LISTS_A_NEW_CONVERSATION_WITHIN_MS
  }
}

// PLATFORM§40
export function watchHistory(store: HistoryStore, dir: string, relist: () => void): () => void {
  const seen = new Set<string>()
  let watcher: fs.FSWatcher | undefined
  let settle: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const soon = (): void => {
    settle ??= setTimeout(() => {
      settle = undefined
      relist()
    }, store.settleMs)
  }
  const changed = (rel: string): void => {
    const there = fs.existsSync(path.join(dir, rel))
    if (!store.holdsASession(rel, there)) return
    if (there) {
      if (seen.has(rel)) return
      seen.add(rel)
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
      w.on('error', () => attach(true))
      watcher = w
    } catch {
      watcher = undefined
    }
  }
  // PLATFORM§28
  const attach = (afterMissing: boolean): void => {
    watcher?.close()
    watcher = undefined
    if (closed) return
    if (fs.existsSync(dir)) {
      watch(dir, true, changed)
      if (afterMissing) soon()
      return
    }
    let above = path.dirname(dir)
    while (!fs.existsSync(above) && path.dirname(above) !== above) above = path.dirname(above)
    const toward = path.relative(above, dir).split(path.sep)[0]
    watch(above, false, (name) => {
      if (name === toward) attach(true)
    })
    if (fs.existsSync(dir)) attach(true)
  }
  attach(false)
  return () => {
    closed = true
    watcher?.close()
    clearTimeout(settle)
  }
}

export interface ListsHistory {
  readonly id: Exclude<BackendId, 'claude'>
  readonly defaultEnv: NodeJS.ProcessEnv | undefined
  availability(): Promise<BackendAvailability>
  refreshHistory(): Promise<void>
}

export async function watchHistoryOf(sessions: ListsHistory): Promise<void> {
  const available = await sessions.availability()
  const env = sessions.defaultEnv
  if (!available.available || !env) return
  const store = HISTORY_STORES[sessions.id]
  watchHistory(store, store.dir(env), () => void sessions.refreshHistory().catch(() => undefined))
}
