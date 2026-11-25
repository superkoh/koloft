import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import type {
  BackendId,
  DiscoveredFolder,
  FolderClaim,
  FolderUse,
  LayoutV6,
  ProjectInfo,
  SessionRow,
  SessionWorkbenchState,
  WorkspaceAddResult,
  WorkspaceFreshness,
  WorkspaceGitAccount,
  WorkspaceRemoveResult,
  WorkspaceRows,
  WorktreeInfo
} from '@shared/types'
import {
  carrySessionWorkbench,
  decideWorkspaceAdd,
  gcSessions,
  parseWorktreeEntries,
  resolveWorkbenchState,
  withWorkbenchState,
  type WorktreeEntry
} from '../../../main/workspaceOps'
import { dirExists } from '../../../main/fileTree'
import { dirExistsSync } from '../../../main/resumePlan'
import { isGitCheckoutAsync } from '../../../main/projectInfo'
import { replacesTheConversation } from '../../../main/hookRouting'
import { isRemoteKey, parseRemoteKey, type RemoteKey } from '@shared/remoteKey'
import {
  isWorkspaceWorkbenchKey,
  workspaceOfWorkbenchKey,
  WORKSPACE_WORKBENCH_STARTS_OPEN_WHATEVER_THE_SESSION_DEFAULT
} from '@shared/workbenchState'
import type { RemoteGitInfo } from '../../../main/remote/install'
import { isUnderAnyRoot } from '@core/isUnderAnyRoot'
import { mergeUse } from '@shared/firstRun'
import type { KeptInLayout, RowsNow, RowsOfEveryAgent } from '@core/agent/sessionRows'

const RESCAN_DEBOUNCE_MS = 250
const PANEL_SAVE_DEBOUNCE_MS = 600
// CC§2
const A_RESCAN_FOR_APPENDS_ALONE_LOOKS_EVERYWHERE_AFTER_MS = 30_000
const DISCOVER_MAX = 8

function addUse(into: Map<string, DiscoveredFolder>, at: string, use: DiscoveredFolder): void {
  const prev = into.get(at)
  const agents = { ...prev?.agents }
  for (const [agent, u] of Object.entries(use.agents) as [BackendId, FolderUse][])
    agents[agent] = mergeUse(agents[agent], u)
  into.set(at, { path: at, ...mergeUse(prev, use), agents })
}

const MAC_SCRATCH_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']

export function scratchRootsAround(home: string, tmpdir: string): string[] {
  return [tmpdir, ...MAC_SCRATCH_ROOTS].filter((r) => !isUnderAnyRoot(home, [r]))
}

export interface WorkspaceManagerDeps {
  agents: RowsOfEveryAgent
  loadLayout(): LayoutV6
  saveLayout(layout: LayoutV6): void
  projectInfo(p: string): ProjectInfo
  runningBindings(): Map<string, string>
  killTab(tabId: string): void
  pushRows(payload: WorkspaceRows[]): void
  freshness?(wsPath: string): WorkspaceFreshness | undefined
  pluginData?(wsPath: string): Readonly<Record<string, unknown>> | undefined
  gitAccount?(wsPath: string): WorkspaceGitAccount | undefined
  gitPickable?(wsPath: string): boolean
  onRescanned?(wsPaths: string[]): void
  jobCountFor?(wsPath: string): number
  remoteRunning?(host: string): Set<string>
  remoteConnected?(host: string): boolean
  remoteProblem?(host: string): string | undefined
  remoteGit?(host: string, path: string): RemoteGitInfo | undefined
  remoteOrphansOf?(wsPath: string): string[]
  killRemoteSession?(host: string, sessionId: string): void
  hiddenRow?(id: string): boolean
  parentOf?(rowId: string): string | undefined
  conductorsRoot?: string
  scratchRoots?: readonly string[]
  claimedFolder?: FolderClaim
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

const NO_LINKED_WORKTREES_STAMP = 0

// PLATFORM§30
async function linkedWorktreesStamp(root: string): Promise<number | null> {
  try {
    return (await fs.promises.stat(path.join(root, '.git', 'worktrees'))).mtimeMs
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? NO_LINKED_WORKTREES_STAMP : null
  }
}

export class WorkspaceManager {
  private layout: LayoutV6
  private rowsCache: WorkspaceRows[] = []
  private firstScanDone!: () => void
  readonly firstScan: Promise<void> = new Promise((res) => {
    this.firstScanDone = res
  })
  private wsBySession = new Map<string, string>()
  private closingForGood = new Map<string, number>()
  private timer?: NodeJS.Timeout
  private panelTimer?: NodeJS.Timeout
  private scanning = false
  private rescanQueued = false
  private scanWaiters: (() => void)[] = []
  private lastRunningKey = ''
  private lastLiveKey = ''
  private disposed = false
  private fullScanAsked = true
  private lookedEverywhereAt = 0
  private worktreeDirsByStamp = new Map<string, { stamp: number; dirs: string[] }>()
  private growthAsked = false
  private membersPruned = false

