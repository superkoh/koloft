import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { StringDecoder } from 'string_decoder'
import type {
  DiscoveredFolder,
  LayoutV4,
  ProjectInfo,
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
  planRescan,
  filterOwned,
  hasHistory,
  resolveBuckets,
  resolvePending,
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
import type { RemoteGitInfo } from './remote/install'

// Runtime owner of layout v4 + the multi-bucket aggregation (agent-centric §6):
// holds the persisted workspaces/sessions tables, runs debounced rescans off the
// trigger set (startup / add / SessionStart-outside-buckets / projects-root watch),
// and pushes the aggregated sidebar rows. All policy lives in the pure modules
// (sessionAggregate, workspaceOps); this file is their IO.

const RESCAN_DEBOUNCE_MS = 250
/** panel writes come from UI gestures (T1↔T2 toggle, tab open/close/navigate/reorder) —
 *  coalesce a burst into one layout write, and flush on dispose so a quit keeps the
 *  last one */
const PANEL_SAVE_DEBOUNCE_MS = 600
/** per-jsonl scan budget — summary/first-prompt/cwd live in the head of the file */
const JSONL_SCAN_CAP = 256 * 1024
/** how many folders the welcome offers to pin — a first-run list, not a browser */
const DISCOVER_MAX = 8

/** what one transcript's head yielded, remembered across rescans (WorkspaceManager.scanHead) */
interface HeadScan {
  size: number
  mtimeMs: number
  meta: Partial<SessionMeta>
  /** the scan stopped short of EOF — every field found, or the cap reached. Claude
   *  only ever appends to a transcript, so nothing later can change this answer. */
  final: boolean
}

/** One running session as the live tracker sees it. `worktree` is undefined for
 *  the checkout itself; for a remote session it is never resolved at all, which is what
 *  `remote` is here to say; `relocated` is SessionInfo.relocated. */
export interface LiveSession {
  treeRoot: string
  worktree?: string
  remote?: boolean
  relocated?: boolean
}

export interface WorkspaceManagerDeps {
  additionalRows?(workspacePath: string): SessionRow[]
  additionalMembers?(): Set<string>
  /** ~/.claude/projects */
  projectsRoot: string
  loadLayout(): LayoutV4
  saveLayout(layout: LayoutV4): void
  projectInfo(p: string): ProjectInfo
  /** live sessionId → tabId bindings in launch order (the tracker is the truth) */
  runningBindings(): Map<string, string>
  /** What the live tracker knows about each RUNNING session, by session id: the
   *  directory it is in right now (`treeRoot` — it follows claude into and out of a
   *  worktree, and for a remote session it is a path on that machine), the worktree that
   *  resolves to, and whether the session is remote. Read once per push (R7/R11). */
  liveSessions?(): Map<string, LiveSession>
  /** gracefully close one claude tab (same path as the terminal:kill IPC) */
  killTab(tabId: string): void
  pushRows(payload: WorkspaceRows[]): void
  /** git distance from origin's default branch, owned by the freshness engine;
   *  undefined = unknown, which the sidebar draws as nothing (D7/D10) */
  freshness?(wsPath: string): WorkspaceFreshness | undefined
  /** a rescan finished: the engine's cheap local tier rides along, fire-and-forget
   *  (§05 — never awaited, the push path must not wait on git) */
  onRescanned?(wsPaths: string[]): void
  /** how many scheduled jobs this workspace owns. A job dies with the pin and
   *  never comes back, so removal has to ask first even when nothing is running. */
  jobCountFor?(wsPath: string): number
  /** the mirror of a machine's ~/.claude/projects — this workspace's root instead of
   *  the local projectsRoot */
  remoteProjectsRoot(host: string): string
  /** session ids the machine's heartbeat last listed as alive (no `k-` prefix). A
   *  remote session's liveness comes from tmux, never from this Mac's process table. */
  remoteRunning?(host: string): Set<string>
  /** did the last heartbeat round for this machine succeed */
  remoteConnected?(host: string): boolean
  /** what the machine's heartbeat said about one pinned folder — its git facts and
   *  its own path with symlinks resolved; undefined until heard */
  remoteGit?(host: string, path: string): RemoteGitInfo | undefined
  /** end a session running on a machine that has no tab here (workspace removal) */
  killRemoteSession?(host: string, sessionId: string): void
}

function dirExistsSync(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Lazy line generator over a jsonl head, chunked + capped so a giant transcript
 *  never loads whole. StringDecoder keeps a multi-byte char split across chunk
 *  boundaries intact (titles are frequently CJK). `probe.opened` says the file was
 *  read at all (an open that failed — EMFILE mid-rescan, a permission blip — yields
 *  nothing and must not be remembered as the file's head); `probe.eof` is set when
 *  the read ran out of file, left false when the consumer stopped early or the cap
 *  hit, which is what lets scanHead reuse the result for good. */
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

/** git worktree checkouts for a repo root; [] when git is missing from PATH
 *  (packaged app under launchd — see projectInfo.ts) or the dir is not a repo,
 *  degrading aggregation to the root bucket. */
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
  /** resolved when the first rescan has filled rowsCache — the `workspace:rows`
   *  invoke awaits it so a cold renderer never mistakes the pre-scan empty cache
   *  for "nothing pinned" (the false zero-workspace toast, review find #3) */
  private firstScanDone!: () => void
  readonly firstScan: Promise<void> = new Promise((res) => {
    this.firstScanDone = res
  })
  /** the lifecycle contract D5: the UNFILTERED aggregation per workspace path. filterOwned
   *  discards the non-members and "Restore from history" is exactly that discard set,
   *  so the rows have to survive the rescan that computed them (memory cost: every
   *  jsonl-backed session of every pinned workspace). Also the resume planner's row
   *  source — a history session has no sidebar row to look up. */
  private allRowsCache = new Map<string, SessionRow[]>()
  /** the allRowsCache index workspaceOf answers from, built by the same rescan */
  private wsBySession = new Map<string, string>()
  /** the lifecycle contract §1✎: the bucket dir each aggregated transcript came from — the
   *  resume-START axis, independent of the binding. Kept beside the rows rather than
   *  on SessionRow, which is an IPC contract the renderer has no use for this in. */
  private bucketDirById = new Map<string, string>()
  private state: RescanState = { bucketDirs: [], workspaceSlugs: [] }
  /** launched-but-unmaterialized claude ptys, by tab id (§4 pending rows) */
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
  /** What each transcript's head yielded last time, by absolute path. A rescan fires
   *  on EVERY jsonl append in a pinned bucket (the dir watcher can't tell an append
   *  from a create), and re-opening every transcript of every pinned workspace —
   *  hundreds of files, up to 256KB each, all synchronous — stalled the main thread
   *  ~1s per live-session keystroke (2026-09-04 profile). Only a file whose size or
   *  mtime moved is read again; see scanHead for when even that is skipped. */
  private headScans = new Map<string, HeadScan>()
  /** transcript paths the rescan in flight met — anything else is evicted after it */
  private headScansSeen = new Set<string>()
  /** the stats listJsonl already took this rescan, so scanHead needn't stat twice */
  private statByFile = new Map<string, { size: number; mtimeMs: number }>()

  constructor(private deps: WorkspaceManagerDeps) {
    this.layout = deps.loadLayout()
  }

  /** trigger (a): startup */
  start(): void {
    this.watchRoots()
    this.scheduleRescan()
  }

  rows(): WorkspaceRows[] {
    return this.rowsCache
  }

  /** D5 "Restore from history": the workspace's sessions that are NOT working-set
   *  members — allRows − (owned ∪ running) — newest first. Empty for a path with no
   *  aggregation yet (never pinned, or the first rescan hasn't landed). */
  historyRows(wsPath: string): SessionRow[] {
    const running = new Set(this.deps.runningBindings().keys())
    const { key } = this.scope(wsPath)
    // a remote session with no tab of its own is still running on the machine
    if (key) for (const id of this.deps.remoteRunning?.(key.host) ?? []) running.add(id)
    return (this.allRowsCache.get(wsPath) ?? [])
      .filter((r) => !this.isMember(r.id) && !running.has(r.id))
      .sort((a, b) => b.mtime - a.mtime)
  }

  /** The aggregated row for one session id, members and history alike (the resume
   *  planner reads its worktree binding + cwd from here). */
  findRow(sessionId: string): SessionRow | undefined {
    for (const rows of this.allRowsCache.values()) {
      const hit = rows.find((r) => r.id === sessionId)
      if (hit) return hit
    }
    return undefined
  }

  /** The pinned workspace a session belongs to — the key its rows were aggregated
   *  under. `undefined` until a rescan has carried the id. */
  workspaceOf(sessionId: string): string | undefined {
    return this.wsBySession.get(sessionId)
  }

  /** What the heartbeat has to poll and mirror: one entry per MACHINE, carrying the
   *  paths of every workspace pinned on it — the round mirrors a host once, so two
   *  workspaces on one machine must arrive as one entry or only the first is pulled. */
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

  /** The machine's own path for a pinned remote folder, symlinks resolved — what
   *  claude slugs its transcript by and records as cwd (contract §2). Everything that
   *  builds a slug or a launch directory out of an `ssh://…` key goes through this,
   *  never key.path; the typed path stands in until the first heartbeat answers. */
  realRemotePath(key: RemoteKey): string {
    return this.deps.remoteGit?.(key.host, key.path)?.real ?? key.path
  }

  /** a heartbeat round changed a machine's alive set or its connected flag */
  onRemoteChanged(): void {
    this.scheduleRescan()
  }

  /** The slug bucket a session's transcript sits in (§1✎ — root slug or the worktree's
   *  own). Undefined until a rescan has carried the id. */
  bucketDirOf(sessionId: string): string | undefined {
    return this.bucketDirById.get(sessionId)
  }

  /** Working-set membership (the lifecycle contract §2) — a layout `sessions` entry. */
  isMember(sessionId: string): boolean {
    return !!this.layout.sessions[sessionId] || !!this.deps.additionalMembers?.().has(sessionId)
  }

  /** The pinned workspaces, straight off the layout — true from construction, unlike
   *  `rows()`, which is empty until the first rescan lands. The freshness engine reads
   *  this: its startup and focus sweeps can both fire before that. */
  pinnedPaths(): { path: string; missing: boolean }[] {
    return this.layout.workspaces.map((ws) => ({
      path: ws.path,
      missing: this.scope(ws.path).missing
    }))
  }

  /** folders worth pinning — every root Claude Code has a transcript for that is
   *  not pinned yet, newest first, at most DISCOVER_MAX. Several slugs of one repo (a
   *  subdir cwd, a `cd` deeper) collapse to the one root the sidebar would show. A cwd
   *  inside `.claude/worktrees/` is a Koloft-made checkout of the repo above it and
   *  counts toward that repo — `claude -w` files its transcript under the LAUNCH dir's
   *  slug while recording the worktree as cwd, so even the main checkout's slug can
   *  answer with a worktree path, and the worktree itself is often deleted by then. */
  discover(): DiscoveredFolder[] {
    const pinned = new Set(this.layout.workspaces.map((w) => w.path))
    const byRoot = new Map<string, DiscoveredFolder>()
    // this walk's own stats: statByFile is a rescan's bookkeeping, and a rescan can be
    // in flight while the welcome asks
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

  /** C7's "Run in" list (§5): the workspace's linked worktrees. The main checkout is
   *  the dialog's own `main` row, and an entry git still lists after its directory was
   *  deleted is stale — neither is offered. */
  async worktrees(wsPath: string): Promise<WorktreeInfo[]> {
    const root = this.scope(wsPath).scanPath
    return (await this.worktreeEntries(wsPath))
      .filter((e) => e.dir !== root)
      .map((e) => ({ name: path.basename(e.dir), dir: e.dir, branch: e.branch }))
  }

  /** The checkouts git lists for a workspace: for a remote one, what the machine
   *  said in its last heartbeat (this Mac can run no git there); for a vanished local
   *  dir, nothing (A1: the single root bucket). */
  private async worktreeEntries(wsPath: string): Promise<WorktreeEntry[]> {
    const { key, missing } = this.scope(wsPath)
    if (key) return this.deps.remoteGit?.(key.host, key.path)?.worktrees ?? []
    return missing ? [] : gitWorktreeEntries(wsPath)
  }

  add(rawPath: string): WorkspaceAddResult {
    // a malformed `ssh://…` is no remote key and no local path either: it falls
    // through to the absolute-path check below and comes back not-found
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
      // append semantics: sidebar order = array order, new pins go last (§6)
      this.layout.workspaces = [...this.layout.workspaces, { path: decision.path }]
      this.deps.saveLayout(this.layout)
      this.scheduleRescan() // trigger (a): workspace add
    }
    return { code: decision.code, path: decision.path }
  }

  /** A remote key is pinned verbatim, with no existence check and no repo probe of
   *  any kind: the first connection happens when a session starts, in the tab's own
   *  terminal, where a password can be typed. */
  private addRemote(rawPath: string): WorkspaceAddResult {
    const existing = this.layout.workspaces.find((w) => w.path === rawPath)
    if (existing) return { code: 'exists', path: existing.path }
    this.layout.workspaces = [...this.layout.workspaces, { path: rawPath }]
    this.deps.saveLayout(this.layout)
    this.scheduleRescan()
    return { code: 'added', path: rawPath }
  }

  /** removing a workspace only unpins it. Its note stays on disk under
   *  notes/<key>/notes.md and comes back the moment the folder is pinned again —
   *  Koloft never deletes text the user typed. */
  remove(wsPath: string): WorkspaceRemoveResult {
    const running = this.runningTabsOf(wsPath).length + this.remoteOrphansOf(wsPath).length
    // scheduled jobs weigh as much as running sessions here. A closed session
    // still sits in Claude's storage and comes back with the folder; a deleted job is
    // gone for good — so the caller must see both numbers before anything is removed.
    const jobs = this.deps.jobCountFor?.(wsPath) ?? 0
    if (running > 0 || jobs > 0) return { running, jobs, removed: false }
    this.unpin(wsPath)
    return { running: 0, jobs: 0, removed: true }
  }

  removeConfirmed(wsPath: string): void {
    // closed sessions merely turn cold in Claude's storage — re-adding the
    // workspace shows them again, resumable (A1)
    const tabs = this.runningTabsOf(wsPath)
    // a remote session with no tab here is just as running — unpinning would otherwise
    // leave a claude nobody can see or reach on the machine. Listed BEFORE the tab
    // kills: killTab drops a tab's binding at once, and its session would then read as
    // an orphan and be killed a second time
    const { key } = this.scope(wsPath)
    const orphans = key ? this.remoteOrphansOf(wsPath) : []
    for (const tabId of tabs) this.deps.killTab(tabId)
    if (key) for (const id of orphans) this.deps.killRemoteSession?.(key.host, id)
    this.unpin(wsPath)
  }

  /** A new claude session was spawned (⌘N → C7): hold a pending row for its pty
   *  until Claude's own storage carries the session (§4). Resumes are NOT launches —
   *  their row already exists, cold, and simply turns running. */
  launchStarted(tabId: string, cwd: string, worktree?: string, host?: string): void {
    this.launches.set(tabId, { tabId, cwd, worktree, host })
    this.scheduleRescan()
  }

  /** The launching pty is gone (Cancel, or claude died before ever binding) — §4:
   *  the pending row disappears with it. */
  launchEnded(tabId: string): void {
    if (this.launches.delete(tabId)) this.scheduleRescan()
  }

  /** trigger (b): a SessionStart hook reported a cwd outside every known bucket
   *  (covers both `claude -w <new>` and an externally created worktree). The cwd is
   *  also where the launching pty's claude actually landed, so it lands on the launch:
   *  a `-w` session is spawned in the repo root and would otherwise read `main` until
   *  its first jsonl line — which real Claude only writes at the first user message. */
  onSessionStart(tabId: string, cwd: string): void {
    const launch = this.launches.get(tabId)
    if (launch && launch.reportedCwd !== cwd) {
      launch.reportedCwd = cwd
      this.scheduleRescan()
    }
    if (planRescan({ kind: 'session-start', cwd }, this.state) === 'rescan') this.scheduleRescan()
  }

  /** §7: the Workbench state the renderer should show for a session — its persisted
   *  entry, or the global default for one that has never been configured. */
  workbenchState(sessionId: string): SessionWorkbenchState {
    return resolveWorkbenchState(this.layout, sessionId)
  }

  /** The `open` a session with no entry of its own starts from (v2's `aux.defaultMode`,
   *  redefined). Exposed for the `workbench:setState` boundary, whose sanitizer needs a
   *  fallback for a corrupt `open` flag — the user's own default, never a hardcoded one. */
  defaultOpen(): boolean {
    return this.layout.workbench.defaultOpen
  }

  /** D8: the session's whole panel state — `open` plus the persisted tab set — rewritten
   *  on every structural change. One channel where v2 had two (setAuxMode + setBrowser),
   *  because `open` and the tabs are now one document. The payload is already validated
   *  (sanitizeSessionWorkbench at the IPC boundary); this owns the debounced write.
   *
   *  A write UPDATES an entry and never creates one (the lifecycle contract D13/FR-29). Membership
   *  is what the sidebar lists off, and `withWorkbenchState` would happily mint the key
   *  for any id — so a late write for a session that has just left the working set (a
   *  `/exit`, a "Remove from list", or a `/clear` that moved the entry to a new id, with
   *  the guest's own `onTitle`/`onNavigate` still in flight against the old one) would
   *  resurrect the row it was removed from, and the next rescan would re-own it. Every
   *  legitimate write has an entry by the time it arrives: `onSessionBound` seeds one in
   *  the same block as the bind, before the renderer can even learn the id, and a
   *  resumed session's pre-bind write (FR-57) targets the entry the last run persisted. */
  setWorkbenchState(sessionId: string, state: SessionWorkbenchState): void {
    if (!this.layout.sessions[sessionId]) return
    this.layout = { ...this.layout, sessions: withWorkbenchState(this.layout, sessionId, state) }
    this.saveSoon()
  }

  /** Archive (Close session retired): drop the session's ownership
   *  entry so it leaves the sidebar. The jsonl is never touched — a future import (or
   *  any bind) re-registers it. A LIVE session cannot be archived: its pty is running
   *  and the row is the only handle on it. */
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

  /** Working-set eviction (the lifecycle contract D1/D2): the session left the list because it
   *  ended on a whitelist reason, or `/clear` moved its tab to a new id. Unconditional
   *  where archiveSession is guarded — the caller runs right after untrackSession, and
   *  a tracker entry that is still settling must not swallow the eviction. Idempotent:
   *  the hook's $tab.json is overwritten + retried, so the same end can arrive twice.
   *  D13: the panel's tab set goes with it (one table, accepted — FR-29). */
  dropOwnership(sessionId: string): void {
    if (!this.layout.sessions[sessionId]) return
    const sessions = { ...this.layout.sessions }
    delete sessions[sessionId]
    this.layout = { ...this.layout, sessions }
    this.deps.saveLayout(this.layout)
    this.scheduleRescan()
  }

  /** A SessionStart hook bound this session to a Koloft tab — that act is what makes it
   *  Koloft's own (the sidebar lists only sessions Koloft drove). Seed its
   *  ownership entry with the shipped default panel state — the global `defaultOpen` and
   *  no tabs, since `files` is implied rather than stored (FR-02). An entry that already
   *  exists (re-bind, resume, /clear carry) is left alone. GC'd with the jsonl. */
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

  /** A bound tab's SessionStart reported a different id than it was driving. Only the
   *  layout's per-session panel keys are affected (rows come from Claude's storage, so
   *  no rescan) — see carrySessionWorkbench for which id change carries them. */
  onSessionRebind(prevId: string, nextId: string, source: string): void {
    const next = carrySessionWorkbench(this.layout.sessions, prevId, nextId, source)
    if (!next.changed) return
    this.layout = { ...this.layout, sessions: next.sessions }
    this.deps.saveLayout(this.layout)
  }

  /** running set changed (bind/exit/untrack) → row running flags need a refresh */
  onTrackerUpdate(): void {
    const key = [...this.deps.runningBindings().keys()].join(',')
    if (key !== this.lastRunningKey) {
      this.lastRunningKey = key
      this.lastLiveKey = this.liveKey()
      this.scheduleRescan()
      return
    }
    // a live session moved into another checkout (EnterWorktree). The rows carry
    // the live answer, stamped on the way out, so they have to be pushed again; nothing
    // else about the sessions changed, so a rescan would be wasted work.
    const liveKey = this.liveKey()
    if (liveKey === this.lastLiveKey) return
    this.lastLiveKey = liveKey
    this.restampLive()
  }

  /** Everything the rows take from the live tracker, as one string — the restamp trigger.
   *  Keyed on the DIRECTORY rather than the worktree name: a session can move between two
   *  folders that resolve to the same name or to no name at all (a remote session has
   *  none), and its menu folder still has to be pushed. */
  private liveKey(): string {
    const parts: string[] = []
    for (const [id, s] of this.deps.liveSessions?.() ?? []) parts.push(id + '\0' + s.treeRoot)
    return parts.join(',')
  }

  /** R11/R13/R14 — where this row's menu points, decided here so that greying it out
   *  and opening it can never disagree: the answer is ABSENT when there is nothing there
   *  to open, which is the only thing the menu greys on. A running session answers with
   *  where it is now; a cold one with the folder its bucket belongs to — the same place,
   *  frozen at the session's last word. rowCwd is deliberately not a fallback: it is the
   *  directory the session STARTED in, which is exactly what used to be wrong here.
   *
   *  The folder of a LIVE session is checked too: `git worktree remove` under a running
   *  session leaves it pointed at a folder that is gone until its next logged directory
   *  re-homes it. `dirOk` holds one answer per folder for the duration of a push — many
   *  rows share a bucket, and this is the only syscall on the restamp path. */
  private revealDirOf(
    id: string,
    live: LiveSession | undefined,
    remote: boolean,
    dirOk: Map<string, boolean>
  ): string | undefined {
    const dir = live?.treeRoot ?? this.bucketDirOf(id)
    if (!dir) return undefined
    // a remote folder lives on the machine, so this Mac may not judge whether it is there
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

  /** live ptys the workspace owns — bound running sessions plus launches still
   *  pending (their pty is just as real, and unpinning must not orphan it) */
  private runningTabsOf(wsPath: string): string[] {
    const bindings = this.deps.runningBindings()
    const entry = this.rowsCache.find((e) => e.workspace.path === wsPath)
    if (!entry) return []
    return entry.rows
      .filter((r) => r.running || r.pending)
      .map((r) => (r.pending ? r.id : bindings.get(r.id)))
      .filter((t): t is string => !!t)
  }

  /** session ids this workspace's machine reports as running with NO tab in this
   *  Koloft — a session started here before a restart, or from another Koloft. */
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
      // a rescan is in flight — run once more after it, with the newest state
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
    // the projects root may not have existed at startup (fresh machine) — the
    // watcher retries here until it lands
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

    // a launch learns its session id from the hook-driven binding; it stays pending
    // until that id also has a jsonl-backed row (resolvePending)
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
      // the launches of a remote workspace may only resolve into ITS buckets: the same
      // absolute path can be pinned on two machines and on this Mac
      if (key) for (const b of buckets) b.host = key.host
      // a launch started before the machine's first heartbeat answer could only
      // name the TYPED path, and the buckets moved to the resolved one underneath it —
      // its pending row would never appear. The workspace decides the directory.
      if (key && scanPath !== key.path) {
        for (const l of launches) if (l.host === key.host && l.cwd === key.path) l.cwd = scanPath
      }
      const dirBySlug = new Map(buckets.map((b) => [b.slug, b.dir]))
      // a remote session's liveness comes from the machine's tmux, reported by the
      // heartbeat — this Mac's process table knows nothing about it
      const wsRunningIds = key
        ? new Set([...runningIds, ...(this.deps.remoteRunning?.(key.host) ?? [])])
        : runningIds
      const allRows = aggregateSessions(buckets, {
        listJsonl: (slug) => {
          const files = this.listJsonl(root, slug)
          const dir = dirBySlug.get(slug)
          // the aggregation's own enumeration is where a transcript's bucket is known.
          // Newest write wins, the same rule aggregateSessions draws its one row by, so
          // resume never aims at a stale copy the row already discarded.
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
        // the recorded cwd is a path on the machine: this Mac cannot tell whether it
        // exists, and answering "no" would grey out every remote row's resume
        dirExists: key ? () => true : dirExistsSync,
        now: Date.now
      })
      if (!key) {
        const additional = this.deps.additionalRows?.(ws.path) ?? []
        // Other backends supply their current checkout directly, without a Claude bucket.
        for (const r of additional) bucketDirById.set(r.id, r.cwd)
        // aggregateSessions already ordered the Claude rows newest-first; slot the other
        // backend's rows into that order rather than re-sorting the whole list. A row
        // that is still starting goes on top, like Claude's pending rows (§4, C2).
        for (const r of additional) {
          if (r.pending) continue
          const at = allRows.findIndex((x) => (x.createdAt ?? 0) < (r.createdAt ?? 0))
          allRows.splice(at < 0 ? allRows.length : at, 0, r)
        }
        allRows.unshift(...additional.filter((r) => r.pending))
      }
      allRowsByWs.set(ws.path, allRows) // D5: the rows filterOwned drops ARE the history offer
      for (const r of allRows) wsBySession.set(r.id, ws.path)
      // default policy: only sessions Koloft drove reach the sidebar —
      // ownership = a layout sessions[id] entry, seeded at hook bind (onSessionBound)
      // or by the v1→v2 migration from the old tab ledger (those two
      // are the ONLY sources — a rescan itself never adopts)
      const owned = new Set([
        ...Object.keys(this.layout.sessions),
        ...(this.deps.additionalMembers?.() ?? [])
      ])
      const rows = filterOwned(allRows, owned, wsRunningIds)
      for (const b of buckets) {
        bucketDirs.push(b.dir)
        wantedBucketDirs.add(path.join(root, b.slug))
      }
      // pending rows sit above every real row: the session the user just started is
      // the one they are looking at (§4, C2)
      const pending = resolvePending(buckets, launches, rows, Date.now())
      for (const tabId of pending.promoted) this.launches.delete(tabId)
      payload.push({
        workspace: {
          path: ws.path,
          missing,
          isGit: key
            ? (this.deps.remoteGit?.(key.host, key.path)?.isGit ?? false)
            : !missing && isGitCheckout(ws.path),
          // D9: the same set historyRows() answers with, as a yes/no for the menu
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
        rows: [...pending.rows, ...rows]
      })
    }

    this.state = { bucketDirs, workspaceSlugs }
    this.reconcileBucketWatchers(wantedBucketDirs)
    // a transcript that left every pinned bucket (deleted, workspace unpinned) takes
    // its remembered head with it
    for (const file of this.headScans.keys()) {
      if (!this.headScansSeen.has(file)) this.headScans.delete(file)
    }
    // the stats were this rescan's — a scanHead outside one must take its own
    this.statByFile.clear()

    // §6 GC: a `sessions` key lives exactly as long as its jsonl — checked across
    // ALL of Claude's storage, not just pinned buckets, so removing a workspace
    // never wipes panel state its sessions could reclaim on re-add. A LIVE binding
    // counts as alive too: real Claude writes no jsonl until the first user message,
    // so the entry onSessionBound just seeded has no file for this sweep to find —
    // collecting it here (bind 10:37:05, first write 10:38:22 observed) is what made
    // fresh sessions vanish from the working set on the next restart, since a rescan
    // never re-adopts. Once the binding drops with still no jsonl, GC may take it.
    // Every root counts, not just Claude's own storage: a remote session's only
    // transcript is in a mirror, so a GC that looked at ~/.claude/projects alone
    // would drop it from the working set on the very first rescan.
    const liveIds = new Set<string>(runningIds)
    for (const root of this.roots()) {
      for (const slug of slugsOf(root))
        for (const id of this.listJsonlIds(root, slug)) liveIds.add(id)
    }
    for (const t of this.remoteTargets()) {
      for (const id of this.deps.remoteRunning?.(t.host) ?? []) liveIds.add(id)
    }
    const gc = gcSessions(this.layout.sessions, liveIds)
    if (gc.changed) {
      this.layout = { ...this.layout, sessions: gc.sessions }
      this.deps.saveLayout(this.layout)
    }

    // before the stamping below, which reads it for each row's menu folder
    this.bucketDirById = bucketDirById
    this.rowsCache = this.stampLive(payload)
    this.allRowsCache = allRowsByWs // rebuilt wholesale: an unpinned workspace drops out
    this.wsBySession = wsBySession
    this.deps.pushRows(this.rowsCache)
    this.firstScanDone()
    this.deps.onRescanned?.(this.layout.workspaces.map((w) => w.path))
  }

  /**
   * The single point what is TRUE RIGHT NOW reaches the rows cache — read at the moment of
   * the write, never earlier. A rescan awaits git per workspace, so values read during
   * that loop are already stale by the time it pushes: an engine apply landing in the
   * window would be overwritten here and never corrected (its own restamp already ran, and
   * the engine's cache matches, so nothing pushes again).
   *
   * Two things are stamped: the workspace's git distance (the freshness engine's), and —
   * R7 — each running session's own worktree and folder. A row's worktree is derived
   * from the bucket its transcript sits in, which is right until claude moves a session
   * mid-conversation; from then on only the live tracker knows. Done here rather than in
   * the renderer because five other features read that field (the Pull guard's "second
   * claude on main" count among them) and they must all get the same answer.
   */
  private stampLive(rows: WorkspaceRows[]): WorkspaceRows[] {
    const liveById = this.deps.liveSessions?.() ?? new Map<string, LiveSession>()
    const dirOk = new Map<string, boolean>()
    return rows.map((e) => ({
      ...e,
      workspace: { ...e.workspace, freshness: this.deps.freshness?.(e.workspace.path) },
      // A row whose session is no longer live keeps what was last stamped on it until the
      // rescan rebuilds it from disk — which the same tracker update that dropped the
      // session has already scheduled (onTrackerUpdate), so it is a push or two, not a
      // state to unwind here.
      rows: e.rows.map((r) => {
        const live = liveById.get(r.id)
        // Only a session claude really moved: before that `treeRoot` is no more than the
        // directory the tab was launched in, and a resumed worktree session is not there
        // (SessionInfo.relocated).
        // A remote session's worktree is the machine's to know: the tracker resolves one
        // by walking THIS disk, which would answer about whatever happens to sit at that
        // path here, so the mirrored bucket stays the answer. Its DIRECTORY still
        // follows the move — that one came from the machine's own hook.
        const wt = live?.relocated && !live.remote ? (live.worktree ?? 'main') : undefined
        const revealDir = this.revealDirOf(r.id, live, !!e.workspace.remote, dirOk)
        const moved = wt && wt !== r.worktree
        if (!moved && revealDir === r.revealDir) return r
        return { ...r, ...(moved ? { worktree: wt } : {}), revealDir }
      })
    }))
  }

  /** Something the stamping reads changed — the freshness engine measured, or a session
   *  moved worktree: re-stamp the cached rows and push them. No rescan, since nothing about
   *  which sessions exist changed, and `.git` is invisible to the watchers anyway, so this
   *  push is the only way the badge ever moves (§05). */
  restampLive(): void {
    this.rowsCache = this.stampLive(this.rowsCache)
    this.deps.pushRows(this.rowsCache)
  }

  /** every root the pinned workspaces read from: Claude's storage plus one mirror
   *  per machine. A root that does not exist yet is retried on the next rescan. */
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
        // trigger (c): a new slug dir whose prefix matches a pinned workspace. The
        // hit is only a signal — the rescan itself decides inclusion (§6).
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
    } catch {
      /* root missing (fresh machine, mirror not pulled yet) — retried next rescan */
    }
  }

  /** Directory-level watches on known bucket slug dirs: jsonl create/delete drives
   *  row updates and the sessions GC. Keyed by the ABSOLUTE dir: two roots (this Mac
   *  and a machine's mirror) can hold the same slug name. A dir that doesn't exist yet
   *  is skipped —
   *  the root watcher fires when it appears (trigger c) and the next rescan lands here. */
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
      } catch {
        /* dir vanished between rescan and watch — the next rescan reconciles */
      }
    }
  }

  /** Everything a reader derives from one workspace path, in the single place the
   *  `ssh://…` key is parsed: where its transcripts are read from (Claude's own
   *  storage, or the machine's mirror under userData), which directory the slug is
   *  computed from, and whether it is a local folder that has gone away. */
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
      // for a remote workspace the directory ON the machine, never the `ssh://…` key
      // (path.resolve would glue it under cwd)
      scanPath: key ? this.realRemotePath(key) : wsPath,
      // a remote key names no local directory: stat'ing it would mark every remote
      // workspace missing, and there is deliberately no probe over ssh here
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
      } catch {
        /* raced a deletion — skip */
      }
    }
    return out
  }

  /** ids only, no stat: the GC sweep walks EVERY slug in Claude's storage, and
   *  only needs to know which transcripts exist */
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

  /** The head fields of one transcript, read again only when it could answer
   *  differently: a settled head (`final`) never is, an unsettled one only after
   *  its size or mtime moved. Reads via the stat listJsonl took this rescan. */
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
      // a shrink means a rewrite — not Claude's doing, but never trust the old head then
      const same = prev.final
        ? st.size >= prev.size
        : st.size === prev.size && st.mtimeMs === prev.mtimeMs
      if (same) return prev.meta
    }
    const probe = { opened: false, eof: false }
    const meta = extractJsonlMeta(jsonlHeadLines(file, probe))
    // an unopened file has no answer to remember — the next rescan tries it again
    if (st && probe.opened) this.headScans.set(file, { ...st, meta, final: !probe.eof })
    return meta
  }

  /** V1 long-path fallback: confirm a truncated-slug candidate by the cwd its own
   *  jsonl records. Any file in the dir will do — one slug is one cwd. */
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
    // a copy: the sidecar below must not write into the remembered head
    const partial: Partial<SessionMeta> = { ...this.scanHead(file) }
    // `<id>.title` sidecar (an external AI-title generator's output): the tracker
    // titles live rows sidecar-first, so the cold row reads it too — same slot as
    // the in-log ai-title, just fresher.
    try {
      const sidecar = fs.readFileSync(file.replace(/\.jsonl$/, '.title'), 'utf8').trim()
      if (sidecar) partial.aiTitle = sidecar
    } catch {
      /* no sidecar — the in-log ai-title (if any) stands */
    }
    let timestamp = partial.timestamp
    if (!timestamp) {
      try {
        timestamp = new Date(fs.statSync(file).mtimeMs).toISOString()
      } catch {
        timestamp = new Date(0).toISOString()
      }
    }
    // a headless/empty jsonl still renders a row: bucket dir stands in for cwd
    return { ...partial, cwd: partial.cwd ?? bucketDir, timestamp }
  }
}
