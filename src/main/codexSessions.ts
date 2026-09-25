import fs from 'fs'
import os from 'os'
import path from 'path'
import type {
  CreateTabOptions,
  LaunchPermission,
  ProjectInfo,
  BackendSessionInfo,
  SessionResumeRequest,
  BackendSessionRow
} from '@shared/types'
import { identityOf } from '@shared/sessionBackend'
import type { SessionEvent } from '@shared/sessionEvent'
import {
  CodexObservation,
  record,
  userThread,
  type CodexEvent,
  type CodexThread
} from './codexObservation'
import { CodexRpc, createCodexTransport } from './codexTransport'
import { SessionStore, codexSessionKey, type WorktreeResource } from './sessionStore'
import { SessionWorktrees } from './sessionWorktrees'
import type { PtyManager } from './ptyManager'
import { resolveCodexRuntime } from './codexRuntime'
import { occupantName } from './resumePlan'
import { turnOf, type SessionRuntime, type StatusEdge } from './sessionRuntime'

const exists = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

const STATUS_LINE_CONFIG = `tui.status_line=${JSON.stringify([
  'context-used',
  'git-branch',
  'codex-version',
  'model-with-reasoning',
  'estimated-thread-cost',
  'pull-request-number',
  'current-dir'
])}`

// CODEX§11
const PERMISSION_ARGS: Record<LaunchPermission, string[]> = {
  default: [],
  acceptEdits: ['-a', 'on-request', '-s', 'workspace-write'],
  bypass: ['-a', 'never', '-s', 'danger-full-access']
}

