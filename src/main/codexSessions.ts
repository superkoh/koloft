import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import type {
  CreateTabOptions,
  LaunchPermission,
  ProjectInfo,
  BackendSessionInfo,
  SessionResumeRequest,
  BackendSessionRow
} from '@shared/types'
import { CODEX_PLACEHOLDER_TITLE } from '@shared/types'
import { identityOf, sourceOf } from '@shared/sessionBackend'
import type { SearchCandidate } from './sessionSearch'
import type { SessionEvent } from '@shared/sessionEvent'
import type { Turn } from '@shared/turns'
import {
  CodexObservation,
  codexTurns,
  record,
  userThread,
  type CodexEvent,
  type CodexThread
} from './codexObservation'
import { CodexRpc, createCodexTransport, type CodexTransport } from './codexTransport'
import { endCodexAppServersLeftByACrash } from './leftovers'
import { SessionStore, codexSessionKey, type WorktreeResource } from './sessionStore'
import { SessionWorktrees } from './sessionWorktrees'
import type { PtyManager } from './ptyManager'
import { codexTooOld, resolveCodexRuntime, updateCodex, type CodexRuntime } from './codexRuntime'
import { MIN_CODEX_VERSION, TESTED_CODEX_LINE } from './cliMinimums'
import { occupantName } from './resumePlan'
import { turnOf, type SessionRuntime, type StatusEdge } from './sessionRuntime'
import { watchJsonDrops } from './jsonDrops'
import { openDropTarget, type OpenDrop } from './openDrop'
import { removeCodexOpenShim, writeCodexOpenShim } from './openShimScript'
import { AGENT_SHIM_WAITS_MS, writeCodexAgentShim } from './agentShim'
import { CODEX_AGENT_HINT } from '@shared/agentGuide'
import { portOffset } from '@shared/worktreeName'
import { NO_USABLE_ACCOUNT } from '@shared/accountUsage'
import type { CodexApproval, CodexQuestion } from './discord/dialog'

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

// CODEX§17
function developerInstructions(lines: string[]): string {
  return `developer_instructions=${JSON.stringify(lines.join('\n\n'))}`
}

const QUEUE_ANSWER_INSIDE_THE_KOLOFT_WAIT_MS = AGENT_SHIM_WAITS_MS / 2

// CODEX§1
const NO_UPDATE_NOTICE_AT_START = 'check_for_update_on_startup=false'

const playwrightMcpEnv = (endpoint: string): Record<string, string> => ({
  PLAYWRIGHT_MCP_CDP_ENDPOINT: endpoint,
  PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS: '1'
})

const runsPlaywrightMcp = (word: string): boolean =>
  word.includes('@playwright/mcp') || path.basename(word) === 'playwright-mcp'

const KEY_THE_CODEX_FLAG_PARSER_TAKES = /^[A-Za-z0-9_-]+$/

// CODEX§26
export function playwrightEnvOverrides(mcpServers: unknown): string[] {
  return Object.entries(record(mcpServers)).flatMap(([name, raw]) => {
    const entry = record(raw)
    const words = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])]
    if (!KEY_THE_CODEX_FLAG_PARSER_TAKES.test(name)) return []
    if (!words.some((w) => typeof w === 'string' && runsPlaywrightMcp(w))) return []
    const own = (Array.isArray(entry.env_vars) ? entry.env_vars : []).filter(
      (v): v is string => typeof v === 'string'
    )
    return [
      `mcp_servers.${name}.env_vars=${JSON.stringify([...new Set([...own, ...Object.keys(playwrightMcpEnv(''))])])}`
    ]
  })
}

interface Permissions {
  approval: 'never' | 'on-request'
  sandbox: 'workspace-write' | 'danger-full-access'
}

// CODEX§11
const PERMISSIONS: Record<LaunchPermission, Permissions | undefined> = {
  default: undefined,
  acceptEdits: { approval: 'on-request', sandbox: 'workspace-write' },
  bypass: { approval: 'never', sandbox: 'danger-full-access' }
}

