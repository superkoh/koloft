import path from 'path'
import {
  PENDING_SESSION_TITLE,
  PLACEHOLDER_SESSION_TITLE,
  type SessionRow,
  type WorktreeStateMeta
} from '@shared/types'
import { classifyUserPrompt, encodeCwd, INTERRUPT_TEXTS } from './sessionTracker'

export type { SessionRow }

export interface Bucket {
  slug: string
  dir: string
  host?: string
}

export interface ResolveBucketsDeps {
  gitWorktreeList(root: string): string[]
  listProjectSlugs(): string[]
  readFirstCwd(slug: string): string | null
}

// CC§2
const TRUNC_SUFFIX = /-[a-zA-Z0-9]{6}$/

function truncBase(slug: string): string {
  return slug.replace(TRUNC_SUFFIX, '')
}

export function resolveBuckets(wsPath: string, deps: ResolveBucketsDeps): Bucket[] {
  const dirs: string[] = []
  for (const d of [wsPath, ...deps.gitWorktreeList(wsPath)]) {
    const n = path.resolve(d)
    if (!dirs.includes(n)) dirs.push(n)
  }
  const slugs = deps.listProjectSlugs()
  const buckets = dirs.map((dir) => {
    const enc = encodeCwd(dir)
    if (slugs.includes(enc)) return { slug: enc, dir }
    const hit = slugs.find(
      (s) => s !== enc && enc.startsWith(truncBase(s)) && deps.readFirstCwd(s) === dir
    )
    return { slug: hit ?? enc, dir }
  })
  // CC§4 PLATFORM§1
  const home = wsPath + '/.claude/worktrees/'
  const homePrefix = encodeCwd(home)
  const claimed = new Set(buckets.map((b) => b.slug))
  for (const s of slugs) {
    if (claimed.has(s)) continue
    const base = truncBase(s)
    if (!s.startsWith(homePrefix) && !(base !== s && homePrefix.startsWith(base))) continue
    const cwd = deps.readFirstCwd(s)
    if (!cwd || !cwd.startsWith(home)) continue
    if (cwd.slice(home.length).includes('/')) continue
    buckets.push({ slug: s, dir: cwd })
    claimed.add(s)
  }
  return buckets
}

// CC§2
function readWorktreeState(obj: Record<string, unknown>): WorktreeStateMeta | undefined {
  const s = obj.worktreeSession
  if (!s || typeof s !== 'object') return undefined
  const r = s as Record<string, unknown>
  const str = (k: string): string | undefined => (typeof r[k] === 'string' ? r[k] : undefined)
  const originalCwd = str('originalCwd')
  const worktreePath = str('worktreePath')
  const worktreeName = str('worktreeName')
  const worktreeBranch = str('worktreeBranch')
  const originalHeadCommit = str('originalHeadCommit')
  if (!originalCwd || !worktreePath || !worktreeName || !worktreeBranch || !originalHeadCommit) {
    return undefined
  }
  return { originalCwd, worktreePath, worktreeName, worktreeBranch, originalHeadCommit }
}

export interface JsonlTail {
  leftWorktree: boolean
  relocatedCwd?: string
}

// CC§2 CC§4
export function extractJsonlTail(lines: Iterable<string>): JsonlTail {
  const tail: JsonlTail = { leftWorktree: false }
  for (const line of lines) {
    if (!line.includes('"worktree-state"') && !line.includes('"relocated"')) continue
    let obj: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object') continue
      obj = parsed as Record<string, unknown>
    } catch {
      continue
    }
    if (obj.type === 'worktree-state') tail.leftWorktree = obj.worktreeSession === null
    else if (obj.type === 'relocated' && typeof obj.relocatedCwd === 'string' && obj.relocatedCwd) {
      tail.relocatedCwd = obj.relocatedCwd
    }
  }
  return tail
}

