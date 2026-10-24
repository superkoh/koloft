import path from 'path'
import type {
  BackendAvailability,
  BackendId,
  BackendSessionInfo,
  BackendSessionRow,
  CreateTabOptions,
  LaunchPermission,
  ProjectInfo,
  SessionResumeRequest
} from '@shared/types'
import { PLACEHOLDER_TITLES } from '@shared/types'
import { BACKEND_LABEL, identityOf, sourceOf } from '@shared/sessionBackend'
import { isAbsoluteOnHost, isRemoteKey } from '@shared/remoteKey'
import type { SessionEvent } from '@shared/sessionEvent'
import type { Turn } from '@shared/turns'
import type { SearchCandidate } from './sessionSearch'
import type { CodexApproval, CodexQuestion } from './discord/dialog'
import { SessionStore, hostOfPath, type KeyOf, type WorktreeResource } from './sessionStore'
import { SessionWorktrees, type TreeIo } from './sessionWorktrees'
import type { PtyManager } from './ptyManager'
import {
  dirExistsSync as dirExists,
  occupantName,
  rebuildsTheWorktree,
  ResumeRefused
} from './resumePlan'
import type { CliRuntime } from './cliRuntime'
import type { HoldScript } from './hooks'
import { isNewer } from './releaseNotes'
import { pathWithDirFirst, pathWithDirLast } from './toolInstall'
import { turnOf, type SessionRuntime, type StatusEdge } from './sessionRuntime'

const AVAILABILITY_FAILURE_MS = 60_000
const EMIT_THROTTLE_MS = 500
// MUSE§5
const NEW_SESSION_LIST_LAG_MS = 30_000

const binaryGone = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'

export const hostOfKey = (key: string): string | undefined => {
  const { sourceId } = identityOf(key)
  return sourceId === 'local' ? undefined : sourceId
}

export const REMOTE_EXIT_WAIT_MS = 10_000

// ADR-0025
const seenMissing = (cwd: string): boolean => !isRemoteKey(cwd) && !dirExists(cwd)

// ADR-0025
const samePlace = (a: string, b: string): boolean =>
  isRemoteKey(a) || isRemoteKey(b) ? a === b : path.resolve(a) === path.resolve(b)

export interface HistoryEntry {
  id: string
  cwd: string
  name?: string | null
  preview?: string
  createdAt?: number
  updatedAt?: number
  cliVersion?: string
}

export interface StoredRun {
  tabId: string
  cwd: string
  workspace: string
  info?: BackendSessionInfo
  resource?: WorktreeResource
  stopping?: Promise<void>
  explicitStop: boolean
  resumeKey?: string
  permission: LaunchPermission
  bypassing: boolean
  launchName?: string
  releaseTools(): void
}

export interface StoredSessionDeps {
  pty: PtyManager
  runtime: SessionRuntime
  projectInfo(p: string): ProjectInfo
  changed(): void
  replaced?(oldKey: string, newKey: string): void
  leftWorktree?(resource: WorktreeResource): Promise<void>
  events(tabId: string, event: SessionEvent): void
  error(message: string): void
  fallbackBin?: string
  gitBin?: string
  gitAccounts: { configEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv }
  remoteDirExists?(dir: string): Promise<boolean>
  remoteTreeIo?(cwd: string): TreeIo
  skipPermissions?(): boolean
  holdWhileBusy?(tabId: string): boolean
  holdScript?: HoldScript
  hookRegDir?: string
}

export interface StartContext {
  opts: CreateTabOptions
  cwd: string
  workspace: string
  resource?: WorktreeResource
  freshWorktree: boolean
}