// CODEX§14
function launchChoiceArgs(opts: CreateTabOptions): string[] {
  return [
    ...(opts.model ? ['-m', opts.model] : []),
    ...(opts.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(opts.effort)}`] : [])
  ]
}

export interface CodexAvailability {
  id: 'codex'
  available: boolean
  reason?: string
  version?: string
  verified?: boolean
}

const AVAILABILITY_FAILURE_MS = 60_000
const EMIT_THROTTLE_MS = 500

const binaryGone = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'

export interface CodexSessionDeps {
  pty: PtyManager
  runtime: SessionRuntime
  projectInfo(p: string): ProjectInfo
  changed(): void
  events(tabId: string, event: SessionEvent): void
  error(message: string): void
  trustFolder(root: string, env: NodeJS.ProcessEnv | undefined): void
  pickHome(): { account: string; home: string } | undefined
  homes(): string[]
}

interface RowScope {
  byPath: Map<string, WorktreeResource>
  roots: Map<string, string>
}

interface Run {
  tabId: string
  cwd: string
  workspace: string
  info?: BackendSessionInfo
  resource?: WorktreeResource
  observer: CodexObservation
  transport: Awaited<ReturnType<typeof createCodexTransport>>
  stopping?: Promise<void>
  explicitStop: boolean
  resumeKey?: string
  home?: string
  account?: string
}

export class CodexSessions {
  private runs = new Map<string, Run>()
  private history = new Map<string, CodexThread>()
  private threadHomes = new Map<string, string>()
  private archivedIds = new Set<string>()
  private binary?: string
  private processEnv?: NodeJS.ProcessEnv
  private probed?: { at: number; reply: CodexAvailability }
  private warnedVersion?: string
  private refreshing?: Promise<void>
  private historyError?: Error
  private launchingKeys = new Set<string>()
  private pendingLaunches = new Set<Promise<{ id: string; cwd: string }>>()
  private shuttingDown = false
  private emitTimer?: ReturnType<typeof setTimeout>
  private lastEmitMs = 0
  readonly store: SessionStore
  readonly worktrees: SessionWorktrees

  constructor(
    file: string,
    private deps: CodexSessionDeps
  ) {
    this.store = new SessionStore(file)
    this.worktrees = new SessionWorktrees(this.store)
    deps.runtime.on('status', ({ tabId, next }: StatusEdge) => {
      const run = this.runs.get(tabId)
      if (!run?.info || run.explicitStop || run.stopping) return
      run.info.status = next
      run.info.updatedAt = Date.now()
      this.changedSoon()
    })
  }

  private changed(): void {
    clearTimeout(this.emitTimer)
    this.emitTimer = undefined
    this.lastEmitMs = Date.now()
    this.deps.changed()
  }

  private changedSoon(): void {
    if (this.emitTimer) return
    const wait = Math.max(0, EMIT_THROTTLE_MS - (Date.now() - this.lastEmitMs))
    this.emitTimer = setTimeout(() => this.changed(), wait)
  }

  async availability(opts: { force?: boolean } = {}): Promise<CodexAvailability> {
    const probed = this.probed
    if (
      !opts.force &&
      probed &&
      (probed.reply.available || Date.now() - probed.at < AVAILABILITY_FAILURE_MS)
    )
      return probed.reply
    let reply: CodexAvailability
    try {
      const runtime = await resolveCodexRuntime()
      this.binary = runtime.binary
      this.processEnv = runtime.env
      reply = {
        id: 'codex',
        available: true,
        version: runtime.version,
        verified: runtime.verified
      }
    } catch (error) {
      this.binary = undefined
      this.processEnv = undefined
      reply = {
        id: 'codex',
        available: false,
        reason: error instanceof Error ? error.message : 'Codex CLI is unavailable.'
      }
    }
    this.probed = { at: Date.now(), reply }
    return reply
  }

  private warnUntestedVersion(available: CodexAvailability): void {
    if (available.verified !== false || !available.version) return
    if (this.warnedVersion === available.version) return
    this.warnedVersion = available.version
    this.deps.error(
      `Codex ${available.version} is newer than the version Koloft was tested with (0.153.x). It may misbehave.`
    )
  }

  private forgetProbe(): void {
    this.probed = undefined
    this.binary = undefined
    this.processEnv = undefined
  }

  private async startTransport(
    options: Parameters<typeof createCodexTransport>[0]
  ): Promise<Awaited<ReturnType<typeof createCodexTransport>>> {
    try {
      return await createCodexTransport(options)
    } catch (error) {
      this.forgetProbe()
      throw error
    }
  }

  get defaultEnv(): NodeJS.ProcessEnv | undefined {
    return this.processEnv
  }

  get cliBinary(): string | undefined {
    return this.binary
  }

  // CODEX§15
  private envFor(home: string | undefined): NodeJS.ProcessEnv | undefined {
    return home ? { ...this.processEnv, CODEX_HOME: home } : this.processEnv
  }

  private homeFor(key: string): string | undefined {
    return this.store.getMember(key)?.codexHome ?? this.threadHomes.get(key)
  }

  private rpc(home: string | undefined): CodexRpc {
    return new CodexRpc({ binary: this.binary!, env: this.envFor(home), cwd: os.homedir() })
  }

  // CODEX§15
  async readAccount(home: string): Promise<{ signedIn: boolean; limits?: unknown }> {
    if (!this.binary && !(await this.availability()).available)
      throw new Error('Codex CLI is unavailable.')
    const rpc = this.rpc(home)
    try {
      const account = record(await rpc.request('account/read', {}))
      if (!account.account) return { signedIn: false }
      return { signedIn: true, limits: await rpc.request('account/rateLimits/read', {}) }
    } finally {
      await rpc.close()
    }
  }

  hasRuns(): boolean {
    return this.runs.size > 0 || this.pendingLaunches.size > 0
  }

  list(): BackendSessionInfo[] {
    return [...this.runs.values()].flatMap((r) => (r.info ? [{ ...r.info }] : []))
  }
  hasTab(tabId: string): boolean {
    return this.runs.has(tabId)
  }
  aliveTabFor(key: string): string | undefined {
    return [...this.runs.values()].find((r) => r.info?.sessionId === key || r.resumeKey === key)
      ?.tabId
  }
  occupantOf(dir: string): string | null {
    const target = path.resolve(dir)
    for (const run of this.runs.values()) {
      const info = run.info
      if (!info) {
        if (path.resolve(run.cwd) === target) return 'a starting Codex session'
        continue
      }
      if (path.resolve(info.treeRoot) === target) return occupantName(info)
      const bound = this.findRow(info.sessionId)?.worktreeState
      if (bound && path.resolve(bound.worktreePath) === target) return occupantName(info)
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
    const thread = this.history.get(key)
    const workspace = member?.workspacePath ?? (thread ? this.workspaceFor(thread.cwd) : undefined)
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
      roots: new Map()
    }
    const rows = new Map<string, BackendSessionRow>()
    for (const [key, t] of this.history) {
      const member = this.store.getMember(key)
      if ((member?.workspacePath ?? this.workspaceFor(t.cwd, scope)) !== workspace) continue
      rows.set(key, this.row(t, scope))
    }
    for (const m of this.store.listMembers(workspace)) {
      const r: BackendSessionRow = rows.get(m.key) ?? {
        id: m.key,
        title: m.title,
        cwd: m.cwd,
        worktree: 'main',
        running: false,
        invalidCwd: !exists(m.cwd),
        mtime: m.updatedAt
      }
      r.cwd = m.cwd
      r.invalidCwd = !exists(m.cwd)
      r.nativeSessionId = m.id
      r.createdAt = m.createdAt
      r.running = !!this.aliveTabFor(m.key)
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

  private row(t: CodexThread, scope: RowScope): BackendSessionRow {
    const key = codexSessionKey(t.id)
    const resource = scope.byPath.get(t.cwd)
    return {
      id: key,
      nativeSessionId: t.id,
      createdAt: (t.createdAt ?? 0) * 1000,
      title: t.name || t.preview?.slice(0, 100) || 'Codex session',
      cwd: t.cwd,
      worktree: resource?.worktreeName ?? this.deps.projectInfo(t.cwd).worktreeName ?? 'main',
      running: !!this.aliveTabFor(key),
      invalidCwd: !exists(t.cwd),
      mtime: (t.updatedAt ?? t.createdAt ?? 0) * 1000,
      ...(resource
        ? { worktreeState: { ...resource, worktreeBranch: resource.worktreeBranch ?? '' } }
        : {})
    }
  }

  private workspaceFor(cwd: string, scope?: RowScope): string {
    const resource = scope
      ? scope.byPath.get(cwd)
      : this.store.listResources().find((r) => r.worktreePath === cwd)
    if (resource) return resource.originalCwd
    const known = scope?.roots.get(cwd)
    if (known !== undefined) return known
    const root = this.deps.projectInfo(cwd).root
    scope?.roots.set(cwd, root)
    return root
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
        this.historyError = new Error(available.reason ?? 'Codex CLI is unavailable.')
        return
      }
    }
    if (this.shuttingDown) return
    const homeList = [undefined, ...this.deps.homes()]
    const listings = await Promise.allSettled(homeList.map((home) => this.listHome(home)))
    const defaultListing = listings[0]
    if (defaultListing.status === 'rejected') {
      if (binaryGone(defaultListing.reason)) this.forgetProbe()
      const error = defaultListing.reason
      this.historyError = error instanceof Error ? error : new Error(String(error))
      return
    }
    const seen = new Map<string, CodexThread>()
    const homes = new Map<string, string>()
    const archivedIds = new Set<string>()
    listings.forEach((listing, i) => {
      const home = homeList[i]
      const threads =
        listing.status === 'fulfilled'
          ? listing.value
          : [...this.threadHomes]
              .filter(([key, owner]) => owner === home && this.history.has(key))
              .map(([key]) => ({
                key,
                thread: this.history.get(key)!,
                archived: this.archivedIds.has(key)
              }))
      for (const { key, thread, archived } of threads) {
        seen.set(key, thread)
        if (home) homes.set(key, home)
        if (archived) archivedIds.add(key)
      }
    })
    this.history = seen
    this.threadHomes = homes
    this.archivedIds = archivedIds
    this.historyError = undefined
    this.changed()
  }

  private async listHome(
    home: string | undefined
  ): Promise<{ key: string; thread: CodexThread; archived: boolean }[]> {
    const rpc = this.rpc(home)
    const threads: { key: string; thread: CodexThread; archived: boolean }[] = []
    try {
      for (const archived of [false, true]) {
        let cursor: string | undefined
        const cursors = new Set<string>()
        do {
          const reply = record(
            await rpc.request('thread/list', {
              limit: 100,
              cursor,
              archived,
              sourceKinds: ['cli', 'vscode', 'appServer']
            })
          )
          if (!Array.isArray(reply.data))
            throw new Error('Codex history returned an unsupported response.')
          for (const value of reply.data) {
            const thread = userThread(value)
            if (thread) threads.push({ key: codexSessionKey(thread.id), thread, archived })
          }
          cursor =
            typeof reply.nextCursor === 'string' && reply.nextCursor ? reply.nextCursor : undefined
          if (cursor && cursors.has(cursor)) throw new Error('Codex history repeated a page.')
          if (cursor) cursors.add(cursor)
        } while (cursor)
      }
      return threads
    } finally {
      await rpc.close()
    }
  }

  async historyRows(workspace: string): Promise<BackendSessionRow[]> {
    await this.refreshHistory()
    if (this.historyError) throw this.historyError
    return this.rows(workspace).filter(
      (r) => !r.running && !this.members().has(r.id) && !this.archivedIds.has(r.id)
    )
  }

  async transcriptExists(key: string): Promise<boolean> {
    const id = this.nativeId(key)
    if (this.archivedIds.has(key)) return false
    if (!this.binary && !(await this.availability()).available)
      throw new Error('Codex CLI is unavailable.')
    const rpc = this.rpc(this.homeFor(key))
    try {
      const reply = record(await rpc.request('thread/read', { threadId: id, includeTurns: false }))
      const t = userThread(reply.thread)
      return !!t?.path && fs.existsSync(t.path)
    } catch (error) {
      if (binaryGone(error)) this.forgetProbe()
      throw error
    } finally {
      await rpc.close()
    }
  }

  archive(key: string): boolean {
    if (this.aliveTabFor(key)) return false
    const removed = this.store.removeMember(key)
    this.changed()
    return removed
  }

  launch(
    opts: CreateTabOptions,
    resource?: WorktreeResource
  ): Promise<{ id: string; cwd: string }> {
    return this.trackLaunch(opts.resumeSessionId, () => this.launchRun(opts, resource))
  }

  private assertStarting(): void {
    if (this.shuttingDown)
      throw new Error('Koloft is shutting down; the Codex launch was cancelled.')
  }

  private nativeId(key: string): string {
    const identity = identityOf(key)
    if (
      identity.backendId !== 'codex' ||
      identity.sourceId !== 'local' ||
      codexSessionKey(identity.nativeSessionId) !== key
    ) {
      throw new Error('A local Codex session is required.')
    }
    return identity.nativeSessionId
  }

  private trackLaunch(
    key: string | undefined,
    start: () => Promise<{ id: string; cwd: string }>
  ): Promise<{ id: string; cwd: string }> {
    try {
      this.assertStarting()
      if (key) {
        this.nativeId(key)
        if (this.launchingKeys.has(key)) throw new Error('This Codex session is already opening.')
        this.launchingKeys.add(key)
      }
    } catch (error) {
      return Promise.reject(error)
    }
    const pending = start().finally(() => {
      if (key) this.launchingKeys.delete(key)
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
    if (previous?.stopping) await previous.stopping
    this.assertStarting()
    if (this.aliveTabFor(key)) throw new Error('This Codex session is already open.')
  }

  private async launchRun(
    opts: CreateTabOptions,
    resource?: WorktreeResource
  ): Promise<{ id: string; cwd: string }> {
    if (opts.kind !== 'codex') throw new Error('A Codex launch is required.')
    await this.waitForPrevious(opts.resumeSessionId)
    const available = await this.availability()
    this.assertStarting()
    if (!available.available) throw new Error(available.reason)
    const binary = this.binary!,
      processEnv = this.processEnv
    let cwd = opts.cwd
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !exists(cwd))
      throw new Error('The session folder is missing.')
    const workspace = this.workspaceFor(cwd)
    if (opts.resumeSessionId && this.aliveTabFor(opts.resumeSessionId))
      throw new Error('This Codex session is already open.')
    if (opts.worktreeResourceId) {
      const saved = this.store.getResource(opts.worktreeResourceId)
      if (!saved || saved.originalCwd !== workspace || opts.worktree || opts.resumeSessionId)
        throw new Error('Invalid worktree recovery request.')
      resource = await this.worktrees.rebuild(saved.id)
      cwd = resource.worktreePath
    } else if (opts.worktree) {
      resource = await this.worktrees.create(workspace, opts.worktree)
      cwd = resource.worktreePath
      // ADR-0026
      if (!opts.scheduled) this.deps.trustFolder(workspace, processEnv)
    } else if (!resource && this.deps.projectInfo(cwd).worktreeName) {
      resource = await this.worktrees.adopt(workspace, this.deps.projectInfo(cwd).treeRoot)
    }
    this.assertStarting()
    const picked = opts.resumeSessionId ? undefined : this.deps.pickHome()
    const home = opts.resumeSessionId ? this.homeFor(opts.resumeSessionId) : picked?.home
    const env = this.envFor(home)
    let run: Run | undefined
    const observe = (event: CodexEvent): void => {
      if (event.type !== 'bound') {
        if (run) this.deps.events(run.tabId, event)
        else if (event.type === 'degraded') this.deps.error(event.message)
        return
      }
      if (run && !run.explicitStop && !run.stopping)
        this.bindThread(run, event.thread, event.change)
    }
    const observer = new CodexObservation(observe)
    const transport = await this.startTransport({
      binary,
      env,
      cwd,
      configOverrides: [STATUS_LINE_CONFIG],
      onFrame: (direction, frame) => observer.receive(direction, frame),
      onDisconnect: () => this.markDegraded(run),
      onError: (error) => {
        this.markDegraded(run)
        this.deps.error(String(error))
      }
    })
    try {
      this.assertStarting()
      const argv = [
        '--remote',
        transport.url,
        '-C',
        cwd,
        '-c',
        STATUS_LINE_CONFIG,
        ...PERMISSION_ARGS[opts.permission ?? 'default'],
        ...launchChoiceArgs(opts)
      ]
      if (opts.resumeSessionId) argv.push('resume', this.nativeId(opts.resumeSessionId))
      else if (opts.firstPrompt) argv.push(opts.firstPrompt)
      const handle = this.deps.pty.create({
        kind: 'codex',
        cwd,
        cols: opts.cols,
        rows: opts.rows,
        executable: binary,
        argv,
        processEnv: env,
        resumeSessionId: opts.resumeSessionId
      })
      run = {
        tabId: handle.id,
        cwd,
        workspace,
        resource,
        observer,
        transport,
        explicitStop: false,
        resumeKey: opts.resumeSessionId,
        home,
        account: picked?.account
      }
      this.runs.set(handle.id, run)
      this.changed()
      this.warnUntestedVersion(available)
      return { id: handle.id, cwd }
    } catch (error) {
      await transport.stop()
      throw error
    }
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

  private markDegraded(run: Run | undefined): void {
    if (!run?.info) return
    run.info.details = { codex: { observation: 'degraded' } }
    this.changed()
  }

  private bindThread(run: Run, thread: CodexThread, change: 'replace' | 'switch'): void {
    const key = codexSessionKey(thread.id),
      old = run.info?.sessionId
    if (run.info) {
      run.cwd = thread.cwd
      run.workspace = this.workspaceFor(thread.cwd)
      const treeRoot = this.deps.projectInfo(thread.cwd).treeRoot
      run.resource = this.store.listResources().find((r) => r.worktreePath === treeRoot)
    }
    const m = this.store.getMember(key),
      now = Date.now()
    try {
      this.store.upsertMember({
        id: thread.id,
        key,
        workspacePath: run.workspace,
        cwd: run.cwd,
        title: thread.name || thread.preview?.slice(0, 100) || m?.title || 'Codex session',
        createdAt: m?.createdAt ?? (thread.createdAt ? thread.createdAt * 1000 : now),
        updatedAt: now,
        worktreeResourceId: run.resource?.id,
        ...(run.home ? { codexHome: run.home } : {})
      })
      if (
        change === 'replace' &&
        old &&
        old !== key &&
        ![...this.runs.values()].some((r) => r !== run && r.info?.sessionId === old)
      )
        this.store.removeMember(old)
    } catch (e) {
      this.deps.error(String(e))
    }
    run.resumeKey = undefined
    this.deps.runtime.forget(run.tabId)
    run.info = {
      tabId: run.tabId,
      sessionId: key,
      nativeSessionId: thread.id,
      title: this.store.getMember(key)?.title ?? 'Codex session',
      cwd: run.cwd,
      treeRoot: run.cwd,
      worktree: run.resource?.worktreeName,
      alive: true,
      details: { codex: { observation: 'live' } },
      cliVersion: thread.cliVersion,
      ...(run.account ? { pickedAccount: run.account } : {}),
      updatedAt: now
    }
    this.history.set(key, { ...thread, cwd: run.cwd })
    if (run.home) this.threadHomes.set(key, run.home)
    this.deps.pty.clearResumeIntent(run.tabId)
    this.changed()
    this.deps.events(run.tabId, { type: 'bound', key })
  }

  private retitle(info: BackendSessionInfo, title: string): void {
    info.title = title
    try {
      this.store.updateMember(info.sessionId, { title, updatedAt: Date.now() })
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
    // CODEX§2
    if (this.archivedIds.has(req.sessionId)) {
      throw new Error(
        `Archived in Codex. Run codex unarchive ${this.nativeId(req.sessionId)} first.`
      )
    }
    const m = this.store.getMember(req.sessionId)
    const t = this.history.get(req.sessionId)
    if (!m && !t)
      throw new Error('This Codex session is unavailable. Refresh history and try again.')
    let resource = m?.worktreeResourceId
      ? this.store.getResource(m.worktreeResourceId)
      : this.store.listResources().find((r) => r.worktreePath === t?.cwd)
    let cwd = m?.cwd ?? t!.cwd
    if (req.mode === 'rebuild') {
      if (!resource) throw new Error('The worktree has no saved recovery record.')
      resource = await this.worktrees.rebuild(resource.id)
      cwd = resource.worktreePath
    } else if (req.mode === 'renamed') {
      if (!resource || !req.worktree) throw new Error('The new worktree name is missing.')
      resource = await this.worktrees.prepareRenamed(resource.id, req.worktree)
      cwd = resource.worktreePath
    } else if (req.mode === 'main') {
      cwd = resource?.originalCwd ?? this.workspaceFor(cwd)
      resource = undefined
    }
    this.assertStarting()
    return this.launchRun(
      { kind: 'codex', cwd, resumeSessionId: req.sessionId, cols: req.cols, rows: req.rows },
      resource
    )
  }

  stop(tabId: string, nativeExitCode?: number): Promise<void> {
    const run = this.runs.get(tabId)
    if (!run) return Promise.resolve()
    if (run.stopping) return run.stopping
    const nativeExit = nativeExitCode === 0 && run.observer.unsubscribed && !run.explicitStop
    const unexpectedExit = nativeExitCode !== undefined && nativeExitCode !== 0 && !run.explicitStop
    run.explicitStop = true
    run.stopping = Promise.resolve()
      .then(() => run.transport.stop())
      .then(() => {
        this.deps.pty.kill(tabId)
        this.deps.runtime.forget(tabId)
        this.deps.events(tabId, {
          type: 'exited',
          clean: !unexpectedExit,
          title: run.info?.title
        })
        this.runs.delete(tabId)
        if (nativeExit && run.info && !this.aliveTabFor(run.info.sessionId)) {
          try {
            this.store.removeMember(run.info.sessionId)
          } catch (error) {
            this.deps.error(String(error))
          }
        }
        this.changed()
        if (!this.shuttingDown)
          void this.refreshHistory().catch((error) => this.deps.error(String(error)))
      })
      .catch((error) => {
        run.stopping = undefined
        if (run.info) run.info.details = { codex: { observation: 'degraded' } }
        this.changed()
        throw error
      })
    return run.stopping
  }

  // CODEX§5
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
