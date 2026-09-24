import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { StringDecoder } from 'string_decoder'
import type {
  DiscoveredFolder,
  LayoutV4,
  ProjectInfo,
  BackendSessionRow,
  SessionRow,
  SessionWorkbenchState,
  WorkspaceAddResult,
  WorkspaceFreshness,
  WorkspaceRemoveResult,
  WorkspaceRows,
  WorktreeInfo
} from '@shared/types'
import {
  aggregateSessions,
  extractJsonlMeta,
  extractJsonlTail,
  planRescan,
  filterOwned,
  hasHistory,
  resolveBuckets,
  resolvePending,
  type JsonlTail,
  type PendingLaunch,
  type RescanState,
  type SessionMeta
} from './sessionAggregate'
import {
  carrySessionWorkbench,
  decideWorkspaceAdd,
  gcSessions,
  parseWorktreeEntries,
  resolveWorkbenchState,
  withWorkbenchState,
  type WorktreeEntry
} from './workspaceOps'
import { encodeCwd } from './sessionTracker'
import { isGitCheckout } from './projectInfo'
import { isRemoteKey, parseRemoteKey, type RemoteKey } from '@shared/remoteKey'
import { identityOf, sourceOf } from '@shared/sessionBackend'
import type { RemoteGitInfo } from './remote/install'

const RESCAN_DEBOUNCE_MS = 250
const PANEL_SAVE_DEBOUNCE_MS = 600
const JSONL_SCAN_CAP = 256 * 1024
// CC§2
const JSONL_TAIL_BYTES = 64 * 1024
const DISCOVER_MAX = 8

interface HeadScan {
  size: number
  mtimeMs: number
  meta: Partial<SessionMeta>
  // CC§2
  final: boolean
  tail?: { size: number; mtimeMs: number; tail: JsonlTail }
}

export interface LiveSession {
  treeRoot: string
  worktree?: string
  remote?: boolean
  relocated?: boolean
}

export interface WorkspaceManagerDeps {
  additionalRows?(workspacePath: string): BackendSessionRow[]
  additionalMembers?(): Set<string>
  projectsRoot: string
  loadLayout(): LayoutV4
  saveLayout(layout: LayoutV4): void
  projectInfo(p: string): ProjectInfo
  runningBindings(): Map<string, string>
  liveSessions?(): Map<string, LiveSession>
  killTab(tabId: string): void
  pushRows(payload: WorkspaceRows[]): void
  freshness?(wsPath: string): WorkspaceFreshness | undefined
  onRescanned?(wsPaths: string[]): void
  jobCountFor?(wsPath: string): number
  remoteProjectsRoot(host: string): string
  remoteRunning?(host: string): Set<string>
  remoteConnected?(host: string): boolean
  remoteGit?(host: string, path: string): RemoteGitInfo | undefined
  killRemoteSession?(host: string, sessionId: string): void
}

function dirExistsSync(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function* jsonlHeadLines(file: string, probe = { opened: false, eof: false }): Generator<string> {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return
  }
  probe.opened = true
  try {
    const buf = Buffer.alloc(64 * 1024)
    const decoder = new StringDecoder('utf8')
    let tail = ''
    let total = 0
    while (total < JSONL_SCAN_CAP) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) {
        probe.eof = true
        break
      }
      total += n
      const parts = (tail + decoder.write(buf.subarray(0, n))).split('\n')
      tail = parts.pop() ?? ''
      yield* parts
    }
    if (tail) yield tail
  } finally {
    fs.closeSync(fd)
  }
}

function jsonlTailLines(file: string): string[] {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return []
  }
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - JSONL_TAIL_BYTES)
    const buf = Buffer.allocUnsafe(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    return start > 0 ? lines.slice(1) : lines
  } finally {
    fs.closeSync(fd)
  }
}

// PLATFORM§1
function gitWorktreeEntries(root: string): Promise<WorktreeEntry[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, 'worktree', 'list', '--porcelain'],
      { timeout: 5000 },
      (err, stdout) => resolve(err ? [] : parseWorktreeEntries(stdout))
    )
  })
}

