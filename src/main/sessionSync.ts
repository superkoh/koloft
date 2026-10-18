import path from 'path'
import { messagingOf } from '@shared/sessionBackend'
import { parseRemoteKey } from '@shared/remoteKey'
import type { BackendId, PreviewItem } from '@shared/types'
import { FROM_KOLOFT, crossSessionLine, type ModeClass } from './crossSessionMessage'

const NAMED_AT_MOST = 10
const MESSAGE_SOCKET_SHOWS_WITHIN_MS = 5000

export interface SyncSession {
  tabId: string
  sessionId: string
  title: string
  treeRoot: string
  files?: PreviewItem[]
  liveWrites?: number
}

export interface DefaultMove {
  defRef: string
  from: string
  to: string
  subjects: string[]
  changed: string[]
}

export interface SessionSyncDeps {
  backendOf(tabId: string): BackendId | undefined
  remote(tabId: string): boolean
  idle(tabId: string): boolean
  modeOf(tabId: string): ModeClass
  repoOf(treeRoot: string): Promise<string | null>
  hasCommit(treeRoot: string, sha: string): Promise<boolean>
  queue(tabId: string, text: string, clientId: string): Promise<void>
  sendLine(tabId: string, line: string, ms: number): Promise<void>
  type(tabId: string, keys: string[]): Promise<void>
}

interface SameFiles {
  name: string
  sameFolder: boolean
  files: Set<string>
}

interface Pending {
  move?: DefaultMove & { yours: Set<string> }
  sameFiles: Map<string, SameFiles>
}

interface Seen {
  sessionId: string
  liveWrites: number
  stamps: Map<string, number>
  live: Set<string>
}

function bare(p: string): string {
  return parseRemoteKey(p)?.path ?? p
}

function inTree(s: SyncSession, src: string): string | null {
  const rel = path.posix.relative(bare(s.treeRoot), bare(src))
  return rel && !rel.startsWith('..') && !path.posix.isAbsolute(rel) ? rel : null
}

function written(s: SyncSession): PreviewItem[] {
  return (s.files ?? []).filter((f) => f.access === 'wrote')
}

function listed(items: string[]): string {
  const more = items.length - NAMED_AT_MOST
  const named = items.slice(0, NAMED_AT_MOST).join(', ')
  return more > 0 ? `${named} and ${more} more` : named
}

function short(sha: string): string {
  return sha.slice(0, 7)
}

export function noticeText(p: Pending): string {
  const parts: string[] = []
  const m = p.move
  if (m) {
    const commits = m.subjects.map((s) => `"${s}"`)
    parts.push(
      `${m.defRef} moved from ${short(m.from)} to ${short(m.to)}, with ${m.subjects.length} new commit${m.subjects.length === 1 ? '' : 's'}: ${listed(commits)}.`
    )
    if (m.yours.size) parts.push(`It changed files you changed too: ${listed([...m.yours])}.`)
    parts.push('Whether your work needs it now is your call; nobody asks you to merge or rebase.')
  }
  for (const o of p.sameFiles.values()) {
    parts.push(`The session "${o.name}" changed files you changed too: ${listed([...o.files])}.`)
    parts.push(
      o.sameFolder
        ? 'It works in your folder, so read them again before you edit them.'
        : 'It works in another worktree of this repository, so your two branches may conflict when both reach main.'
    )
  }
  return `${FROM_KOLOFT}${parts.join(' ')}`
}

export class SessionSync {
  private pending = new Map<string, Pending>()
  private seen = new Map<string, Seen>()
  private told = new Set<string>()
  private tips = new Map<string, string>()
  private sent = 0

  constructor(private d: SessionSyncDeps) {}

  async observe(sessions: SyncSession[]): Promise<void> {
    const fresh: [SyncSession, string[]][] = []
    for (const s of sessions) {
      const files = written(s)
      const stamps = new Map(files.map((f) => [f.src, f.wroteAt ?? 0]))
      const liveWrites = s.liveWrites ?? 0
      const was = this.seen.get(s.tabId)
      if (!was || was.sessionId !== s.sessionId) {
        this.seen.set(s.tabId, { sessionId: s.sessionId, liveWrites, stamps, live: new Set() })
        continue
      }
      if (liveWrites > was.liveWrites) {
        const wrote = files
          .filter((f) => (f.wroteAt ?? 0) > (was.stamps.get(f.src) ?? -1))
          .map((f) => f.src)
        for (const src of wrote) was.live.add(src)
        if (wrote.length) fresh.push([s, wrote])
      }
      was.liveWrites = liveWrites
      was.stamps = stamps
    }
    const open = new Set(sessions.map((s) => s.tabId))
    for (const tabId of [...this.seen.keys()]) if (!open.has(tabId)) this.forget(tabId)
    for (const [writer, wrote] of fresh) await this.tellOthers(writer, wrote, sessions)
  }