export interface SessionsWithStore {
  readonly id: BackendId
  readonly store: SessionStore
  readonly worktrees: SessionWorktrees
  rows(workspace: string): BackendSessionRow[]
  members(): Set<string>
  runningBindings(): Map<string, string>
  threadGone(key: string): boolean
  hasProcesses(): boolean
  stopAll(deadlineMs?: number): Promise<void>
  hasTab(tabId: string): boolean
  sessionIdOf(tabId: string): string | undefined
  aliveTabFor(key: string): string | undefined
  stop(tabId: string, nativeExitCode?: number, restarting?: boolean): Promise<void>
  searchable(workspaces: string[]): SearchCandidate[]
  searchSnippets(term: string, signal?: AbortSignal): Promise<{ id: string; snippet: string }[]>
  openApproval(tabId: string): CodexApproval | undefined
  openQuestion(tabId: string): CodexQuestion | undefined
  answerable?(tabId: string): Promise<void>
  answer?(tabId: string, reply: string): Promise<string | undefined | false>
  deliver?(tabId: string, text: string): Promise<boolean>
  noticeRemoteExits?(host: string, sessionIds: string[]): void
  followMirrors?(host: string): void
  tabOnMachine?(host: string, tmuxName: string, launchTab: string): string | undefined
}

type Place = ProjectInfo & { missing: boolean }

interface RowScope {
  byPath: Map<string, WorktreeResource>
  remotePlaces: Map<string, Place>
}

export abstract class StoredSessions<R extends StoredRun, H extends HistoryEntry, P = undefined> {
  abstract readonly id: BackendId
  protected runs = new Map<string, R>()
  protected history = new Map<string, H>()
  protected archivedIds = new Set<string>()
  protected listedAt = new Map<string | undefined, number>()
  private places = new Map<string, Place>()
  private probed?: { at: number; reply: BackendAvailability }
  private probing?: Promise<BackendAvailability>
  protected binary?: string
  protected processEnv?: NodeJS.ProcessEnv
  private warnedVersion?: string
  private refreshing?: Promise<void>
  private historyError?: Error
  private launchingKeys = new Set<string>()
  private relaunchingKeys = new Set<string>()
  private pendingLaunches = new Set<Promise<{ id: string; cwd: string }>>()
  protected shuttingDown = false
  private emitTimer?: ReturnType<typeof setTimeout>
  private lastEmitMs = 0
  readonly store: SessionStore
  readonly worktrees: SessionWorktrees

  constructor(
    file: string,
    protected keyOf: KeyOf,
    protected deps: StoredSessionDeps
  ) {
    this.store = new SessionStore(file, keyOf)
    this.worktrees = new SessionWorktrees(this.store, deps.remoteTreeIo)
    deps.runtime.on('status', ({ tabId, next }: StatusEdge) => {
      const run = this.runs.get(tabId)
      if (!run?.info || run.explicitStop || run.stopping) return
      run.info.status = next
      run.info.updatedAt = Date.now()
      this.changedSoon()
    })
  }

  protected readonly keepsItsOwnTitle: boolean = false
  protected abstract readonly cli: {
    product: string
    minVersion: string
    howToUpdate: string
    find(): Promise<CliRuntime>
    update(runtime: CliRuntime): Promise<void>
  }
  private updateTried = false

  private async resolveRuntime(): Promise<CliRuntime> {
    const { product, minVersion, howToUpdate } = this.cli
    let runtime = await this.cli.find()
    if (!isNewer(minVersion, runtime.version)) return runtime
    const updating = !this.updateTried
    if (updating) {
      this.updateTried = true
      this.deps.error(
        `${product} ${runtime.version} is older than ${minVersion}, the oldest this Koloft supports. Updating it now…`
      )
      await this.cli.update(runtime)
      runtime = await this.cli.find()
      if (!isNewer(minVersion, runtime.version)) return runtime
    }
    const stillOld = `Koloft needs ${product} ${minVersion} or newer, and this Mac has ${runtime.version}. ${howToUpdate}, then try again.`
    if (updating) this.deps.error(stillOld)
    throw new Error(stillOld)
  }

  protected abstract listHistory(): Promise<{ key: string; entry: H; archived: boolean }[]>
  protected abstract startRun(ctx: StartContext, prepared: P): Promise<R>
  protected abstract untestedNotice(version: string): string

  protected prepare(_opts: CreateTabOptions): P {
    return undefined as P
  }

  protected async endRun(_run: R): Promise<void> {}