export class WorkspaceManager {
  private layout: LayoutV4
  private rowsCache: WorkspaceRows[] = []
  private firstScanDone!: () => void
  readonly firstScan: Promise<void> = new Promise((res) => {
    this.firstScanDone = res
  })
  private allRowsCache = new Map<string, SessionRow[]>()
  private wsBySession = new Map<string, string>()
  private bucketDirById = new Map<string, string>()
  private state: RescanState = { bucketDirs: [], workspaceSlugs: [] }
  private launches = new Map<string, PendingLaunch>()
  private rootWatchers = new Map<string, fs.FSWatcher>()
  private bucketWatchers = new Map<string, fs.FSWatcher>()
  private timer?: NodeJS.Timeout
  private panelTimer?: NodeJS.Timeout
  private scanning = false
  private rescanQueued = false
  private lastRunningKey = ''
  private lastLiveKey = ''
  private disposed = false
  private headScans = new Map<string, HeadScan>()
  private headScansSeen = new Set<string>()
  private statByFile = new Map<string, { size: number; mtimeMs: number }>()

  constructor(private deps: WorkspaceManagerDeps) {
    this.layout = deps.loadLayout()
  }

  start(): void {
    this.watchRoots()
    this.scheduleRescan()
  }

  rows(): WorkspaceRows[] {
    return this.rowsCache
  }

  historyRows(wsPath: string): SessionRow[] {
    const running = new Set(this.deps.runningBindings().keys())
    const { key } = this.scope(wsPath)
    if (key) for (const id of this.deps.remoteRunning?.(key.host) ?? []) running.add(id)
    return (this.allRowsCache.get(wsPath) ?? [])
      .filter((r) => !this.isMember(r.id) && !running.has(r.id))
      .sort((a, b) => b.mtime - a.mtime)
  }

  findRow(sessionId: string): SessionRow | undefined {
    for (const rows of this.allRowsCache.values()) {
      const hit = rows.find((r) => r.id === sessionId)
      if (hit) return hit
    }
    return undefined
  }

  workspaceOf(sessionId: string): string | undefined {
    return this.wsBySession.get(sessionId)
  }

  remoteTargets(): { host: string; paths: string[] }[] {
    const byHost = new Map<string, Set<string>>()
    for (const ws of this.layout.workspaces) {
      const { key } = this.scope(ws.path)
      if (!key) continue
      let paths = byHost.get(key.host)
      if (!paths) byHost.set(key.host, (paths = new Set()))
      paths.add(key.path)
    }
    return [...byHost].map(([host, paths]) => ({ host, paths: [...paths] }))
  }

  // CC§2
  realRemotePath(key: RemoteKey): string {
    return this.deps.remoteGit?.(key.host, key.path)?.real ?? key.path
  }

  onRemoteChanged(): void {
    this.scheduleRescan()
  }

  bucketDirOf(sessionId: string): string | undefined {
    return this.bucketDirById.get(sessionId)
  }

  private ownedClaudeIds(): string[] {
    return Object.keys(this.layout.sessions).filter((k) => identityOf(k).backendId === 'claude')
  }

  isMember(sessionId: string): boolean {
    return (
      (!!this.layout.sessions[sessionId] && identityOf(sessionId).backendId === 'claude') ||
      !!this.deps.additionalMembers?.().has(sessionId)
    )
  }

  pinnedPaths(): { path: string; missing: boolean }[] {
    return this.layout.workspaces.map((ws) => ({
      path: ws.path,
      missing: this.scope(ws.path).missing
    }))
  }

  // CC§2
  discover(): DiscoveredFolder[] {
    const pinned = new Set(this.layout.workspaces.map((w) => w.path))
    const byRoot = new Map<string, DiscoveredFolder>()
    const stats = new Map<string, { size: number; mtimeMs: number }>()
    const wtMark = `${path.sep}.claude${path.sep}worktrees${path.sep}`
    const projects = this.deps.projectsRoot
    for (const slug of this.listProjectSlugs(projects)) {
      const files = this.listJsonl(projects, slug, stats)
      let cwd = this.readFirstCwd(projects, slug, files, stats)
      if (!cwd) continue
      const wt = cwd.indexOf(wtMark)
      if (wt !== -1) cwd = cwd.slice(0, wt)
      if (!dirExistsSync(cwd)) continue
      const root = this.deps.projectInfo(cwd).root
      if (pinned.has(root)) continue
      const mtime = Math.max(...files.map((f) => f.mtime))
      const prev = byRoot.get(root)
      if (prev) {
        prev.sessions += files.length
        prev.mtime = Math.max(prev.mtime, mtime)
      } else {
        byRoot.set(root, { path: root, sessions: files.length, mtime })
      }
    }
    return [...byRoot.values()].sort((a, b) => b.mtime - a.mtime).slice(0, DISCOVER_MAX)
  }