// ADR-0029 CODEX§12
const CONDUCTOR_PERMISSIONS: Permissions = { approval: 'never', sandbox: 'workspace-write' }

// CODEX§11
function permissionFlags(p: Permissions | undefined): string[] {
  return p ? ['-a', p.approval, '-s', p.sandbox] : []
}

// CODEX§11
function permissionConfig(p: Permissions | undefined): string[] {
  return p
    ? [`approval_policy=${JSON.stringify(p.approval)}`, `sandbox_mode=${JSON.stringify(p.sandbox)}`]
    : []
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

const sourceKinds = ['cli', 'vscode', 'appServer']

async function* everyPage(
  rpc: CodexRpc,
  method: string,
  params: Record<string, unknown>
): AsyncGenerator<unknown> {
  let cursor: string | undefined
  const cursors = new Set<string>()
  do {
    const reply = record(await rpc.request(method, { limit: 100, cursor, ...params }))
    if (!Array.isArray(reply.data))
      throw new Error('Codex history returned an unsupported response.')
    yield* reply.data
    cursor = typeof reply.nextCursor === 'string' && reply.nextCursor ? reply.nextCursor : undefined
    if (cursor && cursors.has(cursor)) throw new Error('Codex history repeated a page.')
    if (cursor) cursors.add(cursor)
  } while (cursor)
}

export interface CodexSessionDeps {
  pty: PtyManager
  runtime: SessionRuntime
  projectInfo(p: string): ProjectInfo
  changed(): void
  replaced?(oldKey: string, newKey: string): void
  memberRemoved?(key: string): void
  events(tabId: string, event: SessionEvent): void
  error(message: string): void
  trustFolder(root: string, env: NodeJS.ProcessEnv | undefined): void
  pickHome(): { account: string; home: string } | undefined
  browserEndpoint(tabId: string): string
  openShimRoot: string
  agent: {
    enabled(): boolean
    answer(tabId: string | undefined, dir: string, name: string, raw: unknown): void
  }
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
  transport: CodexTransport
  stopping?: Promise<void>
  explicitStop: boolean
  resumeKey?: string
  account: string
  permission: LaunchPermission
  releaseOpenShim(): void
}

export class CodexSessions {
  private crashLeftoversEnded?: Promise<void>
  private runs = new Map<string, Run>()
  private history = new Map<string, CodexThread>()
  private archivedIds = new Set<string>()
  private binary?: string
  private processEnv?: NodeJS.ProcessEnv
  private probed?: { at: number; reply: CodexAvailability }
  private probing?: Promise<CodexAvailability>
  private updateTried = false
  private warnedVersion?: string
  private refreshing?: Promise<void>
  private historyError?: Error
  private listed = false
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
    this.probing ??= this.probe().finally(() => (this.probing = undefined))
    return this.probing
  }

  private async resolveUpdatingOnce(): Promise<CodexRuntime> {
    let runtime = await resolveCodexRuntime()
    if (!codexTooOld(runtime)) return runtime
    const updating = !this.updateTried
    if (updating) {
      this.updateTried = true
      this.deps.error(
        `Codex ${runtime.version} is older than ${MIN_CODEX_VERSION}, the oldest this Koloft supports. Updating it now…`
      )
      await updateCodex(runtime)
      runtime = await resolveCodexRuntime()
      if (!codexTooOld(runtime)) return runtime
    }
    const stillOld = `Koloft needs Codex CLI ${MIN_CODEX_VERSION} or newer, and this Mac has ${runtime.version}. Run "codex update", then try again.`
    if (updating) this.deps.error(stillOld)
    throw new Error(stillOld)
  }

  private async probe(): Promise<CodexAvailability> {
    let reply: CodexAvailability
    try {
      const runtime = await this.resolveUpdatingOnce()
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
      `Codex ${available.version} is newer than the version Koloft was tested with (${TESTED_CODEX_LINE}.x). It may misbehave.`
    )
  }

  private forgetProbe(): void {
    this.probed = undefined
    this.binary = undefined
    this.processEnv = undefined
  }

  private async startTransport(
    options: Parameters<typeof createCodexTransport>[0]
  ): Promise<CodexTransport> {
    // CODEX§5
    await (this.crashLeftoversEnded ??= endCodexAppServersLeftByACrash(STATUS_LINE_CONFIG).catch(
      () => {}
    ))
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

  private rpc(home: string | undefined): CodexRpc {
    return new CodexRpc({ binary: this.binary!, env: this.envFor(home), cwd: os.homedir() })
  }

  private async withRpc<T>(
    home: string | undefined,
    use: (rpc: CodexRpc) => Promise<T>
  ): Promise<T> {
    if (!this.binary && !(await this.availability()).available)
      throw new Error('Codex CLI is unavailable.')
    const rpc = this.rpc(home)
    try {
      return await use(rpc)
    } catch (error) {
      if (binaryGone(error)) this.forgetProbe()
      throw error
    } finally {
      await rpc.close()
    }
  }

  // CODEX§26
  private async playwrightOverrides(home: string, cwd: string): Promise<string[]> {
    const read = await this.withRpc(home, (rpc) => rpc.request('config/read', { cwd })).catch(
      () => undefined
    )
    return playwrightEnvOverrides(record(record(read).config).mcp_servers)
  }

  // CODEX§15
  async readAccount(home: string): Promise<{ signedIn: boolean; limits?: unknown }> {
    return this.withRpc(home, async (rpc) => {
      const account = record(await rpc.request('account/read', {}))
      if (!account.account) return { signedIn: false }
      return { signedIn: true, limits: await rpc.request('account/rateLimits/read', {}) }
    })
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
      title: t.name || t.preview?.slice(0, 100) || CODEX_PLACEHOLDER_TITLE,
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
    let threads: { key: string; thread: CodexThread; archived: boolean }[]
    try {
      threads = await this.listThreads()
    } catch (error) {
      if (binaryGone(error)) this.forgetProbe()
      this.historyError = error instanceof Error ? error : new Error(String(error))
      return
    }
    const seen = new Map<string, CodexThread>()
    const archivedIds = new Set<string>()
    for (const { key, thread, archived } of threads) {
      seen.set(key, thread)
      if (archived) archivedIds.add(key)
    }
    this.history = seen
    this.archivedIds = archivedIds
    this.listed = true
    this.historyError = undefined
    this.changed()
  }

  // CODEX§15
  private async listThreads(): Promise<{ key: string; thread: CodexThread; archived: boolean }[]> {
    const rpc = this.rpc(undefined)
    const threads: { key: string; thread: CodexThread; archived: boolean }[] = []
    try {
      for (const archived of [false, true]) {
        for await (const value of everyPage(rpc, 'thread/list', { archived, sourceKinds })) {
          const thread = userThread(value)
          if (thread) threads.push({ key: codexSessionKey(thread.id), thread, archived })
        }
      }
      return threads
    } finally {
      await rpc.close()
    }
  }

  searchable(workspaces: string[]): SearchCandidate[] {
    return workspaces.flatMap((workspacePath) =>
      this.rows(workspacePath)
        .filter((row) => !row.pending && !this.archivedIds.has(row.id))
        .map((row) => ({ row: { ...row, ...sourceOf('codex', workspacePath) }, workspacePath }))
    )
  }

  // CODEX§24
  async searchSnippets(term: string): Promise<{ id: string; snippet: string }[]> {
    if (!(await this.availability()).available) return []
    return this.searchSharedHome(term).catch(() => [])
  }

  // CODEX§15
  private searchSharedHome(term: string): Promise<{ id: string; snippet: string }[]> {
    return this.withRpc(undefined, async (rpc) => {
      const found: { id: string; snippet: string }[] = []
      const params = { searchTerm: term, archived: false, sourceKinds }
      for await (const value of everyPage(rpc, 'thread/search', params)) {
        const item = record(value)
        const thread = userThread(item.thread)
        if (thread)
          found.push({
            id: codexSessionKey(thread.id),
            snippet: typeof item.snippet === 'string' ? item.snippet : ''
          })
      }
      return found
    })
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
    return this.withRpc(undefined, async (rpc) => {
      const reply = record(await rpc.request('thread/read', { threadId: id, includeTurns: false }))
      const t = userThread(reply.thread)
      return !!t?.path && fs.existsSync(t.path)
    })
  }

  openApproval(tabId: string): CodexApproval | undefined {
    return this.runs.get(tabId)?.observer.openApproval()
  }

  openQuestion(tabId: string): CodexQuestion | undefined {
    return this.runs.get(tabId)?.observer.openQuestion()
  }

  threadGone(key: string): boolean {
    return this.listed && !this.refreshing && !this.history.has(key) && !this.aliveTabFor(key)
  }

  launchedBypassingChecks(tabId: string): boolean {
    return this.runs.get(tabId)?.permission === 'bypass'
  }

  turnsOf(key: string, n: number): Turn[] | undefined {
    return [...this.runs.values()].find((r) => r.info?.sessionId === key)?.observer.turns.last(n)
  }

  // CODEX§19
  async readTurns(key: string, n: number): Promise<Turn[]> {
    const id = this.nativeId(key)
    return this.withRpc(undefined, async (rpc) => {
      const reply = record(await rpc.request('thread/read', { threadId: id, includeTurns: true }))
      return codexTurns(record(reply.thread).turns).last(n)
    })
  }

  archive(key: string): boolean {
    if (this.aliveTabFor(key)) return false
    const removed = this.removeMember(key)
    this.changed()
    return removed
  }

  private removeMember(key: string): boolean {
    const removed = this.store.removeMember(key)
    if (removed) this.deps.memberRemoved?.(key)
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
    // CODEX§15 ADR-0030
    const picked = this.deps.pickHome()
    if (!picked) throw new Error(NO_USABLE_ACCOUNT.codex)
    const home = picked.home
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
    if (opts.trustFolder) this.deps.trustFolder(cwd, this.envFor(home))
    const tabId = this.deps.pty.nextId()
    const endpoint = this.deps.browserEndpoint(tabId)
    const playwright = endpoint ? await this.playwrightOverrides(home, cwd) : []
    this.assertStarting()
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
    const agent = this.deps.agent.enabled() ? this.deps.agent : undefined
    const openShim = this.startOpenShim(
      processEnv?.ZDOTDIR,
      (target) => observe({ type: 'open', target }),
      agent && ((dir, name, raw) => agent.answer(run?.tabId, dir, name, raw))
    )
    const env = { ...this.envFor(home), ZDOTDIR: openShim.zdotDir }
    const observer = new CodexObservation(observe)
    const instructions = [...(agent ? [CODEX_AGENT_HINT] : []), ...(opts.role ? [opts.role] : [])]
    const permission = opts.permission ?? 'default'
    const permissions = opts.conductor ? CONDUCTOR_PERMISSIONS : PERMISSIONS[permission]
    let transport: CodexTransport | undefined
    try {
      transport = await this.startTransport({
        binary,
        env,
        sessionEnv: {
          ...(resource && { KOLOFT_PORT_OFFSET: String(portOffset(resource.worktreeName)) }),
          ...(playwright.length > 0 && playwrightMcpEnv(endpoint))
        },
        cwd,
        configOverrides: [
          STATUS_LINE_CONFIG,
          ...playwright,
          ...(instructions.length ? [developerInstructions(instructions)] : []),
          ...(opts.resumeSessionId ? permissionConfig(permissions) : [])
        ],
        onFrame: (direction, frame) => observer.receive(direction, frame),
        onDisconnect: () => this.markDegraded(run),
        onError: (error) => {
          this.markDegraded(run)
          this.deps.error(String(error))
        }
      })
      this.assertStarting()
      const argv = [
        '--remote',
        transport.url,
        '-C',
        cwd,
        '-c',
        STATUS_LINE_CONFIG,
        '-c',
        NO_UPDATE_NOTICE_AT_START,
        ...(opts.resumeSessionId ? [] : permissionFlags(permissions)),
        ...launchChoiceArgs(opts)
      ]
      if (opts.resumeSessionId) argv.push('resume', this.nativeId(opts.resumeSessionId))
      else if (opts.firstPrompt) argv.push(opts.firstPrompt)
      const handle = this.deps.pty.create({
        id: tabId,
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
        account: picked.account,
        permission,
        releaseOpenShim: openShim.release
      }
      this.runs.set(handle.id, run)
      this.changed()
      this.warnUntestedVersion(available)
      return { id: handle.id, cwd }
    } catch (error) {
      await transport?.stop()
      openShim.release()
      throw error
    }
  }

  // CODEX§12
  private startOpenShim(
    userZdotdir: string | undefined,
    open: (target: string) => void,
    agent?: (dir: string, name: string, raw: unknown) => void
  ): { zdotDir: string; release(): void } {
    const shim = writeCodexOpenShim(this.deps.openShimRoot, randomUUID(), userZdotdir)
    if (agent) writeCodexAgentShim(shim.shimDir, shim.requestDir)
    const handled = new Set<string>()
    const drops = watchJsonDrops(shim.requestDir, (name) => {
      if (name.startsWith('req-'))
        return agent ? (obj): void => agent(shim.requestDir, name, obj) : null
      if (name.startsWith('res-')) return null
      return (obj, full) => {
        if (handled.has(name)) return
        handled.add(name)
        fs.rm(full, { force: true }, () => {})
        const target = openDropTarget(record(obj) as OpenDrop)
        if (target) open(target)
      }
    })
    return {
      zdotDir: shim.zdotDir,
      release: () => {
        drops?.close()
        removeCodexOpenShim(shim)
      }
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

  // CODEX§17
  async queueMessage(
    tabId: string,
    text: string,
    clientId = `koloft-${randomUUID()}`
  ): Promise<void> {
    const run = this.runs.get(tabId)
    const threadId = run?.info?.nativeSessionId
    if (!run || !threadId) throw new Error('that Codex session has not started yet.')
    run.observer.queuedMessage(clientId)
    try {
      await run.transport.request(
        'thread/queue/add',
        {
          threadId,
          clientUserMessageId: clientId,
          input: [{ type: 'text', text, text_elements: [] }]
        },
        QUEUE_ANSWER_INSIDE_THE_KOLOFT_WAIT_MS
      )
    } catch (error) {
      run.observer.queueRefused(clientId)
      throw error
    }
  }

  queueDrained(tabId: string): boolean {
    return this.runs.get(tabId)?.observer.queueDrained() ?? true
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
        title: thread.name || thread.preview?.slice(0, 100) || m?.title || CODEX_PLACEHOLDER_TITLE,
        createdAt: m?.createdAt ?? (thread.createdAt ? thread.createdAt * 1000 : now),
        updatedAt: now,
        worktreeResourceId: run.resource?.id,
        ...(run.permission !== 'default' ? { permission: run.permission } : {})
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
    this.deps.runtime.forget(run.tabId)
    run.info = {
      tabId: run.tabId,
      sessionId: key,
      nativeSessionId: thread.id,
      title: this.store.getMember(key)?.title ?? CODEX_PLACEHOLDER_TITLE,
      cwd: run.cwd,
      treeRoot: run.cwd,
      worktree: run.resource?.worktreeName,
      alive: true,
      details: { codex: { observation: 'live' } },
      cliVersion: thread.cliVersion,
      pickedAccount: run.account,
      updatedAt: now
    }
    this.history.set(key, { ...thread, cwd: run.cwd })
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
      {
        kind: 'codex',
        cwd,
        resumeSessionId: req.sessionId,
        cols: req.cols,
        rows: req.rows,
        role: req.role,
        conductor: req.conductor,
        permission: m?.permission,
        trustFolder: req.trustFolder
      },
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
        run.releaseOpenShim()
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
