import fs from 'fs'
import path from 'path'
import type { BackendSessionRow, DiscoveredFolder, SessionRow } from '@shared/types'
import {
  aggregateSessions,
  extractJsonlMeta,
  extractJsonlTail,
  planRescan,
  resolveBuckets,
  resolvePending,
  type Bucket,
  type JsonlTail,
  type PendingLaunch,
  type RescanState,
  type SessionMeta
} from './sessionAggregate'
import { encodeCwd } from '@shared/cwdKey'
import { dirExists } from '../../../main/fileTree'
import { parseRemoteKey, type RemoteKey } from '@shared/remoteKey'
import { sourceOf } from '@shared/sessionBackend'
import type { SearchCandidate } from '@core/agent/search'
import type { SessionPlace } from '@core/agent/usage'
import { mapAtMost } from '@core/mapAtMost'
import { BackgroundFile } from '../../../main/backgroundFile'
import type { SessionTracker } from './sessionTracker'
import {
  filterOwned,
  hasHistory,
  type KeptInLayout,
  type RowsNow,
  type RowsPass,
  type RowsPassStart,
  type SessionRowsSource,
  type WhereNow,
  type WorkspacePlace,
  type WorkspaceSessions
} from '@core/agent/sessionRows'

// PLATFORM§40
const RELIST_A_PROJECTS_ROOT_THE_WATCHER_MAY_HAVE_MISSED_EVERY_MS = 2000
const A_REMOVED_WORKTREE_SESSION_ENDS_WITHIN_MS = 10_000
const JSONL_SCAN_CAP = 256 * 1024
// CC§2
const JSONL_TAIL_FIRST_READ_BYTES = 64 * 1024
const TRANSCRIPTS_OPEN_AT_ONCE = 16

interface ListedTranscript {
  id: string
  mtime: number
  hasTitleSidecar: boolean
}

interface FileStamp {
  size: number
  mtimeMs: number
  ino: number
}

interface HeadScan extends FileStamp {
  meta: Partial<SessionMeta>
  // CC§2
  final: boolean
  tail?: FileStamp & { tail: JsonlTail }
}

interface HeadCacheFile {
  version: string
  heads: [string, HeadScan][]
}

export interface LiveSession {
  treeRoot: string
  worktree?: string
  remote?: boolean
  relocated?: boolean
}

export function liveSessionsOf(tracker: Pick<SessionTracker, 'list'>): Map<string, LiveSession> {
  const m = new Map<string, LiveSession>()
  for (const s of tracker.list()) {
    if (!s.alive || !s.sessionId) continue
    m.set(s.sessionId, {
      treeRoot: s.treeRoot,
      worktree: s.worktree,
      remote: !!s.remote,
      relocated: s.relocated
    })
  }
  return m
}

export interface ClaudeSessionStoreDeps {
  projectsRoot: string
  headCache?: { file: string; version: string }
  remoteProjectsRoot(host: string): string
  pinnedPaths(): string[]
  remoteTargets(): { host: string; paths: string[] }[]
  kept: KeptInLayout
  rereadRows(): void
  rereadGrownRows(): void
  runningBindings(): Map<string, string>
  liveSessions?(): Map<string, LiveSession>
  remoteRunning?(host: string): Set<string>
  sessionsOnDiskOrRunning?(ids: ReadonlySet<string>): void
  memberDropped?(sessionId: string, why: string): void
}

async function stampOf(file: string): Promise<FileStamp | undefined> {
  try {
    const st = await fs.promises.stat(file)
    return { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }
  } catch {
    return undefined
  }
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino
}

function* linesUntilExhausted(lines: string[], probe: { exhausted: boolean }): Generator<string> {
  yield* lines
  probe.exhausted = true
}

async function readJsonlHeadMeta(
  file: string
): Promise<{ meta: Partial<SessionMeta>; opened: boolean; eof: boolean }> {
  let fh: fs.promises.FileHandle
  try {
    fh = await fs.promises.open(file, 'r')
  } catch {
    return { meta: {}, opened: false, eof: false }
  }
  try {
    const buf = Buffer.allocUnsafe(JSONL_SCAN_CAP)
    let total = 0
    let hitEnd = false
    while (total < JSONL_SCAN_CAP) {
      const { bytesRead } = await fh.read(buf, total, JSONL_SCAN_CAP - total, null)
      if (bytesRead <= 0) {
        hitEnd = true
        break
      }
      total += bytesRead
    }
    const probe = { exhausted: false }
    const lines = buf.toString('utf8', 0, total).split('\n')
    const meta = extractJsonlMeta(linesUntilExhausted(lines, probe))
    return { meta, opened: true, eof: probe.exhausted && hitEnd }
  } finally {
    await fh.close()
  }
}