  readonly keptInLayout: KeptInLayout = {
    list: () => this.layout.members,
    add: (sessionIds) => {
      const fresh = [...new Set(sessionIds)].filter((id) => id && !this.layout.members.includes(id))
      if (fresh.length === 0) return
      const panels = Object.fromEntries(
        fresh.map((id) => [id, { open: this.layout.workbench.defaultOpen, tabs: [] }])
      )
      this.layout = {
        ...this.layout,
        members: [...this.layout.members, ...fresh],
        panels: { ...panels, ...this.layout.panels }
      }
      this.deps.saveLayout(this.layout)
      this.scheduleRescan()
    },
    remove: (sessionId) => {
      const panels = { ...this.layout.panels }
      delete panels[sessionId]
      this.layout = {
        ...this.layout,
        members: this.layout.members.filter((id) => id !== sessionId),
        panels
      }
      this.deps.saveLayout(this.layout)
      this.scheduleRescan()
    },
    keepOnly: (members) => {
      if (members.length === this.layout.members.length) return
      this.membersPruned = true
      this.layout = { ...this.layout, members }
    }
  }

  constructor(private deps: WorkspaceManagerDeps) {
    this.layout = deps.loadLayout()
  }

  start(): void {
    this.scheduleRescan()
  }

  rows(): WorkspaceRows[] {
    return this.rowsCache
  }

  workspaceOf(sessionId: string): string | undefined {
    return this.wsBySession.get(sessionId)
  }

  refresh(): void {
    this.scheduleRescan()
  }