  async worktrees(wsPath: string): Promise<WorktreeInfo[]> {
    const root = this.scope(wsPath).scanPath
    return (await this.worktreeEntries(wsPath))
      .filter((e) => e.dir !== root)
      .map((e) => ({ name: path.basename(e.dir), dir: e.dir, branch: e.branch }))
  }

  private async worktreeEntries(wsPath: string): Promise<WorktreeEntry[]> {
    const { key, missing } = this.scope(wsPath)
    if (key) return this.deps.remoteGit?.(key.host, key.path)?.worktrees ?? []
    return missing ? [] : gitWorktreeEntries(wsPath)
  }

  add(rawPath: string): WorkspaceAddResult {
    if (isRemoteKey(rawPath)) return this.addRemote(rawPath)
    if (typeof rawPath !== 'string' || !path.isAbsolute(rawPath) || !dirExistsSync(rawPath)) {
      return { code: 'not-found' }
    }
    const decision = decideWorkspaceAdd(
      this.deps.projectInfo(rawPath),
      this.layout.workspaces.map((w) => w.path)
    )
    if (decision.code === 'rejected-worktree') return { code: 'rejected-worktree' }
    if (decision.code === 'added') {
      this.layout.workspaces = [...this.layout.workspaces, { path: decision.path }]
      this.deps.saveLayout(this.layout)
      this.scheduleRescan()
    }
    return { code: decision.code, path: decision.path }
  }

  private addRemote(rawPath: string): WorkspaceAddResult {
    const existing = this.layout.workspaces.find((w) => w.path === rawPath)
    if (existing) return { code: 'exists', path: existing.path }
    this.layout.workspaces = [...this.layout.workspaces, { path: rawPath }]
    this.deps.saveLayout(this.layout)
    this.scheduleRescan()
    return { code: 'added', path: rawPath }
  }

  remove(wsPath: string): WorkspaceRemoveResult {
    const running = this.runningTabsOf(wsPath).length + this.remoteOrphansOf(wsPath).length
    const jobs = this.deps.jobCountFor?.(wsPath) ?? 0
    if (running > 0 || jobs > 0) return { running, jobs, removed: false }
    this.unpin(wsPath)
    return { running: 0, jobs: 0, removed: true }
  }

  removeConfirmed(wsPath: string): void {
    const tabs = this.runningTabsOf(wsPath)
    const { key } = this.scope(wsPath)
    const orphans = key ? this.remoteOrphansOf(wsPath) : []
    for (const tabId of tabs) this.deps.killTab(tabId)
    if (key) for (const id of orphans) this.deps.killRemoteSession?.(key.host, id)
    this.unpin(wsPath)
  }

  launchStarted(tabId: string, cwd: string, worktree?: string, host?: string): void {
    this.launches.set(tabId, { tabId, cwd, worktree, host })
    this.scheduleRescan()
  }

  launchEnded(tabId: string): void {
    if (this.launches.delete(tabId)) this.scheduleRescan()
  }

  // CC§2
  onSessionStart(tabId: string, cwd: string): void {
    const launch = this.launches.get(tabId)
    if (launch && launch.reportedCwd !== cwd) {
      launch.reportedCwd = cwd
      this.scheduleRescan()
    }
    if (planRescan({ kind: 'session-start', cwd }, this.state) === 'rescan') this.scheduleRescan()
  }

  workbenchState(sessionId: string): SessionWorkbenchState {
    return resolveWorkbenchState(this.layout, sessionId)
  }

  defaultOpen(): boolean {
    return this.layout.workbench.defaultOpen
  }

  setWorkbenchState(sessionId: string, state: SessionWorkbenchState): void {
    if (!this.isMember(sessionId)) return
    this.layout = { ...this.layout, sessions: withWorkbenchState(this.layout, sessionId, state) }
    this.saveSoon()
  }

  archiveSession(sessionId: string): boolean {
    if (!this.layout.sessions[sessionId]) return false
    if (this.deps.runningBindings().has(sessionId)) return false
    const sessions = { ...this.layout.sessions }
    delete sessions[sessionId]
    this.layout = { ...this.layout, sessions }
    this.deps.saveLayout(this.layout)
    this.scheduleRescan()
    return true
  }