  protected exitedOnItsOwn(_run: R): boolean {
    return true
  }

  protected runDetails(_run: R): Pick<BackendSessionInfo, 'details' | 'pickedAccount'> {
    return {}
  }

  protected degradedDetails(): BackendSessionInfo['details'] {
    return undefined
  }

  protected archivedNotice(_key: string): string {
    return `This ${this.label} session is archived.`
  }

  private async probe(): Promise<BackendAvailability> {
    try {
      const runtime = await this.resolveRuntime()
      this.binary = runtime.binary
      this.processEnv = this.withShippedTools(runtime.env)
      return { id: this.id, available: true, version: runtime.version, verified: runtime.verified }
    } catch (error) {
      this.binary = undefined
      this.processEnv = undefined
      return {
        id: this.id,
        available: false,
        reason: error instanceof Error ? error.message : `${this.label} CLI is unavailable.`
      }
    }
  }

  // ADR-0033
  private withShippedTools(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const { fallbackBin, gitBin } = this.deps
    let pathVar = env.PATH
    if (fallbackBin) pathVar = pathWithDirLast(pathVar, fallbackBin)
    if (gitBin) pathVar = pathWithDirFirst(pathVar, gitBin)
    return this.deps.gitAccounts.configEnv({ ...env, PATH: pathVar })
  }

  get defaultEnv(): NodeJS.ProcessEnv | undefined {
    return this.processEnv
  }
  abstract transcriptExists(key: string): Promise<boolean>
  abstract readTurns(key: string, n: number): Promise<Turn[]>

  protected get label(): string {
    return BACKEND_LABEL[this.id]
  }

  protected changed(): void {
    clearTimeout(this.emitTimer)
    this.emitTimer = undefined
    this.lastEmitMs = Date.now()
    this.deps.changed()
  }

  protected changedSoon(): void {
    if (this.emitTimer) return
    const wait = Math.max(0, EMIT_THROTTLE_MS - (Date.now() - this.lastEmitMs))
    this.emitTimer = setTimeout(() => this.changed(), wait)
  }

  async availability(opts: { force?: boolean } = {}): Promise<BackendAvailability> {
    const probed = this.probed
    if (
      !opts.force &&
      probed &&
      (probed.reply.available || Date.now() - probed.at < AVAILABILITY_FAILURE_MS)
    )
      return probed.reply
    this.probing ??= this.probe()
      .then((reply) => {
        this.probed = { at: Date.now(), reply }
        return reply
      })
      .finally(() => (this.probing = undefined))
    return this.probing
  }

  forgetAvailability(): void {
    this.probed = undefined
  }

  protected forgetProbe(): void {
    this.probed = undefined
    this.binary = undefined
    this.processEnv = undefined
  }

  protected noteBinaryGone(error: unknown): void {
    if (binaryGone(error)) this.forgetProbe()
  }

  private warnUntestedVersion(available: BackendAvailability): void {
    if (available.verified !== false || !available.version) return
    if (this.warnedVersion === available.version) return
    this.warnedVersion = available.version
    this.deps.error(this.untestedNotice(available.version))
  }

  hasProcesses(): boolean {
    return this.runs.size > 0 || this.pendingLaunches.size > 0
  }

  list(): BackendSessionInfo[] {
    return [...this.runs.values()].flatMap((r) => (r.info ? [{ ...r.info }] : []))
  }
  hasTab(tabId: string): boolean {
    return this.runs.has(tabId)
  }
  sessionIdOf(tabId: string): string | undefined {
    return this.runs.get(tabId)?.info?.sessionId
  }
  workspaceOfTab(tabId: string): string | undefined {
    return this.runs.get(tabId)?.workspace
  }
  aliveTabFor(key: string): string | undefined {
    return [...this.runs.values()].find((r) => r.info?.sessionId === key || r.resumeKey === key)
      ?.tabId
  }
  private readsRunning(key: string): boolean {
    return !!this.aliveTabFor(key) || this.relaunchingKeys.has(key)
  }
  occupantOf(dir: string): string | null {
    for (const run of this.runs.values()) {
      const info = run.info
      if (!info) {
        if (samePlace(run.cwd, dir)) return `a starting ${this.label} session`
        continue
      }
      if (samePlace(info.treeRoot, dir)) return occupantName(info)
      const bound = this.findRow(info.sessionId)?.worktreeState
      if (bound && samePlace(bound.worktreePath, dir)) return occupantName(info)
    }
    return null
  }