  private withParents(rows: SessionRow[]): SessionRow[] {
    const parentOf = this.deps.parentOf
    if (!parentOf) return rows
    return rows.map((r) => {
      const parentId = parentOf(r.id)
      return parentId ? { ...r, parentId } : r
    })
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

  isMember(sessionId: string): boolean {
    return this.deps.agents.isMember(sessionId)
  }

  isPinned(wsPath: string): boolean {
    return this.layout.workspaces.some((ws) => ws.path === wsPath)
  }

  pinnedPaths(): { path: string; missing: boolean }[] {
    return this.layout.workspaces.map((ws) => ({
      path: ws.path,
      missing: !isRemoteKey(ws.path) && !dirExistsSync(ws.path)
    }))
  }

  pinnedPathList(): string[] {
    return this.layout.workspaces.map((ws) => ws.path)
  }

  // PLATFORM§69
  pinnedPathsCheckedOffTheMainThread(): Promise<{ path: string; missing: boolean }[]> {
    return Promise.all(
      this.layout.workspaces.map(async (ws) => ({
        path: ws.path,
        missing: await this.missing(ws.path)
      }))
    )
  }

  async discover(): Promise<DiscoveredFolder[]> {
    const pinned = new Set(this.layout.workspaces.map((w) => w.path))
    const wtMark = `${path.sep}.claude${path.sep}worktrees${path.sep}`
    const used = await this.deps.agents.usedFolders()
    const byCwd = new Map<string, DiscoveredFolder>()
    for (const use of used) {
      const wt = use.path.indexOf(wtMark)
      addUse(byCwd, wt === -1 ? use.path : use.path.slice(0, wt), use)
    }
    const there = await Promise.all([...byCwd.keys()].map((cwd) => dirExists(cwd)))
    const byRoot = new Map<string, DiscoveredFolder>()
    for (const [i, use] of [...byCwd.values()].entries()) {
      if (!there[i]) continue
      const root = this.deps.projectInfo(use.path).root
      if (pinned.has(root) || this.isConductorFolder(root)) continue
      if (isUnderAnyRoot(root, this.deps.scratchRoots ?? [])) continue
      addUse(byRoot, root, use)
    }
    return [...byRoot.values()].sort((a, b) => b.mtime - a.mtime).slice(0, DISCOVER_MAX)
  }

  private isConductorFolder(dir: string): boolean {
    const root = this.deps.conductorsRoot
    return !!root && isUnderAnyRoot(dir, [root])
  }

  async worktrees(wsPath: string): Promise<WorktreeInfo[]> {
    const root = this.scope(wsPath).scanPath
    return (await this.worktreeEntries(wsPath))
      .filter((e) => e.dir !== root)
      .map((e) => ({ name: path.basename(e.dir), dir: e.dir, branch: e.branch }))
  }

  private async worktreeEntries(wsPath: string): Promise<WorktreeEntry[]> {
    const { key } = this.scope(wsPath)
    if (key) return this.deps.remoteGit?.(key.host, key.path)?.worktrees ?? []
    return (await this.missing(wsPath)) ? [] : gitWorktreeEntries(wsPath)
  }

  private async worktreeDirs(wsPath: string, isGit: boolean): Promise<string[]> {
    const list = async (): Promise<string[]> =>
      (await this.worktreeEntries(wsPath)).map((e) => e.dir)
    if (this.scope(wsPath).key) return list()
    if (!isGit) return []
    const stamp = await linkedWorktreesStamp(wsPath)
    const known = this.worktreeDirsByStamp.get(wsPath)
    if (stamp !== null && known?.stamp === stamp) return known.dirs
    const dirs = await list()
    if (stamp !== null) this.worktreeDirsByStamp.set(wsPath, { stamp, dirs })
    return dirs
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

  move(wsPath: string, before: string | null): void {
    const moving = this.layout.workspaces.find((w) => w.path === wsPath)
    if (!moving) return
    const rest = this.layout.workspaces.filter((w) => w !== moving)
    const at = before === null ? rest.length : rest.findIndex((w) => w.path === before)
    if (at === -1) return
    this.layout.workspaces = [...rest.slice(0, at), moving, ...rest.slice(at)]
    this.deps.saveLayout(this.layout)
    this.rowsCache = this.inLayoutOrder(this.rowsCache)
    this.deps.pushRows(this.rowsCache)
  }

  private inLayoutOrder(rows: WorkspaceRows[]): WorkspaceRows[] {
    const order = this.layout.workspaces.map((w) => w.path)
    return [...rows].sort(
      (a, b) => order.indexOf(a.workspace.path) - order.indexOf(b.workspace.path)
    )
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

  hideWhileClosing(sessionId: string): void {
    this.closingForGood.set(sessionId, (this.closingForGood.get(sessionId) ?? 0) + 1)
    this.rowsCache = this.withoutClosing(this.rowsCache)
    this.deps.pushRows(this.rowsCache)
  }

  closingEnded(sessionId: string): void {
    const left = (this.closingForGood.get(sessionId) ?? 0) - 1
    if (left > 0) return void this.closingForGood.set(sessionId, left)
    if (this.closingForGood.delete(sessionId)) this.scheduleRescan()
  }

  private withoutClosing(rows: WorkspaceRows[]): WorkspaceRows[] {
    if (!this.closingForGood.size) return rows
    return rows.map((e) => ({ ...e, rows: e.rows.filter((r) => !this.closingForGood.has(r.id)) }))
  }

  workbenchState(sessionId: string): SessionWorkbenchState {
    if (isWorkspaceWorkbenchKey(sessionId)) {
      return (
        this.layout.workspacePanels?.[workspaceOfWorkbenchKey(sessionId)] ?? {
          open: WORKSPACE_WORKBENCH_STARTS_OPEN_WHATEVER_THE_SESSION_DEFAULT,
          tabs: []
        }
      )
    }
    return resolveWorkbenchState(this.layout, sessionId)
  }

  defaultOpen(): boolean {
    return this.layout.workbench.defaultOpen
  }

  setWorkbenchState(sessionId: string, state: SessionWorkbenchState): void {
    if (isWorkspaceWorkbenchKey(sessionId)) {
      const wsPath = workspaceOfWorkbenchKey(sessionId)
      if (!this.layout.workspaces.some((w) => w.path === wsPath)) return
      this.layout = {
        ...this.layout,
        workspacePanels: { ...this.layout.workspacePanels, [wsPath]: state }
      }
      this.saveSoon()
      return
    }
    if (!this.isMember(sessionId)) return
    this.layout = { ...this.layout, panels: withWorkbenchState(this.layout, sessionId, state) }
    this.saveSoon()
  }

  onSessionRebind(prevId: string, nextId: string, source: string): void {
    if (replacesTheConversation(source)) this.moveResident(prevId, nextId)
    const next = carrySessionWorkbench(this.layout.panels, prevId, nextId, source)
    if (!next.changed) return
    this.layout = { ...this.layout, panels: next.sessions }
    this.deps.saveLayout(this.layout)
  }

  residentIds(): string[] {
    return [...(this.layout.resident ?? [])]
  }

  isResident(sessionId: string): boolean {
    return !!this.layout.resident?.includes(sessionId)
  }

  setResident(sessionId: string, on: boolean): void {
    if (this.isResident(sessionId) === on) return
    const rest = this.residentIds().filter((id) => id !== sessionId)
    this.saveResident(on ? [...rest, sessionId] : rest)
  }

  moveResident(prevId: string, nextId: string): void {
    if (!this.isResident(prevId)) return
    this.saveResident([
      ...this.residentIds().filter((id) => id !== prevId && id !== nextId),
      nextId
    ])
  }

  private saveResident(resident: string[]): void {
    this.layout = { ...this.layout, resident }
    this.deps.saveLayout(this.layout)
    this.restampLive()
  }

  sessionsChanged(): void {
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
    return this.deps.agents.liveKey()
  }

  private revealDirOf(
    dir: string | undefined,
    remote: boolean,
    dirOk: Map<string, boolean>
  ): string | undefined {
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
    for (const done of this.scanWaiters.splice(0)) done()
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
    if (this.layout.workspacePanels?.[wsPath]) {
      const workspacePanels = { ...this.layout.workspacePanels }
      delete workspacePanels[wsPath]
      this.layout.workspacePanels = workspacePanels
    }
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
    return this.deps.remoteOrphansOf?.(wsPath) ?? []
  }

  whenScanned(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return new Promise((resolve) => {
      this.scanWaiters.push(resolve)
      this.scheduleRescan()
    })
  }

  private scheduleRescan(): void {
    this.fullScanAsked = true
    this.armRescan()
  }

  private armRescan(): void {
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
    const waiting = this.scanWaiters.splice(0)
    try {
      await this.doRescan()
    } finally {
      this.scanning = false
      for (const done of waiting) done()
      if (this.rescanQueued) {
        this.rescanQueued = false
        this.armRescan()
      }
    }
  }

  rescanForGrowth(): void {
    this.growthAsked = true
    this.armRescan()
  }

  private async doRescan(): Promise<void> {
    await this.deps.agents.rowsReady()

    const everywhere =
      this.fullScanAsked ||
      !this.growthAsked ||
      Date.now() - this.lookedEverywhereAt >= A_RESCAN_FOR_APPENDS_ALONE_LOOKS_EVERYWHERE_AFTER_MS
    this.fullScanAsked = false
    this.growthAsked = false
    if (everywhere) this.lookedEverywhereAt = Date.now()
    const boundAtStart = this.deps.runningBindings()
    this.lastRunningKey = [...boundAtStart.keys()].join(',')
    const pass = this.deps.agents.rowsPass({ everywhere, bindings: boundAtStart })

    const payload: WorkspaceRows[] = []
    const wsBySession = new Map<string, string>()

    const claimed = this.deps.claimedFolder
    for (const ws of [...this.layout.workspaces, ...(claimed ? [{ path: claimed.path }] : [])]) {
      const { key, scanPath } = this.scope(ws.path)
      const missing = await this.missing(ws.path)
      let gitBeingRead: Promise<{ isGit: boolean; wtDirs: string[] }> | undefined
      const readGit = (): Promise<{ isGit: boolean; wtDirs: string[] }> =>
        (gitBeingRead ??= (async () => {
          const isGit = key
            ? (this.deps.remoteGit?.(key.host, key.path)?.isGit ?? false)
            : !missing && (await isGitCheckoutAsync(ws.path))
          const wtDirs = await this.worktreeDirs(ws.path, isGit)
          return { isGit, wtDirs }
        })())
      let now: RowsNow | undefined
      const answers = await pass.in(
        { path: ws.path, realPath: scanPath, worktreeDirs: async () => (await readGit()).wtDirs },
        () => (now ??= this.rowsNow(key))
      )
      const { isGit } = await readGit()
      for (const answer of answers) for (const id of answer.ids) wsBySession.set(id, ws.path)
      const [first, ...later] = answers.map((answer) => answer.kept)
      const rows: SessionRow[] = [...(first ?? [])]
      for (const r of later.flat()) {
        const at = rows.findIndex((x) => (x.createdAt ?? 0) < (r.createdAt ?? 0))
        rows.splice(at < 0 ? rows.length : at, 0, r)
      }
      payload.push({
        workspace: {
          path: ws.path,
          missing,
          isGit,
          hasHistory: answers.some((answer) => answer.hasMore),
          ...(ws.path === claimed?.path && {
            claim: { by: claimed.by, shownAs: claimed.shownAs }
          }),
          ...(key
            ? {
                remote: {
                  host: key.host,
                  path: key.path,
                  connected: this.deps.remoteConnected?.(key.host) ?? false,
                  problem: this.deps.remoteProblem?.(key.host)
                }
              }
            : {})
        },
        rows: this.withParents([...answers.flatMap((answer) => answer.starting), ...rows])
      })
    }

    await pass.done()
    if (everywhere) this.dropWhatNoAgentKeeps()

    const ordered = this.inLayoutOrder(payload)
    this.rowsCache = this.withoutClosing(
      this.stampLive(ordered, await this.revealDirsExisting(ordered))
    )
    this.wsBySession = wsBySession
    this.deps.pushRows(this.rowsCache)
    this.firstScanDone()
    pass.shown()
    this.deps.onRescanned?.(this.layout.workspaces.map((w) => w.path))
  }

  private rowsNow(key: RemoteKey | null): RowsNow {
    const bindings = this.deps.runningBindings()
    return {
      bindings,
      running: new Set([
        ...bindings.keys(),
        ...((key && this.deps.remoteRunning?.(key.host)) || [])
      ]),
      hidden: (id) => this.deps.hiddenRow?.(id) ?? false
    }
  }

  private dropWhatNoAgentKeeps(): void {
    const kept = this.deps.agents.members()
    const gc = gcSessions(this.layout.panels, kept)
    const resident = this.residentIds().filter((id) => kept.has(id))
    if (gc.changed || this.membersPruned || resident.length !== this.residentIds().length) {
      this.layout = { ...this.layout, panels: gc.sessions, resident }
      this.deps.saveLayout(this.layout)
    }
    this.membersPruned = false
  }

  private async revealDirsExisting(rows: WorkspaceRows[]): Promise<Map<string, boolean>> {
    const whereNow = this.deps.agents.whereNow()
    const dirs = new Set<string>()
    for (const e of rows) {
      if (e.workspace.remote) continue
      for (const r of e.rows) {
        const dir = whereNow(r).dir
        if (dir) dirs.add(dir)
      }
    }
    return new Map(await Promise.all([...dirs].map(async (d) => [d, await dirExists(d)] as const)))
  }

  private stampLive(rows: WorkspaceRows[], dirOk = new Map<string, boolean>()): WorkspaceRows[] {
    const whereNow = this.deps.agents.whereNow()
    return rows.map((e) => ({
      ...e,
      workspace: {
        ...e.workspace,
        freshness: this.deps.freshness?.(e.workspace.path),
        plugins: this.deps.pluginData?.(e.workspace.path),
        gitAccount: this.deps.gitAccount?.(e.workspace.path),
        ...(this.deps.gitPickable?.(e.workspace.path) && { gitPickable: true })
      },
      rows: e.rows.map((r) => {
        const where = whereNow(r)
        const wt = where.worktree
        const revealDir = this.revealDirOf(where.dir, !!e.workspace.remote, dirOk)
        const moved = wt && wt !== r.worktree
        const resident = this.isResident(r.id)
        if (!moved && revealDir === r.revealDir && resident === !!r.resident) return r
        return {
          ...r,
          ...(moved ? { worktree: wt } : {}),
          revealDir,
          resident: resident || undefined
        }
      })
    }))
  }

  restampLive(): void {
    this.rowsCache = this.stampLive(this.rowsCache)
    this.deps.pushRows(this.rowsCache)
  }

  private scope(wsPath: string): {
    key: RemoteKey | null
    scanPath: string
  } {
    const key = parseRemoteKey(wsPath)
    return {
      key,
      scanPath: key ? this.realRemotePath(key) : wsPath
    }
  }

  private async missing(wsPath: string): Promise<boolean> {
    return !isRemoteKey(wsPath) && !(await dirExists(wsPath))
  }
}