  dropOwnership(sessionId: string): void {
    if (!this.layout.sessions[sessionId]) return
    const sessions = { ...this.layout.sessions }
    delete sessions[sessionId]
    this.layout = { ...this.layout, sessions }
    this.deps.saveLayout(this.layout)
    this.scheduleRescan()
  }

  onSessionBound(sessionId: string): void {
    if (!sessionId || this.layout.sessions[sessionId]) return
    this.layout = {
      ...this.layout,
      sessions: {
        ...this.layout.sessions,
        [sessionId]: { open: this.layout.workbench.defaultOpen, tabs: [] }
      }
    }
    this.deps.saveLayout(this.layout)
    this.scheduleRescan()
  }

  onSessionRebind(prevId: string, nextId: string, source: string): void {
    const next = carrySessionWorkbench(this.layout.sessions, prevId, nextId, source)
    if (!next.changed) return
    this.layout = { ...this.layout, sessions: next.sessions }
    this.deps.saveLayout(this.layout)
  }

  onTrackerUpdate(): void {
    const key = [...this.deps.runningBindings().keys()].join(',')
    if (key !== this.lastRunningKey) {
      this.lastRunningKey = key
      this.lastLiveKey = this.liveKey()
      this.scheduleRescan()
      return
    }
    const liveKey = this.liveKey()
    if (liveKey === this.lastLiveKey) return
    this.lastLiveKey = liveKey
    this.restampLive()
  }

  private liveKey(): string {
    const parts: string[] = []
    for (const [id, s] of this.deps.liveSessions?.() ?? []) parts.push(id + '\0' + s.treeRoot)
    return parts.join(',')
  }

  private revealDirOf(
    id: string,
    live: LiveSession | undefined,
    remote: boolean,
    dirOk: Map<string, boolean>
  ): string | undefined {
    const dir = live?.treeRoot ?? this.bucketDirOf(id)
    if (!dir) return undefined
    if (remote) return dir
    let ok = dirOk.get(dir)
    if (ok === undefined) dirOk.set(dir, (ok = dirExistsSync(dir)))
    return ok ? dir : undefined
  }

  dispose(): void {
    this.disposed = true
    this.flushPanelSave()
    if (this.timer) clearTimeout(this.timer)
    for (const w of this.rootWatchers.values()) w.close()
    this.rootWatchers.clear()
    for (const w of this.bucketWatchers.values()) w.close()
    this.bucketWatchers.clear()
  }

  private saveSoon(): void {
    if (this.panelTimer) return
    this.panelTimer = setTimeout(() => {
      this.panelTimer = undefined
      this.deps.saveLayout(this.layout)
    }, PANEL_SAVE_DEBOUNCE_MS)
  }

  private flushPanelSave(): void {
    if (!this.panelTimer) return
    clearTimeout(this.panelTimer)
    this.panelTimer = undefined
    this.deps.saveLayout(this.layout)
  }

  private unpin(wsPath: string): void {
    const next = this.layout.workspaces.filter((w) => w.path !== wsPath)
    if (next.length === this.layout.workspaces.length) return
    this.layout.workspaces = next
    this.deps.saveLayout(this.layout)
    this.scheduleRescan()
  }

  private runningTabsOf(wsPath: string): string[] {
    const bindings = this.deps.runningBindings()
    const entry = this.rowsCache.find((e) => e.workspace.path === wsPath)
    if (!entry) return []
    return entry.rows
      .filter((r) => r.running || r.pending)
      .map((r) => (r.pending ? r.id : bindings.get(r.id)))
      .filter((t): t is string => !!t)
  }

  private remoteOrphansOf(wsPath: string): string[] {
    const { key } = this.scope(wsPath)
    if (!key) return []
    const bindings = this.deps.runningBindings()
    const mine = new Set((this.allRowsCache.get(wsPath) ?? []).map((r) => r.id))
    return [...(this.deps.remoteRunning?.(key.host) ?? [])].filter(
      (id) => !bindings.has(id) && mine.has(id)
    )
  }