export function extractJsonlMeta(lines: Iterable<string>): Partial<SessionMeta> {
  const meta: Partial<SessionMeta> = {}
  for (const line of lines) {
    let obj: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object') continue
      obj = parsed as Record<string, unknown>
    } catch {
      continue
    }
    if (
      meta.summary === undefined &&
      obj.type === 'summary' &&
      typeof obj.summary === 'string' &&
      obj.summary
    ) {
      meta.summary = obj.summary
    }
    // CC§2
    if (
      meta.aiTitle === undefined &&
      obj.type === 'ai-title' &&
      typeof obj.aiTitle === 'string' &&
      obj.aiTitle
    ) {
      meta.aiTitle = obj.aiTitle
    }
    // CC§2
    if (meta.worktreeState === undefined && obj.type === 'worktree-state') {
      meta.worktreeState = readWorktreeState(obj)
    }
    // CC§2
    if (meta.cwd === undefined && typeof obj.cwd === 'string' && obj.cwd) meta.cwd = obj.cwd
    if (meta.timestamp === undefined && typeof obj.timestamp === 'string' && obj.timestamp) {
      meta.timestamp = obj.timestamp
    }
    if (meta.firstUserText === undefined && obj.type === 'user' && !obj.isMeta) {
      const msg = obj.message as { content?: unknown } | undefined
      const c = msg?.content
      let text = ''
      if (typeof c === 'string') text = c
      else if (Array.isArray(c)) {
        const block = c.find(
          (b: unknown): b is { text: string } =>
            !!b &&
            typeof b === 'object' &&
            (b as { type?: unknown }).type === 'text' &&
            typeof (b as { text?: unknown }).text === 'string'
        )
        if (block) text = block.text
      }
      if (text && !INTERRUPT_TEXTS.has(text)) {
        const cls = classifyUserPrompt(text)
        if (cls.title) meta.firstUserText = cls.title
        if (meta.commandArgsText === undefined && cls.commandArgs) {
          meta.commandArgsText = cls.commandArgs
        }
        if (meta.commandNameText === undefined && cls.commandName) {
          meta.commandNameText = cls.commandName
        }
      }
    }
    if (
      meta.summary !== undefined &&
      meta.aiTitle !== undefined &&
      meta.firstUserText !== undefined &&
      meta.cwd !== undefined &&
      meta.timestamp !== undefined
    ) {
      break
    }
  }
  return meta
}

export interface SessionMeta {
  aiTitle?: string
  summary?: string
  firstUserText?: string
  commandArgsText?: string
  commandNameText?: string
  cwd: string
  timestamp: string
  worktreeState?: WorktreeStateMeta
}

export interface AggregateDeps {
  listJsonl(slug: string): { id: string; mtime: number }[]
  readMeta(slug: string, id: string): SessionMeta
  runningIds: Set<string>
  dirExists(p: string): boolean
  now(): number
}

export const TITLE_MAX = 60

function relativeAgo(tsMs: number, nowMs: number): string {
  const s = Math.floor(Math.max(0, nowMs - tsMs) / 1000)
  if (s >= 86400) return `${Math.floor(s / 86400)}d ago`
  if (s >= 3600) return `${Math.floor(s / 3600)}h ago`
  if (s >= 60) return `${Math.floor(s / 60)}m ago`
  return `${s}s ago`
}

function titleFor(meta: SessionMeta, nowMs: number): string {
  if (meta.aiTitle) return meta.aiTitle
  if (meta.summary) return meta.summary
  if (meta.firstUserText) {
    const t = meta.firstUserText
    return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) + '…' : t
  }
  if (meta.commandArgsText) {
    const t = meta.commandArgsText
    return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) + '…' : t
  }
  if (meta.commandNameText) return meta.commandNameText
  return relativeAgo(Date.parse(meta.timestamp), nowMs)
}