  runningBindings(): Map<string, string> {
    return new Map(
      [...this.runs.values()].flatMap((run) => {
        const key = run.info?.sessionId ?? run.resumeKey
        return key ? [[key, run.tabId] as const] : []
      })
    )
  }
  findRow(key: string): BackendSessionRow | undefined {
    const member = this.store.getMember(key)
    const entry = this.history.get(key)
    const workspace = member?.workspacePath ?? (entry ? this.workspaceFor(entry.cwd) : undefined)
    return workspace ? this.rows(workspace).find((row) => row.id === key) : undefined
  }
  members(): Set<string> {
    return new Set([
      ...this.store.listMembers().map((m) => m.key),
      ...[...this.runs.values()].map((r) => r.info?.sessionId ?? r.resumeKey ?? r.tabId)
    ])
  }

  rows(workspace: string): BackendSessionRow[] {
    const scope: RowScope = {
      byPath: new Map(this.store.listResources().map((r) => [r.worktreePath, r])),
      remotePlaces: new Map()
    }
    const rows = new Map<string, BackendSessionRow>()
    for (const [key, t] of this.history) {
      const member = this.store.getMember(key)
      if ((member?.workspacePath ?? this.workspaceFor(t.cwd, scope)) !== workspace) continue
      rows.set(key, this.row(t, scope))
    }
    for (const m of this.store.listMembers(workspace)) {
      if (this.gone(m.key, m.updatedAt)) {
        rows.delete(m.key)
        continue
      }
      const r: BackendSessionRow = rows.get(m.key) ?? {
        id: m.key,
        title: m.title,
        cwd: m.cwd,
        worktree: 'main',
        running: false,
        invalidCwd: seenMissing(m.cwd),
        mtime: m.updatedAt
      }
      // MUSE§2
      if (this.keepsItsOwnTitle && m.named) r.title = m.title
      r.cwd = m.cwd
      r.invalidCwd = seenMissing(m.cwd)
      r.nativeSessionId = m.id
      r.createdAt = m.createdAt
      r.running = this.readsRunning(m.key)
      const resource = m.worktreeResourceId
        ? this.store.getResource(m.worktreeResourceId)
        : undefined
      if (resource) {
        r.worktree = resource.worktreeName
        r.worktreeState = { ...resource, worktreeBranch: resource.worktreeBranch ?? '' }
      }
      rows.set(m.key, r)
    }
    for (const run of this.runs.values()) {
      if (run.workspace !== workspace || run.info) continue
      if (run.resumeKey && rows.has(run.resumeKey)) {
        rows.get(run.resumeKey)!.running = true
        continue
      }
      rows.set(run.tabId, {
        id: run.tabId,
        title: 'Starting…',
        cwd: run.cwd,
        worktree: run.resource?.worktreeName ?? 'main',
        running: true,
        pending: true,
        invalidCwd: false,
        mtime: Date.now()
      })
    }
    return [...rows.values()].sort(
      (a, b) => Number(!!b.pending) - Number(!!a.pending) || (b.createdAt ?? 0) - (a.createdAt ?? 0)
    )
  }

  private row(t: H, scope: RowScope): BackendSessionRow {
    const key = this.keyOf(t.id, hostOfPath(t.cwd))
    const resource = scope.byPath.get(t.cwd)
    const place = this.placeOf(t.cwd, scope)
    return {
      id: key,
      nativeSessionId: t.id,
      createdAt: (t.createdAt ?? 0) * 1000,
      title:
        this.store.nameOfLeftMember(key) ||
        t.name ||
        t.preview?.slice(0, 100) ||
        PLACEHOLDER_TITLES[this.id],
      cwd: t.cwd,
      worktree: resource?.worktreeName ?? place.worktreeName ?? 'main',
      running: this.readsRunning(key),
      invalidCwd: place.missing,
      mtime: (t.updatedAt ?? t.createdAt ?? 0) * 1000,
      ...(resource
        ? { worktreeState: { ...resource, worktreeBranch: resource.worktreeBranch ?? '' } }
        : {})
    }
  }