  private scheduleRescan(): void {
    if (this.disposed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.rescan()
    }, RESCAN_DEBOUNCE_MS)
  }

  private async rescan(): Promise<void> {
    if (this.disposed) return
    if (this.scanning) {
      this.rescanQueued = true
      return
    }
    this.scanning = true
    try {
      await this.doRescan()
    } finally {
      this.scanning = false
      if (this.rescanQueued) {
        this.rescanQueued = false
        this.scheduleRescan()
      }
    }
  }

  private async doRescan(): Promise<void> {
    this.watchRoots()

    this.headScansSeen.clear()
    this.statByFile.clear()
    const slugsByRoot = new Map<string, string[]>()
    const slugsOf = (root: string): string[] => {
      let v = slugsByRoot.get(root)
      if (!v) slugsByRoot.set(root, (v = this.listProjectSlugs(root)))
      return v
    }
    const bindings = this.deps.runningBindings()
    this.lastRunningKey = [...bindings.keys()].join(',')
    const runningIds = new Set(bindings.keys())

    const sessionIdByTab = new Map([...bindings].map(([sid, tab]) => [tab, sid]))
    for (const l of this.launches.values()) l.sessionId = sessionIdByTab.get(l.tabId)
    const launches = [...this.launches.values()]

    const payload: WorkspaceRows[] = []
    const allRowsByWs = new Map<string, SessionRow[]>()
    const wsBySession = new Map<string, string>()
    const bucketDirById = new Map<string, string>()
    const bucketMtimeById = new Map<string, number>()
    const bucketDirs: string[] = []
    const workspaceSlugs: string[] = []
    const wantedBucketDirs = new Set<string>()

    for (const ws of this.layout.workspaces) {
      const { key, root, scanPath, missing } = this.scope(ws.path)
      workspaceSlugs.push(encodeCwd(scanPath))
      const slugs = slugsOf(root)
      const wtDirs = (await this.worktreeEntries(ws.path)).map((e) => e.dir)
      const buckets = resolveBuckets(scanPath, {
        gitWorktreeList: () => wtDirs,
        listProjectSlugs: () => slugs,
        readFirstCwd: (slug) => this.readFirstCwd(root, slug)
      })
      if (key) for (const b of buckets) b.host = key.host
      if (key && scanPath !== key.path) {
        for (const l of launches) if (l.host === key.host && l.cwd === key.path) l.cwd = scanPath
      }
      const dirBySlug = new Map(buckets.map((b) => [b.slug, b.dir]))
      const wsRunningIds = key
        ? new Set([...runningIds, ...(this.deps.remoteRunning?.(key.host) ?? [])])
        : runningIds
      const claudeRow = (r: BackendSessionRow): SessionRow => ({
        ...r,
        ...sourceOf('claude', ws.path)
      })
      const allRows = aggregateSessions(buckets, {
        listJsonl: (slug) => {
          const files = this.listJsonl(root, slug)
          const dir = dirBySlug.get(slug)
          if (dir) {
            for (const f of files) {
              const prev = bucketMtimeById.get(f.id)
              if (prev === undefined || f.mtime > prev) {
                bucketMtimeById.set(f.id, f.mtime)
                bucketDirById.set(f.id, dir)
              }
            }
          }
          return files
        },
        readMeta: (slug, id) => this.readMeta(root, slug, id, dirBySlug.get(slug) ?? scanPath),
        runningIds: wsRunningIds,
        dirExists: key ? () => true : dirExistsSync,
        now: Date.now
      }).map(claudeRow)
      if (!key) {
        const additional = (this.deps.additionalRows?.(ws.path) ?? []).map((r): SessionRow => ({
          ...r,
          ...sourceOf('codex', ws.path)
        }))
        for (const r of additional) bucketDirById.set(r.id, r.cwd)
        for (const r of additional) {
          if (r.pending) continue
          const at = allRows.findIndex((x) => (x.createdAt ?? 0) < (r.createdAt ?? 0))
          allRows.splice(at < 0 ? allRows.length : at, 0, r)
        }
        allRows.unshift(...additional.filter((r) => r.pending))
      }
      allRowsByWs.set(ws.path, allRows)
      for (const r of allRows) wsBySession.set(r.id, ws.path)
      const owned = new Set([...this.ownedClaudeIds(), ...(this.deps.additionalMembers?.() ?? [])])
      const rows = filterOwned(allRows, owned, wsRunningIds)
      for (const b of buckets) {
        bucketDirs.push(b.dir)
        wantedBucketDirs.add(path.join(root, b.slug))
      }
      const pending = resolvePending(buckets, launches, rows, Date.now())
      for (const tabId of pending.promoted) this.launches.delete(tabId)
      payload.push({
        workspace: {
          path: ws.path,
          missing,
          isGit: key
            ? (this.deps.remoteGit?.(key.host, key.path)?.isGit ?? false)
            : !missing && isGitCheckout(ws.path),
          hasHistory: hasHistory(allRows, owned, wsRunningIds),
          ...(key
            ? {
                remote: {
                  host: key.host,
                  path: key.path,
                  connected: this.deps.remoteConnected?.(key.host) ?? false
                }
              }
            : {})
        },
        rows: [...pending.rows.map(claudeRow), ...rows]
      })
    }

    this.state = { bucketDirs, workspaceSlugs }
    this.reconcileBucketWatchers(wantedBucketDirs)
    for (const file of this.headScans.keys()) {
      if (!this.headScansSeen.has(file)) this.headScans.delete(file)
    }
    this.statByFile.clear()

    // CC§2
    const liveIds = new Set<string>(runningIds)
    for (const root of this.roots()) {
      for (const slug of slugsOf(root))
        for (const id of this.listJsonlIds(root, slug)) liveIds.add(id)
    }
    for (const t of this.remoteTargets()) {
      for (const id of this.deps.remoteRunning?.(t.host) ?? []) liveIds.add(id)
    }
    for (const key of this.deps.additionalMembers?.() ?? []) liveIds.add(key)
    const gc = gcSessions(this.layout.sessions, liveIds)
    if (gc.changed) {
      this.layout = { ...this.layout, sessions: gc.sessions }
      this.deps.saveLayout(this.layout)
    }

    this.bucketDirById = bucketDirById
    this.rowsCache = this.stampLive(payload)
    this.allRowsCache = allRowsByWs
    this.wsBySession = wsBySession
    this.deps.pushRows(this.rowsCache)
    this.firstScanDone()
    this.deps.onRescanned?.(this.layout.workspaces.map((w) => w.path))
  }

  private stampLive(rows: WorkspaceRows[]): WorkspaceRows[] {
    const liveById = this.deps.liveSessions?.() ?? new Map<string, LiveSession>()
    const dirOk = new Map<string, boolean>()
    return rows.map((e) => ({
      ...e,
      workspace: { ...e.workspace, freshness: this.deps.freshness?.(e.workspace.path) },
      rows: e.rows.map((r) => {
        const live = liveById.get(r.id)
        const wt = live?.relocated && !live.remote ? (live.worktree ?? 'main') : undefined
        const revealDir = this.revealDirOf(r.id, live, !!e.workspace.remote, dirOk)
        const moved = wt && wt !== r.worktree
        if (!moved && revealDir === r.revealDir) return r
        return { ...r, ...(moved ? { worktree: wt } : {}), revealDir }
      })
    }))
  }

  restampLive(): void {
    this.rowsCache = this.stampLive(this.rowsCache)
    this.deps.pushRows(this.rowsCache)
  }

  private roots(): string[] {
    const out = [this.deps.projectsRoot]
    for (const ws of this.layout.workspaces) {
      const { root } = this.scope(ws.path)
      if (!out.includes(root)) out.push(root)
    }
    return out
  }

  private watchRoots(): void {
    const roots = new Set(this.roots())
    for (const [root, w] of this.rootWatchers) {
      if (!roots.has(root)) {
        w.close()
        this.rootWatchers.delete(root)
      }
    }
    for (const root of roots) if (!this.rootWatchers.has(root)) this.watchRoot(root)
  }

  private watchRoot(root: string): void {
    try {
      const watcher = fs.watch(root, (_event, filename) => {
        if (!filename) return
        if (
          planRescan({ kind: 'projects-dir-added', dirName: filename.toString() }, this.state) ===
          'rescan'
        ) {
          this.scheduleRescan()
        }
      })
      watcher.on('error', () => {
        watcher.close()
        this.rootWatchers.delete(root)
      })
      this.rootWatchers.set(root, watcher)
    } catch {}
  }

  private reconcileBucketWatchers(wanted: Set<string>): void {
    for (const [dir, watcher] of this.bucketWatchers) {
      if (!wanted.has(dir)) {
        watcher.close()
        this.bucketWatchers.delete(dir)
      }
    }
    for (const dir of wanted) {
      if (this.bucketWatchers.has(dir)) continue
      try {
        const watcher = fs.watch(dir, () => this.scheduleRescan())
        watcher.on('error', () => {
          watcher.close()
          this.bucketWatchers.delete(dir)
        })
        this.bucketWatchers.set(dir, watcher)
      } catch {}
    }
  }

  private scope(wsPath: string): {
    key: RemoteKey | null
    root: string
    scanPath: string
    missing: boolean
  } {
    const key = parseRemoteKey(wsPath)
    return {
      key,
      root: key ? this.deps.remoteProjectsRoot(key.host) : this.deps.projectsRoot,
      scanPath: key ? this.realRemotePath(key) : wsPath,
      missing: key ? false : !dirExistsSync(wsPath)
    }
  }

  private listProjectSlugs(root: string): string[] {
    try {
      return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      return []
    }
  }

  private listJsonl(
    root: string,
    slug: string,
    stats = this.statByFile
  ): { id: string; mtime: number }[] {
    const dir = path.join(root, slug)
    let names: fs.Dirent[]
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: { id: string; mtime: number }[] = []
    for (const e of names) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
      try {
        const file = path.join(dir, e.name)
        const st = fs.statSync(file)
        stats.set(file, { size: st.size, mtimeMs: st.mtimeMs })
        out.push({ id: e.name.slice(0, -'.jsonl'.length), mtime: st.mtimeMs })
      } catch {}
    }
    return out
  }

  private listJsonlIds(root: string, slug: string): string[] {
    try {
      return fs
        .readdirSync(path.join(root, slug), { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => e.name.slice(0, -'.jsonl'.length))
    } catch {
      return []
    }
  }

  private scanHead(file: string, stats = this.statByFile): Partial<SessionMeta> {
    this.headScansSeen.add(file)
    let st = stats.get(file)
    if (!st) {
      try {
        const s = fs.statSync(file)
        st = { size: s.size, mtimeMs: s.mtimeMs }
      } catch {
        st = undefined
      }
    }
    const prev = this.headScans.get(file)
    if (prev && st) {
      const same = prev.final
        ? st.size >= prev.size
        : st.size === prev.size && st.mtimeMs === prev.mtimeMs
      if (same) return prev.meta
    }
    const probe = { opened: false, eof: false }
    const meta = extractJsonlMeta(jsonlHeadLines(file, probe))
    if (st && probe.opened) this.headScans.set(file, { ...st, meta, final: !probe.eof })
    return meta
  }

  private scanTail(file: string): JsonlTail {
    const st = this.statByFile.get(file)
    const head = this.headScans.get(file)
    const prev = head?.tail
    if (prev && st && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return prev.tail
    const tail = extractJsonlTail(jsonlTailLines(file))
    if (head && st) head.tail = { ...st, tail }
    return tail
  }

  // CC§2
  private readFirstCwd(
    root: string,
    slug: string,
    files = this.listJsonl(root, slug),
    stats = this.statByFile
  ): string | null {
    for (const f of files.slice(0, 3)) {
      const cwd = this.scanHead(path.join(root, slug, f.id + '.jsonl'), stats).cwd
      if (cwd) return cwd
    }
    return null
  }

  private readMeta(root: string, slug: string, id: string, bucketDir: string): SessionMeta {
    const file = path.join(root, slug, id + '.jsonl')
    const partial: Partial<SessionMeta> = { ...this.scanHead(file) }
    // CC§4
    if (partial.worktreeState) {
      const tail = this.scanTail(file)
      if (tail.worktreeState === null) {
        partial.worktreeState = undefined
        partial.cwd = tail.relocatedCwd
      } else if (tail.worktreeState) partial.worktreeState = tail.worktreeState
    }
    try {
      const sidecar = fs.readFileSync(file.replace(/\.jsonl$/, '.title'), 'utf8').trim()
      if (sidecar) partial.aiTitle = sidecar
    } catch {}
    let timestamp = partial.timestamp
    if (!timestamp) {
      try {
        timestamp = new Date(fs.statSync(file).mtimeMs).toISOString()
      } catch {
        timestamp = new Date(0).toISOString()
      }
    }
    return { ...partial, cwd: partial.cwd ?? bucketDir, timestamp }
  }
}