async function readJsonlTailLines(file: string, untilWorktreeRecord: boolean): Promise<string[]> {
  let fh: fs.promises.FileHandle
  try {
    fh = await fs.promises.open(file, 'r')
  } catch {
    return []
  }
  try {
    let start = (await fh.stat()).size
    let tail = Buffer.alloc(0)
    for (let chunk = JSONL_TAIL_FIRST_READ_BYTES; ; chunk *= 2) {
      const from = Math.max(0, start - chunk)
      const head = Buffer.alloc(start - from)
      await fh.read(head, 0, head.length, from)
      tail = Buffer.concat([head, tail])
      start = from
      const lines = tail.toString('utf8').split('\n')
      const whole = start === 0 ? lines : lines.slice(1)
      if (start === 0 || !untilWorktreeRecord) return whole
      const holdsWorktreeRecord = whole.some(
        (l) => l.includes('"type":"worktree-state"') || l.includes('"type":"relocated"')
      )
      if (holdsWorktreeRecord) return whole
    }
  } finally {
    await fh.close()
  }
}

export class ClaudeSessionStore implements SessionRowsSource {
  private allRowsCache = new Map<string, SessionRow[]>()
  private wsBySession = new Map<string, string>()
  private bucketDirById = new Map<string, string>()
  private transcriptFileById = new Map<string, string>()
  private state: RescanState = { bucketDirs: [], workspaceSlugs: [] }
  private launches = new Map<string, PendingLaunch>()
  private leavingTheirWorktree = new Map<string, { tabId: string; tabEnded: boolean }>()
  private rootWatchers = new Map<string, { close(): void }>()
  private slugsListedByLastScan = new Map<string, Set<string>>()
  private bucketWatchers = new Map<string, fs.FSWatcher>()
  private headScans = new Map<string, HeadScan>()
  private headScansSeen = new Set<string>()
  private headCacheLoaded: Promise<void> = Promise.resolve()
  private headDisk?: BackgroundFile
  private headScansChanged = false
  private headCacheSavedOnce = false
  private statByFile = new Map<string, FileStamp>()
  private knownTranscripts = new Set<string>()
  private appendedTranscripts = new Set<string>()

  constructor(private deps: ClaudeSessionStoreDeps) {
    const cache = deps.headCache
    if (cache) this.headDisk = new BackgroundFile(() => cache.file)
  }

  start(): void {
    this.headCacheLoaded = this.loadHeadCache()
    this.watchRoots()
  }

  private async loadHeadCache(): Promise<void> {
    const cache = this.deps.headCache
    if (!cache) return
    try {
      const saved = JSON.parse(await fs.promises.readFile(cache.file, 'utf8')) as HeadCacheFile
      if (saved.version !== cache.version) return
      for (const [file, head] of saved.heads)
        if (!this.headScans.has(file)) this.headScans.set(file, head)
    } catch {}
  }

  private saveHeadCache(): void {
    const cache = this.deps.headCache
    if (!cache || !this.headScansChanged) return
    this.headScansChanged = false
    const saved: HeadCacheFile = { version: cache.version, heads: [...this.headScans] }
    this.headDisk?.write(JSON.stringify(saved))
  }

  historyRows(wsPath: string): SessionRow[] {
    const running = new Set(this.deps.runningBindings().keys())
    const { key } = this.scope(wsPath)
    if (key) for (const id of this.deps.remoteRunning?.(key.host) ?? []) running.add(id)
    return (this.allRowsCache.get(wsPath) ?? [])
      .filter((r) => !this.isMember(r.id) && !running.has(r.id))
      .sort((a, b) => b.mtime - a.mtime)
  }

  searchableRows(): SearchCandidate[] {
    return [...this.allRowsCache].flatMap(([workspacePath, rows]) =>
      rows.map((row) => ({ row, workspacePath, file: this.transcriptFileById.get(row.id) }))
    )
  }

