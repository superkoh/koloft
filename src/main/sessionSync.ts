import path from 'path'
import { messagingOf, type Messaging } from '@shared/sessionBackend'
import { barePath, isRemoteKey } from '@shared/remoteKey'
import type { BackendId, PreviewItem } from '@shared/types'
import {
  FROM_KOLOFT,
  MESSAGE_SOCKET_SHOWS_WITHIN_MS,
  crossSessionLine,
  type ModeClass
} from './crossSessionMessage'

const NAMED_AT_MOST = 10

export interface SyncSession {
  tabId: string
  sessionId: string
  backendId: BackendId
  title: string
  treeRoot: string
  files?: PreviewItem[]
  liveWrites?: number
}

export interface DefaultMove {
  wsPath: string
  defRef: string
  from: string
  to: string
}

export interface SessionSyncDeps {
  idle(tabId: string): boolean
  modeOf(tabId: string): ModeClass
  repoOf(dir: string): Promise<string | null>
  gitOut(dir: string, args: string[]): Promise<string | null>
  queue(tabId: string, text: string, clientId: string): Promise<void>
  sendLine(tabId: string, line: string, ms: number): Promise<void>
  type(tabId: string, text: string): Promise<void>
}

interface SameFiles {
  name: string
  sameFolder: boolean
  files: Set<string>
}

interface Pending {
  route: Messaging
  move?: { defRef: string; from: string; to: string; subjects: string[]; yours: Set<string> }
  sameFiles: Map<string, SameFiles>
}

interface Seen {
  sessionId: string
  liveWrites: number
  stamps: Map<string, number>
  live: Set<string>
}

function inTree(s: SyncSession, src: string): string | null {
  const rel = path.posix.relative(barePath(s.treeRoot), barePath(src))
  return rel && !rel.startsWith('..') && !path.posix.isAbsolute(rel) ? rel : null
}

function written(s: SyncSession): PreviewItem[] {
  return (s.files ?? []).filter((f) => f.access === 'wrote')
}

function lines(out: string | null): string[] {
  return (out ?? '').split('\n').filter(Boolean)
}

function listed(items: string[]): string {
  const more = items.length - NAMED_AT_MOST
  const named = items.slice(0, NAMED_AT_MOST).join(', ')
  return more > 0 ? `${named} and ${more} more` : named
}

function short(sha: string): string {
  return sha.slice(0, 7)
}

function noticeText(p: Pending): string {
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
  private told = new Map<string, Set<string>>()
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

  async defaultMoved(move: DefaultMove, sessions: SyncSession[]): Promise<void> {
    const repo = await this.d.repoOf(move.wsPath)
    if (!repo || this.tips.get(repo) === move.to) return
    this.tips.set(repo, move.to)
    const defBranch = move.defRef.replace(/^origin\//, '')
    const branchNeedsIt = async (treeRoot: string): Promise<boolean> => {
      const [branch, holdsTip] = await Promise.all([
        this.d.gitOut(treeRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
        this.d.gitOut(treeRoot, ['merge-base', '--is-ancestor', move.to, 'HEAD'])
      ])
      return branch?.trim() !== defBranch && holdsTip === null
    }
    const asked = new Map<string, Promise<boolean>>()
    const needsIt = async (s: SyncSession): Promise<boolean> => {
      if ((await this.d.repoOf(s.treeRoot)) !== repo) return false
      if (!asked.has(s.treeRoot)) asked.set(s.treeRoot, branchNeedsIt(s.treeRoot))
      return asked.get(s.treeRoot)!
    }
    const needed = await Promise.all(sessions.map(needsIt))
    const told = sessions.filter((_, i) => needed[i])
    if (!told.length) return
    const [log, diff] = await Promise.all([
      this.d.gitOut(move.wsPath, ['log', '--format=%s', `${move.from}..${move.to}`]),
      this.d.gitOut(move.wsPath, ['diff', '--name-only', move.from, move.to])
    ])
    const subjects = lines(log)
    const changed = new Set(lines(diff))
    for (const s of told) {
      const yours = written(s)
        .map((f) => inTree(s, f.src))
        .filter((rel): rel is string => rel !== null && changed.has(rel))
      const p = this.of(s)
      p.move = {
        defRef: move.defRef,
        from: p.move?.from ?? move.from,
        to: move.to,
        subjects: [...subjects, ...(p.move?.subjects ?? [])],
        yours: new Set([...(p.move?.yours ?? []), ...yours])
      }
      this.flush(s.tabId)
    }
  }

  flush(tabId: string): void {
    const p = this.pending.get(tabId)
    if (!p || (p.route !== 'peerLine' && !this.d.idle(tabId))) return
    this.pending.delete(tabId)
    void this.deliver(tabId, p.route, noticeText(p)).catch(() => undefined)
  }

  forget(tabId: string): void {
    this.pending.delete(tabId)
    this.seen.delete(tabId)
    this.told.delete(tabId)
  }

  private async deliver(tabId: string, route: Messaging, text: string): Promise<void> {
    const id = `koloft-sync-${++this.sent}`
    if (route === 'queue') return this.d.queue(tabId, text, id)
    if (route === 'typed') return this.d.type(tabId, text)
    const line = crossSessionLine(this.d.modeOf(tabId), text, id)
    if (line) await this.d.sendLine(tabId, line, MESSAGE_SOCKET_SHOWS_WITHIN_MS)
  }

  private of(s: SyncSession): Pending {
    const p = this.pending.get(s.tabId) ?? {
      route: messagingOf(s.backendId, isRemoteKey(s.treeRoot)),
      sameFiles: new Map()
    }
    this.pending.set(s.tabId, p)
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
    const others = sessions.filter((o) => o.tabId !== writer.tabId)
    const repos = await Promise.all(others.map((o) => this.d.repoOf(o.treeRoot)))
    others.forEach((other, i) => {
      if (repos[i] !== repo) return
      const theirs = new Set(
        [...(this.seen.get(other.tabId)?.live ?? [])].map((src) => inTree(other, src))
      )
      const both = mine.filter((rel) => theirs.has(rel))
      const sameFolder = other.treeRoot === writer.treeRoot
      this.tell(other, writer, both, sameFolder)
      this.tell(writer, other, both, sameFolder)
    })
  }

  private tell(to: SyncSession, about: SyncSession, files: string[], sameFolder: boolean): void {
    const told = this.told.get(to.tabId) ?? new Set<string>()
    this.told.set(to.tabId, told)
    const untold = files.filter((rel) => {
      const key = `${about.tabId}\n${rel}`
      if (told.has(key)) return false
      told.add(key)
      return true
    })
    if (!untold.length) return
    const p = this.of(to)
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