export function aggregateSessions(buckets: Bucket[], deps: AggregateDeps): SessionRow[] {
  const nowMs = deps.now()
  const rows = new Map<string, SessionRow>()
  buckets.forEach((b, i) => {
    for (const f of deps.listJsonl(b.slug)) {
      const meta = deps.readMeta(b.slug, f.id)
      const row: SessionRow = {
        id: f.id,
        createdAt: Date.parse(meta.timestamp) || 0,
        title: titleFor(meta, nowMs),
        // CC§2
        worktree: meta.worktreeState?.worktreeName ?? (i === 0 ? 'main' : path.basename(b.dir)),
        cwd: meta.cwd,
        running: deps.runningIds.has(f.id),
        invalidCwd: !deps.dirExists(meta.cwd),
        mtime: f.mtime,
        worktreeState: meta.worktreeState
      }
      // CC§2
      const prev = rows.get(f.id)
      if (!prev || f.mtime > prev.mtime) rows.set(f.id, row)
    }
  })
  return [...rows.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
}

export function filterOwned(
  rows: SessionRow[],
  owned: ReadonlySet<string>,
  running: ReadonlySet<string>
): SessionRow[] {
  return rows.filter((r) => owned.has(r.id) || running.has(r.id))
}

export function hasHistory(
  rows: SessionRow[],
  owned: ReadonlySet<string>,
  running: ReadonlySet<string>
): boolean {
  return rows.some((r) => !owned.has(r.id) && !running.has(r.id))
}

export interface PendingLaunch {
  tabId: string
  cwd: string
  reportedCwd?: string
  worktree?: string
  sessionId?: string
  host?: string
}

export interface PendingSplit {
  rows: SessionRow[]
  promoted: string[]
}

export function resolvePending(
  buckets: Bucket[],
  launches: PendingLaunch[],
  rows: SessionRow[],
  nowMs: number
): PendingSplit {
  const out: PendingSplit = { rows: [], promoted: [] }
  const realIds = new Set(rows.map((r) => r.id))
  for (const l of launches) {
    const cwd = path.resolve(l.cwd)
    const i = buckets.findIndex((b) => b.host === l.host && path.resolve(b.dir) === cwd)
    if (i < 0) continue
    if (l.sessionId && realIds.has(l.sessionId)) {
      out.promoted.push(l.tabId)
      continue
    }
    const reported = l.reportedCwd ? path.resolve(l.reportedCwd) : null
    const j = reported
      ? buckets.findIndex((b) => b.host === l.host && path.resolve(b.dir) === reported)
      : -1
    const at = j < 0 ? i : j
    const dir = path.resolve(buckets[at].dir)
    // CC§3
    const worktree =
      at === 0 ? (j < 0 && l.worktree ? l.worktree : 'main') : path.basename(buckets[at].dir)
    if (l.sessionId) {
      // CC§2
      out.rows.push({
        id: l.sessionId,
        title: PLACEHOLDER_SESSION_TITLE,
        worktree,
        cwd: dir,
        running: true,
        invalidCwd: false,
        mtime: nowMs
      })
      continue
    }
    out.rows.push({
      id: l.tabId,
      title: PENDING_SESSION_TITLE,
      worktree,
      cwd: dir,
      running: false,
      invalidCwd: false,
      mtime: nowMs,
      pending: true
    })
  }
  return out
}

export type RescanEvent =
  | { kind: 'startup' }
  | { kind: 'workspace-add' }
  | { kind: 'session-start'; cwd: string }
  | { kind: 'projects-dir-added'; dirName: string }

export interface RescanState {
  bucketDirs: string[]
  workspaceSlugs: string[]
}

export function planRescan(event: RescanEvent, state: RescanState): 'rescan' | 'none' {
  switch (event.kind) {
    case 'startup':
    case 'workspace-add':
      return 'rescan'
    case 'session-start':
      return state.bucketDirs.includes(path.resolve(event.cwd)) ? 'none' : 'rescan'
    case 'projects-dir-added': {
      const base = truncBase(event.dirName)
      return state.workspaceSlugs.some((ws) => base.startsWith(ws) || ws.startsWith(base))
        ? 'rescan'
        : 'none'
    }
  }
}