  transcriptFiles(): { file: string; workspace: string }[] {
    return [...this.transcriptFileById].flatMap(([id, file]) => {
      const workspace = this.wsBySession.get(id)
      return workspace ? [{ file, workspace }] : []
    })
  }

  sessionPlaces(): Map<string, SessionPlace> {
    return new Map(
      [...this.allRowsCache].flatMap(([workspace, rows]) =>
        rows.map((r) => [r.id, { workspace, title: r.title }] as const)
      )
    )
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

  bucketDirOf(sessionId: string): string | undefined {
    return this.bucketDirById.get(sessionId)
  }

  transcriptFileOf(sessionId: string): string | undefined {
    return this.transcriptFileById.get(sessionId)
  }

  isMember(sessionId: string): boolean {
    return this.deps.kept.list().includes(sessionId)
  }

  members(): ReadonlySet<string> {
    return new Set(this.deps.kept.list())
  }

  // CC§2
  private async claudeUsedFolders(): Promise<DiscoveredFolder[]> {
    const stats = new Map<string, FileStamp>()
    const projects = this.deps.projectsRoot
    const used: DiscoveredFolder[] = []
    for (const slug of await this.listProjectSlugs(projects)) {
      const files = await this.listJsonl(projects, slug, stats)
      const cwd = await this.readFirstCwd(projects, slug, files, stats)
      if (!cwd) continue
      const use = { sessions: files.length, mtime: Math.max(...files.map((f) => f.mtime)) }
      used.push({ path: cwd, ...use, agents: { claude: use } })
    }
    return used
  }

  usedFolders(): Promise<DiscoveredFolder[]> {
    return this.claudeUsedFolders()
  }

  launchStarted(
    tabId: string,
    cwd: string,
    worktree?: string,
    host?: string,
    pickedSessionId?: string
  ): void {
    this.launches.set(tabId, { tabId, cwd, worktree, host, pickedSessionId })
    this.scheduleRescan()
  }

  leavingWorktree(sessionId: string, tabId: string): void {
    this.leavingTheirWorktree.set(sessionId, { tabId, tabEnded: false })
    this.scheduleRescan()
  }

  leftWorktree(sessionId: string, removed: boolean): void {
    const leaving = this.leavingTheirWorktree.get(sessionId)
    if (!leaving) return
    const showAgain = (): void => {
      if (this.leavingTheirWorktree.get(sessionId) !== leaving) return
      this.leavingTheirWorktree.delete(sessionId)
      this.scheduleRescan()
    }
    if (!removed) return showAgain()
    leaving.tabEnded = true
    setTimeout(showAgain, A_REMOVED_WORKTREE_SESSION_ENDS_WITHIN_MS).unref()
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

  archiveSession(sessionId: string): boolean {
    if (!this.deps.kept.list().includes(sessionId)) return false
    if (this.deps.runningBindings().has(sessionId)) return false
    this.forget(sessionId, 'archived from the sidebar')
    return true
  }

  dropOwnership(sessionId: string, why: string): void {
    if (this.deps.kept.list().includes(sessionId)) this.forget(sessionId, why)
  }

  private forget(sessionId: string, why: string): void {
    this.deps.memberDropped?.(sessionId, why)
    this.deps.kept.remove(sessionId)
  }

  onSessionBound(sessionId: string): void {
    this.adopt([sessionId])
  }

  adopt(sessionIds: string[]): void {
    this.deps.kept.add(sessionIds)
  }

  whereNow(): WhereNow {
    const liveById = this.deps.liveSessions?.() ?? new Map<string, LiveSession>()
    return (r) => {
      const live = liveById.get(r.id)
      const wt = live?.relocated && !live.remote ? (live.worktree ?? 'main') : undefined
      return { dir: live?.treeRoot ?? this.bucketDirOf(r.id), worktree: wt }
    }
  }

  liveKey(): string {
    const parts: string[] = []
    for (const [id, s] of this.deps.liveSessions?.() ?? []) parts.push(id + '\0' + s.treeRoot)
    return parts.join(',')
  }

  sessionsRunningOnTheMachine(wsPath: string): string[] {
    const { key } = this.scope(wsPath)
    if (!key) return []
    const mine = new Set((this.allRowsCache.get(wsPath) ?? []).map((r) => r.id))
    return [...(this.deps.remoteRunning?.(key.host) ?? [])].filter((id) => mine.has(id))
  }

  dispose(): void {
    this.saveHeadCache()
    this.headDisk?.flushSync()
    for (const w of this.rootWatchers.values()) w.close()
    this.rootWatchers.clear()
    for (const w of this.bucketWatchers.values()) w.close()
    this.bucketWatchers.clear()
  }

  private scheduleRescan(): void {
    this.deps.rereadRows()
  }

  private armRescan(): void {
    this.deps.rereadGrownRows()
  }

  rowsReady(): Promise<void> {
    return this.headCacheLoaded
  }

  rowsPass({ everywhere, bindings: boundAtStart, keptByAnother }: RowsPassStart): RowsPass {
    this.watchRoots()

    const appended = [...this.appendedTranscripts]
    this.appendedTranscripts.clear()
    this.headScansSeen.clear()
    if (everywhere) this.statByFile.clear()
    else {
      for (const file of appended) this.statByFile.delete(file)
      for (const id of boundAtStart.keys()) {
        const file = this.transcriptFileById.get(id)
        if (file) this.statByFile.delete(file)
      }
    }
    const slugsByRoot = new Map<string, Promise<string[]>>()
    const slugsOf = (root: string): Promise<string[]> => {
      let v = slugsByRoot.get(root)
      if (!v) slugsByRoot.set(root, (v = this.listProjectSlugs(root)))
      return v
    }
    for (const [id, leaving] of this.leavingTheirWorktree) {
      const tab = boundAtStart.get(id)
      if (tab && tab !== leaving.tabId) this.leavingTheirWorktree.delete(id)
    }
    const launches = [...this.launches.values()]

    const allRowsByWs = new Map<string, SessionRow[]>()
    const wsBySession = new Map<string, string>()
    const bucketDirById = new Map<string, string>()
    const transcriptFileById = new Map<string, string>()
    const bucketMtimeById = new Map<string, number>()
    const bucketDirs: string[] = []
    const workspaceSlugs: string[] = []
    const wantedBucketDirs = new Set<string>()
    const listed = new Set<string>()
    const owned = new Set(this.deps.kept.list())

    const rowsIn = async (ws: WorkspacePlace, now: () => RowsNow): Promise<WorkspaceSessions> => {
      const { key, root } = this.scope(ws.path)
      const scanPath = ws.realPath
      workspaceSlugs.push(encodeCwd(scanPath))
      const slugs = await slugsOf(root)
      const wtDirs = await ws.worktreeDirs()
      const buckets = await this.resolveBucketsReadingAhead(root, scanPath, wtDirs, slugs)
      if (key) for (const b of buckets) b.host = key.host
      if (key && scanPath !== key.path) {
        for (const l of launches) if (l.host === key.host && l.cwd === key.path) l.cwd = scanPath
      }
      const dirBySlug = new Map(buckets.map((b) => [b.slug, b.dir]))
      const claudeRow = (r: BackendSessionRow): SessionRow => ({
        ...r,
        ...sourceOf('claude', ws.path)
      })
      const disk = await this.readBuckets(root, scanPath, buckets, dirBySlug, !key)
      const { bindings, running: wsRunningIds, hidden: hiddenByKoloft } = now()
      const hidden = (id: string): boolean =>
        this.leavingTheirWorktree.has(id) || hiddenByKoloft(id)
      const sessionIdByTab = new Map([...bindings].map(([sid, tab]) => [tab, sid]))
      for (const l of launches) l.sessionId = sessionIdByTab.get(l.tabId)
      const allRows = aggregateSessions(buckets, {
        listJsonl: (slug) => {
          const files = disk.files.get(slug) ?? []
          const dir = dirBySlug.get(slug)
          if (dir) {
            for (const f of files) {
              const prev = bucketMtimeById.get(f.id)
              if (prev === undefined || f.mtime > prev) {
                bucketMtimeById.set(f.id, f.mtime)
                bucketDirById.set(f.id, dir)
                transcriptFileById.set(f.id, path.join(root, slug, f.id + '.jsonl'))
              }
            }
          }
          return files
        },
        readMeta: (slug, id) => disk.meta.get(path.join(slug, id))!,
        runningIds: wsRunningIds,
        dirExists: key ? () => true : (dir) => disk.dirs.get(dir) ?? false,
        now: Date.now
      }).map(claudeRow)
      allRowsByWs.set(ws.path, [...allRows])
      for (const r of allRows) wsBySession.set(r.id, ws.path)
      for (const r of filterOwned(allRows, owned, wsRunningIds)) listed.add(r.id)
      const visible = allRows
        .filter((r) => !hidden(r.id))
        .map((r) => (!r.running && wsRunningIds.has(r.id) ? { ...r, running: true } : r))
      const ownedOrRunning = filterOwned(visible, owned, wsRunningIds)
      for (const b of buckets) {
        bucketDirs.push(b.dir)
        wantedBucketDirs.add(path.join(root, b.slug))
      }
      const pending = resolvePending(buckets, launches, ownedOrRunning, Date.now())
      const startingTabs = new Set(pending.rows.filter((r) => r.pending).map((r) => r.id))
      const awaitingTheirTab = new Set(
        launches.flatMap((l) =>
          startingTabs.has(l.tabId) && l.pickedSessionId ? [l.pickedSessionId] : []
        )
      )
      const rows = ownedOrRunning.filter((r) => !awaitingTheirTab.has(r.id))
      for (const tabId of pending.promoted) this.launches.delete(tabId)
      for (const r of pending.rows) wsBySession.set(r.id, ws.path)
      return {
        starting: pending.rows.filter((r) => !hidden(r.id)).map(claudeRow),
        kept: rows,
        ids: [...allRows, ...pending.rows].map((r) => r.id),
        hasMore: hasHistory(visible, owned, wsRunningIds)
      }
    }

    const done = async (): Promise<void> => {
      for (const [id, leaving] of this.leavingTheirWorktree)
        if (leaving.tabEnded && !listed.has(id)) this.leavingTheirWorktree.delete(id)
      this.state = { bucketDirs, workspaceSlugs }
      for (const [root, slugs] of slugsByRoot) {
        this.slugsListedByLastScan.set(root, new Set(await slugs))
      }
      this.reconcileBucketWatchers(wantedBucketDirs)
      for (const file of this.headScans.keys()) {
        if (this.headScansSeen.has(file)) continue
        this.headScans.delete(file)
        this.headScansChanged = true
      }
      this.knownTranscripts = new Set(this.statByFile.keys())
      if (everywhere) await this.dropMembersWithoutTranscript(slugsOf, keptByAnother)
      else if (appended.some((file) => !this.statByFile.has(file))) this.scheduleRescan()

      this.bucketDirById = bucketDirById
      this.transcriptFileById = transcriptFileById
    }

    const shown = (): void => {
      this.allRowsCache = allRowsByWs
      this.wsBySession = wsBySession
      if (!this.headCacheSavedOnce) {
        this.headCacheSavedOnce = true
        this.saveHeadCache()
      }
    }

    return { in: rowsIn, done, shown }
  }

  // CC§2
  private async dropMembersWithoutTranscript(
    slugsOf: (root: string) => Promise<string[]>,
    keptByAnother: (id: string) => boolean
  ): Promise<void> {
    const liveIds = new Set<string>()
    for (const root of this.roots()) {
      const slugs = await slugsOf(root)
      for (const ids of await Promise.all(slugs.map((slug) => this.listJsonlIds(root, slug))))
        for (const id of ids) liveIds.add(id)
    }
    for (const id of this.deps.runningBindings().keys()) liveIds.add(id)
    for (const t of this.deps.remoteTargets()) {
      for (const id of this.deps.remoteRunning?.(t.host) ?? []) liveIds.add(id)
    }
    const members: string[] = []
    for (const id of this.deps.kept.list()) {
      if (liveIds.has(id)) members.push(id)
      else if (!keptByAnother(id))
        this.deps.memberDropped?.(id, 'no transcript found and not running')
    }
    this.deps.sessionsOnDiskOrRunning?.(liveIds)
    this.deps.kept.keepOnly(members)
  }

  private async resolveBucketsReadingAhead(
    root: string,
    scanPath: string,
    wtDirs: string[],
    slugs: string[]
  ): Promise<Bucket[]> {
    const firstCwd = new Map<string, string | null>()
    for (;;) {
      const asked = new Set<string>()
      const buckets = resolveBuckets(scanPath, {
        gitWorktreeList: () => wtDirs,
        listProjectSlugs: () => slugs,
        readFirstCwd: (slug) => {
          const cwd = firstCwd.get(slug)
          if (cwd === undefined) asked.add(slug)
          return cwd ?? null
        }
      })
      if (!asked.size) return buckets
      await mapAtMost([...asked], TRANSCRIPTS_OPEN_AT_ONCE, async (slug) =>
        firstCwd.set(slug, await this.readFirstCwd(root, slug))
      )
    }
  }

  private async readBuckets(
    root: string,
    scanPath: string,
    buckets: Bucket[],
    dirBySlug: Map<string, string>,
    local: boolean
  ): Promise<{
    files: Map<string, ListedTranscript[]>
    meta: Map<string, SessionMeta>
    dirs: Map<string, boolean>
  }> {
    const slugs = [...new Set(buckets.map((b) => b.slug))]
    const files = new Map(
      await Promise.all(slugs.map(async (s) => [s, await this.listJsonl(root, s)] as const))
    )
    const transcripts = slugs.flatMap((s) => (files.get(s) ?? []).map((f) => [s, f] as const))
    const meta = new Map(
      await mapAtMost(
        transcripts,
        TRANSCRIPTS_OPEN_AT_ONCE,
        async ([s, f]) =>
          [
            path.join(s, f.id),
            await this.readMeta(root, s, f, dirBySlug.get(s) ?? scanPath)
          ] as const
      )
    )
    const cwds = local ? [...new Set([...meta.values()].map((m) => m.cwd))] : []
    const dirs = new Map(await Promise.all(cwds.map(async (d) => [d, await dirExists(d)] as const)))
    return { files, meta, dirs }
  }

  private roots(): string[] {
    const out = [this.deps.projectsRoot]
    for (const wsPath of this.deps.pinnedPaths()) {
      const { root } = this.scope(wsPath)
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
      fs.mkdirSync(root, { recursive: true })
    } catch {}
    const onEntry = (name: string): void => {
      if (planRescan({ kind: 'projects-dir-added', dirName: name }, this.state) === 'rescan') {
        this.scheduleRescan()
      }
    }
    // PLATFORM§40
    const relist = (now: fs.Stats, before: fs.Stats): void => {
      if (now.mtimeMs === before.mtimeMs) return
      void this.listProjectSlugs(root).then((names) => {
        const listed = this.slugsListedByLastScan.get(root)
        for (const name of names) if (!listed?.has(name)) onEntry(name)
      })
    }
    fs.watchFile(
      root,
      { persistent: false, interval: RELIST_A_PROJECTS_ROOT_THE_WATCHER_MAY_HAVE_MISSED_EVERY_MS },
      relist
    )
    let watcher: fs.FSWatcher | undefined
    try {
      watcher = fs.watch(root, (_event, filename) => {
        if (filename) onEntry(filename.toString())
      })
      watcher.on('error', () => watcher?.close())
    } catch {}
    this.rootWatchers.set(root, {
      close: () => {
        watcher?.close()
        fs.unwatchFile(root, relist)
        this.slugsListedByLastScan.delete(root)
      }
    })
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
        // PLATFORM§40
        const watcher = fs.watch(dir, (_event, filename) => {
          if (!filename) return this.scheduleRescan()
          this.onBucketEntryChanged(path.join(dir, filename.toString()))
        })
        watcher.on('error', () => {
          watcher.close()
          this.bucketWatchers.delete(dir)
        })
        this.bucketWatchers.set(dir, watcher)
      } catch {}
    }
  }