  async defaultMoved(repo: string, move: DefaultMove, sessions: SyncSession[]): Promise<void> {
    if (this.tips.get(repo) === move.to) return
    this.tips.set(repo, move.to)
    const changed = new Set(move.changed)
    for (const s of sessions) {
      if ((await this.d.repoOf(s.treeRoot)) !== repo) continue
      if (await this.d.hasCommit(s.treeRoot, move.to)) continue
      const yours = written(s)
        .map((f) => inTree(s, f.src))
        .filter((rel): rel is string => rel !== null && changed.has(rel))
      const p = this.of(s.tabId)
      p.move = p.move
        ? {
            ...move,
            from: p.move.from,
            subjects: [...move.subjects, ...p.move.subjects],
            yours: new Set([...p.move.yours, ...yours])
          }
        : { ...move, yours: new Set(yours) }
      this.flush(s.tabId)
    }
  }

  flush(tabId: string): void {
    const p = this.pending.get(tabId)
    if (!p) return
    const backend = this.d.backendOf(tabId)
    if (backend !== 'claude' && backend !== 'codex') return void this.pending.delete(tabId)
    const route = messagingOf(backend, this.d.remote(tabId))
    if (route !== 'peerLine' && !this.d.idle(tabId)) return
    this.pending.delete(tabId)
    void this.deliver(tabId, route, noticeText(p)).catch(() => undefined)
  }

  forget(tabId: string): void {
    this.pending.delete(tabId)
    this.seen.delete(tabId)
    for (const key of this.told) if (key.split('\n', 2).includes(tabId)) this.told.delete(key)
  }

  private async deliver(tabId: string, route: string, text: string): Promise<void> {
    const id = `koloft-sync-${++this.sent}`
    if (route === 'queue') return this.d.queue(tabId, text, id)
    if (route === 'typed') return this.d.type(tabId, [text, '\r'])
    const line = crossSessionLine(this.d.modeOf(tabId), text, id)
    if (line) await this.d.sendLine(tabId, line, MESSAGE_SOCKET_SHOWS_WITHIN_MS)
  }

  private of(tabId: string): Pending {
    const p = this.pending.get(tabId) ?? { sameFiles: new Map() }
    this.pending.set(tabId, p)
    return p
  }

  private async tellOthers(
    writer: SyncSession,
    wrote: string[],
    sessions: SyncSession[]
  ): Promise<void> {
    const repo = await this.d.repoOf(writer.treeRoot)
    if (!repo) return
    const mine = wrote.map((src) => inTree(writer, src)).filter((r): r is string => r !== null)
    for (const other of sessions) {
      if (other.tabId === writer.tabId || (await this.d.repoOf(other.treeRoot)) !== repo) continue
      const theirs = new Set(
        [...(this.seen.get(other.tabId)?.live ?? [])].map((src) => inTree(other, src))
      )
      const both = mine.filter((rel) => theirs.has(rel))
      const sameFolder = other.treeRoot === writer.treeRoot
      this.tell(other, writer, both, sameFolder)
      this.tell(writer, other, both, sameFolder)
    }
  }

  private tell(to: SyncSession, about: SyncSession, files: string[], sameFolder: boolean): void {
    const untold = files.filter((rel) => {
      const key = `${to.tabId}\n${about.tabId}\n${rel}`
      if (this.told.has(key)) return false
      this.told.add(key)
      return true
    })
    if (!untold.length) return
    const p = this.of(to.tabId)
    const entry = p.sameFiles.get(about.tabId) ?? {
      name: about.title,
      sameFolder,
      files: new Set()
    }
    for (const rel of untold) entry.files.add(rel)
    p.sameFiles.set(about.tabId, entry)
    this.flush(to.tabId)
  }
}