  protected workspaceFor(cwd: string, scope?: RowScope): string {
    const resource = scope
      ? scope.byPath.get(cwd)
      : this.store.listResources().find((r) => r.worktreePath === cwd)
    if (resource) return resource.originalCwd
    return scope ? this.placeOf(cwd, scope).root : this.deps.projectInfo(cwd).root
  }

  private placeOf(cwd: string, scope: RowScope): Place {
    const places = isRemoteKey(cwd) ? scope.remotePlaces : this.places
    const known = places.get(cwd)
    if (known) return known
    const place = { ...this.deps.projectInfo(cwd), missing: seenMissing(cwd) }
    places.set(cwd, place)
    return place
  }

  async refreshHistory(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.readHistory().finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async readHistory(): Promise<void> {
    if (this.shuttingDown) return
    if (!this.binary) {
      const available = await this.availability()
      if (!available.available) {
        this.historyError = new Error(available.reason ?? `${this.label} CLI is unavailable.`)
        return
      }
    }
    if (this.shuttingDown) return
    let entries: { key: string; entry: H; archived: boolean }[]
    const startedAt = Date.now()
    try {
      entries = await this.listHistory()
    } catch (error) {
      this.noteBinaryGone(error)
      this.historyError = error instanceof Error ? error : new Error(String(error))
      return
    }
    const seen = new Map<string, H>()
    const archivedIds = new Set<string>()
    for (const { key, entry, archived } of entries) {
      seen.set(key, entry)
      if (archived) archivedIds.add(key)
    }
    this.history = seen
    this.places.clear()
    this.archivedIds = archivedIds
    this.listedAt.set(undefined, startedAt)
    this.historyError = undefined
    this.changed()
  }

  searchable(workspaces: string[]): SearchCandidate[] {
    return workspaces.flatMap((workspacePath) =>
      this.rows(workspacePath)
        .filter((row) => !row.pending && !this.archivedIds.has(row.id))
        .map((row) => ({ row: { ...row, ...sourceOf(this.id, workspacePath) }, workspacePath }))
    )
  }

  async historyRows(workspace: string): Promise<BackendSessionRow[]> {
    await this.refreshHistory()
    if (this.historyError) throw this.historyError
    return this.rows(workspace).filter(
      (r) => !r.running && !this.members().has(r.id) && !this.archivedIds.has(r.id)
    )
  }

  threadGone(key: string): boolean {
    return !this.refreshing && this.gone(key, this.store.getMember(key)?.updatedAt ?? 0)
  }

  // CODEX§2
  private gone(key: string, boundAt: number): boolean {
    const listedAt = this.listedAt.get(hostOfKey(key))
    return (
      listedAt !== undefined &&
      boundAt < listedAt - NEW_SESSION_LIST_LAG_MS &&
      (!this.history.has(key) || this.archivedIds.has(key)) &&
      !this.readsRunning(key)
    )
  }

  launchedBypassingChecks(tabId: string): boolean {
    return !!this.runs.get(tabId)?.bypassing
  }

  protected permissionOf(opts: CreateTabOptions): LaunchPermission {
    const asked = opts.permission ?? 'default'
    return asked === 'default' && this.deps.skipPermissions?.() ? 'bypass' : asked
  }

  archive(key: string): boolean {
    if (this.aliveTabFor(key)) return false
    const removed = this.removeMember(key)
    this.changed()
    return removed
  }

  protected removeMember(key: string): boolean {
    return this.store.removeMember(key)
  }

  launch(
    opts: CreateTabOptions,
    resource?: WorktreeResource
  ): Promise<{ id: string; cwd: string }> {
    return this.trackLaunch(opts.resumeSessionId, () => this.launchRun(opts, resource))
  }

  protected assertStarting(): void {
    if (this.shuttingDown)
      throw new Error(`Koloft is shutting down; the ${this.label} launch was cancelled.`)
  }

  protected nativeId(key: string): string {
    const identity = identityOf(key)
    if (
      identity.backendId !== this.id ||
      this.keyOf(identity.nativeSessionId, hostOfKey(key)) !== key
    ) {
      throw new Error(`A ${this.label} session is required.`)
    }
    return identity.nativeSessionId
  }

  // ADR-0025
  protected async dirThere(dir: string): Promise<boolean> {
    if (!isRemoteKey(dir)) return dirExists(dir)
    return (await this.deps.remoteDirExists?.(dir)) ?? false
  }

  private trackLaunch(
    key: string | undefined,
    start: () => Promise<{ id: string; cwd: string }>
  ): Promise<{ id: string; cwd: string }> {
    try {
      this.assertStarting()
      if (key) {
        this.nativeId(key)
        if (this.launchingKeys.has(key))
          throw new Error(`This ${this.label} session is already opening.`)
        this.launchingKeys.add(key)
      }
    } catch (error) {
      return Promise.reject(error)
    }
    const pending = start().finally(() => {
      if (key) this.launchingKeys.delete(key)
      if (key && this.relaunchingKeys.delete(key)) this.changed()
      this.pendingLaunches.delete(pending)
    })
    this.pendingLaunches.add(pending)
    return pending
  }

  private async waitForPrevious(key?: string): Promise<void> {
    if (!key) return
    const previous = [...this.runs.values()].find(
      (r) => r.info?.sessionId === key || r.resumeKey === key
    )
    if (previous?.stopping) {
      this.relaunchingKeys.add(key)
      await previous.stopping
    }
    this.assertStarting()
    if (this.aliveTabFor(key)) throw new Error(`This ${this.label} session is already open.`)
  }

  private async launchRun(
    opts: CreateTabOptions,
    resource?: WorktreeResource
  ): Promise<{ id: string; cwd: string }> {
    if (opts.kind !== this.id) throw new Error(`A ${this.label} launch is required.`)
    await this.waitForPrevious(opts.resumeSessionId)
    const available = await this.availability()
    this.assertStarting()
    if (!available.available) throw new Error(available.reason)
    let cwd = opts.cwd
    if (typeof cwd !== 'string' || !isAbsoluteOnHost(cwd) || !(await this.dirThere(cwd)))
      throw new ResumeRefused('cwd-missing', 'The session folder is missing.')
    const workspace = this.workspaceFor(cwd)
    if (opts.resumeSessionId && this.aliveTabFor(opts.resumeSessionId))
      throw new Error(`This ${this.label} session is already open.`)
    const prepared = this.prepare(opts)
    let freshWorktree = false
    if (opts.worktreeResourceId) {
      const saved = this.store.getResource(opts.worktreeResourceId)
      if (!saved || saved.originalCwd !== workspace || opts.worktree || opts.resumeSessionId)
        throw new Error('Invalid worktree recovery request.')
      resource = await this.worktrees.rebuild(saved.id)
      cwd = resource.worktreePath
    } else if (opts.worktree) {
      resource = await this.worktrees.create(workspace, opts.worktree)
      cwd = resource.worktreePath
      freshWorktree = !opts.scheduled
    } else if (!resource && this.deps.projectInfo(cwd).worktreeName) {
      resource = await this.worktrees.adopt(workspace, this.deps.projectInfo(cwd).treeRoot)
    }
    this.assertStarting()
    const run = await this.startRun({ opts, cwd, workspace, resource, freshWorktree }, prepared)
    this.runs.set(run.tabId, run)
    this.changed()
    this.warnUntestedVersion(available)
    return { id: run.tabId, cwd }
  }

  observe(tabId: string, event: SessionEvent): void {
    const run = this.runs.get(tabId)
    if (event.type === 'degraded') {
      this.markDegraded(run)
      this.deps.error(event.message)
      return
    }
    if (!run || run.explicitStop || run.stopping) return
    const info = run.info
    if (!info) return
    const runtime = this.deps.runtime
    const turn = turnOf(event)
    if (turn) return runtime.recordTurn(run.tabId, turn)
    switch (event.type) {
      case 'background-changed':
        if (!runtime.setBackground(run.tabId, event.items)) return
        info.background = event.items.length ? event.items : undefined
        return this.changedSoon()
      case 'usage':
        info.usage = event.usage
        return this.changedSoon()
      case 'title':
        return this.retitle(info, event.title)
      case 'files-changed':
        info.files = event.files
        info.lastTouched = event.lastTouched
        info.lastWritten = event.lastWritten
        info.liveWrites = event.liveWrites
        return this.changedSoon()
    }
  }

  protected markDegraded(run: R | undefined): void {
    if (!run?.info) return
    run.info.details = this.degradedDetails()
    this.changed()
  }

  protected bind(run: R, entry: H, change: 'replace' | 'switch'): void {
    const key = this.keyOf(entry.id, hostOfPath(entry.cwd)),
      old = run.info?.sessionId
    if (run.info) {
      run.cwd = entry.cwd
      run.workspace = this.workspaceFor(entry.cwd)
      const treeRoot = this.deps.projectInfo(entry.cwd).treeRoot
      run.resource = this.store.listResources().find((r) => r.worktreePath === treeRoot)
    }
    const m = this.store.getMember(key),
      leftName = m ? undefined : this.store.nameOfLeftMember(key),
      now = Date.now()
    try {
      this.store.upsertMember({
        id: entry.id,
        key,
        workspacePath: run.workspace,
        cwd: run.cwd,
        title:
          run.launchName ||
          (this.keepsItsOwnTitle && m?.title !== PLACEHOLDER_TITLES[this.id] ? m?.title : '') ||
          leftName ||
          entry.name ||
          entry.preview?.slice(0, 100) ||
          m?.title ||
          PLACEHOLDER_TITLES[this.id],
        createdAt: m?.createdAt ?? (entry.createdAt ? entry.createdAt * 1000 : now),
        updatedAt: now,
        worktreeResourceId: run.resource?.id,
        ...(run.permission !== 'default' ? { permission: run.permission } : {}),
        ...(this.keepsItsOwnTitle && (run.launchName || m?.named || leftName)
          ? { named: true as const }
          : {})
      })
      if (change === 'replace' && old && old !== key) {
        this.deps.replaced?.(old, key)
        if (![...this.runs.values()].some((r) => r !== run && r.info?.sessionId === old))
          this.removeMember(old)
      }
    } catch (e) {
      this.deps.error(String(e))
    }
    run.resumeKey = undefined
    run.launchName = undefined
    this.deps.runtime.forget(run.tabId)
    run.info = {
      tabId: run.tabId,
      sessionId: key,
      nativeSessionId: entry.id,
      title: this.store.getMember(key)?.title ?? PLACEHOLDER_TITLES[this.id],
      cwd: run.cwd,
      treeRoot: run.cwd,
      worktree: run.resource?.worktreeName,
      alive: true,
      ...this.runDetails(run),
      cliVersion: entry.cliVersion,
      updatedAt: now
    }
    this.history.set(key, { ...entry, cwd: run.cwd })
    this.deps.pty.clearResumeIntent(run.tabId)
    this.changed()
    this.deps.events(run.tabId, { type: 'bound', key })
  }

  protected retitle(info: BackendSessionInfo, title: string, named?: true): void {
    info.title = title
    try {
      this.store.updateMember(info.sessionId, {
        title,
        updatedAt: Date.now(),
        ...(named ? { named } : {})
      })
    } catch (e) {
      this.deps.error(String(e))
    }
    const t = this.history.get(info.sessionId)
    if (t) t.name = title
    this.changedSoon()
  }

  resume(req: SessionResumeRequest): Promise<{ id: string; cwd: string }> {
    return this.trackLaunch(req.sessionId, () => this.resumeRun(req))
  }

  private async resumeRun(req: SessionResumeRequest): Promise<{ id: string; cwd: string }> {
    await this.waitForPrevious(req.sessionId)
    if (this.archivedIds.has(req.sessionId)) throw new Error(this.archivedNotice(req.sessionId))
    const m = this.store.getMember(req.sessionId)
    const t = this.history.get(req.sessionId)
    if (!m && !t)
      throw new Error(`This ${this.label} session is unavailable. Refresh history and try again.`)
    let resource = m?.worktreeResourceId
      ? this.store.getResource(m.worktreeResourceId)
      : this.store.listResources().find((r) => r.worktreePath === t?.cwd)
    let cwd = m?.cwd ?? t!.cwd
    if (
      await rebuildsTheWorktree(
        req.mode,
        async () => !resource || this.dirThere(resource.worktreePath)
      )
    ) {
      if (!resource) throw new ResumeRefused('rebuild-failed')
      resource = await this.worktrees.rebuild(resource.id).catch(() => {
        throw new ResumeRefused('rebuild-failed')
      })
      cwd = resource.worktreePath
    } else if (req.mode === 'renamed') {
      if (!resource || !req.worktree) throw new ResumeRefused('invalid-args')
      resource = await this.worktrees.prepareRenamed(resource.id, req.worktree)
      cwd = resource.worktreePath
    } else if (req.mode === 'main') {
      cwd = resource?.originalCwd ?? this.workspaceFor(cwd)
      resource = undefined
    }
    this.assertStarting()
    return this.launchRun(
      {
        kind: this.id,
        cwd,
        resumeSessionId: req.sessionId,
        cols: req.cols,
        rows: req.rows,
        role: req.role,
        conductor: req.conductor,
        permission: req.permission ?? m?.permission,
        trustFolder: req.trustFolder
      },
      resource
    )
  }

  stop(tabId: string, nativeExitCode?: number, restarting = false): Promise<void> {
    const run = this.runs.get(tabId)
    if (!run) return Promise.resolve()
    if (run.stopping) return run.stopping
    const nativeExit = nativeExitCode === 0 && this.exitedOnItsOwn(run) && !run.explicitStop
    const unexpectedExit = nativeExitCode !== undefined && nativeExitCode !== 0 && !run.explicitStop
    run.explicitStop = true
    run.stopping = Promise.resolve()
      .then(() => this.endRun(run))
      .then(async () => {
        run.releaseTools()
        this.deps.pty.kill(tabId)
        this.deps.runtime.forget(tabId)
        const crashedWithNoRowToMark = unexpectedExit && !run.info?.sessionId
        if (!crashedWithNoRowToMark)
          this.deps.events(tabId, {
            type: 'exited',
            clean: !unexpectedExit,
            title: run.info?.title,
            sessionId: run.info?.sessionId
          })
        this.runs.delete(tabId)
        if (nativeExit && run.info && !this.aliveTabFor(run.info.sessionId)) {
          try {
            this.removeMember(run.info.sessionId)
          } catch (error) {
            this.deps.error(String(error))
          }
        }
        if (!this.shuttingDown && !restarting && run.resource)
          await this.deps.leftWorktree?.(run.resource)
        this.changed()
        if (!this.shuttingDown)
          void this.refreshHistory().catch((error) => this.deps.error(String(error)))
      })
      .catch((error) => {
        run.stopping = undefined
        if (run.info) run.info.details = this.degradedDetails()
        this.changed()
        throw error
      })
    return run.stopping
  }

  async stopAll(deadlineMs = 5000): Promise<void> {
    this.shuttingDown = true
    const stopped = (async () => {
      await Promise.allSettled([...this.pendingLaunches])
      await Promise.all([...this.runs.keys()].map((id) => this.stop(id)))
      if (this.refreshing) await this.refreshing
    })()
    stopped.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      stopped,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs)
      })
    ])
    clearTimeout(timer)
  }
}