  // PLATFORM§40
  private onBucketEntryChanged(file: string): void {
    if (this.isLiveTranscript(file)) return
    if (!this.knownTranscripts.has(file)) return this.scheduleRescan()
    this.appendedTranscripts.add(file)
    this.armRescan()
  }

  private isLiveTranscript(file: string): boolean {
    if (!this.knownTranscripts.has(file)) return false
    return this.deps.runningBindings().has(path.basename(file, '.jsonl'))
  }

  private scope(wsPath: string): { key: RemoteKey | null; root: string } {
    const key = parseRemoteKey(wsPath)
    return {
      key,
      root: key ? this.deps.remoteProjectsRoot(key.host) : this.deps.projectsRoot
    }
  }

  private async listProjectSlugs(root: string): Promise<string[]> {
    try {
      return (await fs.promises.readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      return []
    }
  }

  private async listJsonl(
    root: string,
    slug: string,
    stats = this.statByFile
  ): Promise<ListedTranscript[]> {
    const dir = path.join(root, slug)
    let names: fs.Dirent[]
    try {
      names = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const files = new Set(names.filter((e) => e.isFile()).map((e) => e.name))
    const found = await Promise.all(
      names
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map(async (e) => {
          const file = path.join(dir, e.name)
          const id = e.name.slice(0, -'.jsonl'.length)
          const st = stats.get(file) ?? (await stampOf(file))
          if (!st) return null
          stats.set(file, st)
          return { id, mtime: st.mtimeMs, hasTitleSidecar: files.has(id + '.title') }
        })
    )
    return found.filter((f): f is ListedTranscript => f !== null)
  }

  private async listJsonlIds(root: string, slug: string): Promise<string[]> {
    try {
      return (await fs.promises.readdir(path.join(root, slug), { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => e.name.slice(0, -'.jsonl'.length))
    } catch {
      return []
    }
  }

  private async scanHead(file: string, stats = this.statByFile): Promise<Partial<SessionMeta>> {
    this.headScansSeen.add(file)
    const st = stats.get(file) ?? (await stampOf(file))
    const prev = this.headScans.get(file)
    if (prev && st) {
      const same = prev.final ? prev.ino === st.ino && st.size >= prev.size : sameStamp(prev, st)
      if (same) return prev.meta
    }
    const { meta, opened, eof } = await readJsonlHeadMeta(file)
    if (st && opened) {
      this.headScans.set(file, { ...st, meta, final: !eof })
      this.headScansChanged = true
    }
    return meta
  }

  private async scanTail(file: string, untilWorktreeRecord: boolean): Promise<JsonlTail> {
    const st = this.statByFile.get(file)
    const head = this.headScans.get(file)
    const prev = head?.tail
    if (prev && st && sameStamp(prev, st)) return prev.tail
    const tail = extractJsonlTail(await readJsonlTailLines(file, untilWorktreeRecord))
    if (head && st) {
      head.tail = { ...st, tail }
      this.headScansChanged = true
    }
    return tail
  }

  // CC§2
  private async readFirstCwd(
    root: string,
    slug: string,
    files?: { id: string; mtime: number }[],
    stats = this.statByFile
  ): Promise<string | null> {
    for (const f of (files ?? (await this.listJsonl(root, slug, stats))).slice(0, 3)) {
      const cwd = (await this.scanHead(path.join(root, slug, f.id + '.jsonl'), stats)).cwd
      if (cwd) return cwd
    }
    return null
  }

  private async readMeta(
    root: string,
    slug: string,
    { id, hasTitleSidecar }: ListedTranscript,
    bucketDir: string
  ): Promise<SessionMeta> {
    const file = path.join(root, slug, id + '.jsonl')
    const partial: Partial<SessionMeta> = { ...(await this.scanHead(file)) }
    // CC§4
    if (partial.worktreeState) {
      const tail = await this.scanTail(file, true)
      if (tail.worktreeState === null) {
        partial.worktreeState = undefined
        partial.cwd = tail.relocatedCwd
      } else if (tail.worktreeState) partial.worktreeState = tail.worktreeState
    }
    let sidecar = ''
    if (hasTitleSidecar) {
      try {
        sidecar = (await fs.promises.readFile(file.replace(/\.jsonl$/, '.title'), 'utf8')).trim()
      } catch {}
    }
    if (sidecar) partial.customTitle = sidecar
    // CC§9
    else if (partial.customTitle && this.headScans.get(file)?.final) {
      const renamed = (await this.scanTail(file, false)).customTitle
      if (renamed) partial.customTitle = renamed
    }
    let timestamp = partial.timestamp
    if (!timestamp) {
      timestamp = new Date(this.statByFile.get(file)?.mtimeMs ?? 0).toISOString()
    }
    return { ...partial, cwd: partial.cwd ?? bucketDir, timestamp }
  }
}
