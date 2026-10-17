import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import type {
  CreateTabOptions,
  HostId,
  LaunchPermission,
  ProjectInfo,
  BackendSessionInfo,
  SessionResumeRequest,
  BackendSessionRow,
  CodexResetOutcome
} from '@shared/types'
import { CODEX_PLACEHOLDER_TITLE, CODEX_RESET_OUTCOMES } from '@shared/types'
import { identityOf, sourceOf } from '@shared/sessionBackend'
import {
  barePath,
  formatRemoteKey,
  isAbsoluteOnHost,
  keyedOn,
  parseRemoteKey,
  type RemoteKey
} from '@shared/remoteKey'
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
import {
  CodexRpc,
  createCodexTransport,
  DEFAULT_MAX_FRAME,
  type CodexProcessOptions,
  type CodexTransport
} from './codexTransport'
import {
  codexLaunchLine,
  codexTabScript,
  HAS_CODEX_HOME_CMD,
  machineAppServerCmd,
  MachineCodexUpstream,
  proxyCmd,
  realDirAndConfigCmd,
  stopCodexServerCmd,
  sweepCodexServersCmd,
  type CodexTabSpec,
  type LoginParams,
  type MachineLogin,
  type MachineUpstreamOptions
} from './remote/codexMachine'
import type { MachinePackage } from './remote/launch'
import { problemOf, sshLinkBroke, type RunResult } from './remote/ssh'
import {
  allowsTheBrowser,
  ASSIST_ALLOW_ENV,
  CODEX_GATE_ENV,
  CODEX_GATE_HOOK_COMMAND,
  CODEX_GATE_NOT_TRUSTED,
  codexHookOverride,
  CODEX_ASKS_AND_WAITS
} from './conductorGate'
import {
  CODEX_REPLY_LANGUAGE_ENV,
  CODEX_REPLY_LANGUAGE_HOOKS,
  CODEX_SAID_ENV,
  seedCodexOwnerWords
} from './hooks'
import { ownerWordsIn } from './handover'
import { acceptCodexHookTrust, codexConfigFile, codexHookTrusted, configTrusts } from './codexTrust'
import {
  CODEX_OPEN_SHIM_FOLDER,
  CODEX_TMP_DIR,
  CODEX_TMP_FOLDER,
  endCodexAppServersLeftByACrash,
  ownedByThisRun,
  removeFoldersLeftByEndedRuns
} from './leftovers'
import {
  SessionStore,
  codexSessionKey,
  machineOfCodexKey,
  type WorktreeResource
} from './sessionStore'
import { LOCAL_TREE_OPS, SessionWorktrees, type TreeOps } from './sessionWorktrees'
import type { PtyManager } from './ptyManager'
import { codexTooOld, resolveCodexRuntime, updateCodex, type CodexRuntime } from './codexRuntime'
import { MIN_CODEX_VERSION, TESTED_CODEX_LINE } from './cliMinimums'
import { occupantName, worktreeAround } from './resumePlan'
import { turnOf, type SessionRuntime, type StatusEdge } from './sessionRuntime'
import { watchJsonDrops } from './jsonDrops'
import { openDropTarget, type OpenDrop } from './openDrop'
import { removeCodexOpenShim, writeCodexOpenShim } from './openShimScript'
import { AGENT_SHIM_WAITS_MS, writeCodexAgentShim } from './agentShim'
import { pathWithDirFirst, pathWithDirLast } from './toolInstall'
import { koloftPrompt } from '@shared/agentGuide'
import { playwrightCliSession } from '@shared/browserTabEnv'
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

const missingHere = (p: string): boolean => !parseRemoteKey(p) && !exists(p)

const samePlace = (a: string, b: string): boolean =>
  parseRemoteKey(a) || parseRemoteKey(b) ? a === b : path.resolve(a) === path.resolve(b)

function machineProjectInfo(cwd: string, machine: string): ProjectInfo {
  const tree = worktreeAround(barePath(cwd))
  if (!tree) return { root: cwd, treeRoot: cwd }
  return {
    root: formatRemoteKey(machine, tree.root),
    treeRoot: formatRemoteKey(machine, tree.treeRoot),
    worktreeName: tree.name
  }
}

const MACHINE_HISTORY_FRESH_MS = 15_000

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

// PLATFORM§17
const browserControlEnv = (tabId: string, endpoint: string): Record<string, string> => ({
  PLAYWRIGHT_CLI_SESSION: playwrightCliSession(tabId),
  ...(endpoint && { ...playwrightMcpEnv(endpoint), KOLOFT_BROWSER_CDP: endpoint })
})

const stringList = (raw: unknown): string[] =>
  (Array.isArray(raw) ? raw : []).filter((v): v is string => typeof v === 'string')

const mergedList = (own: unknown, ours: string[]): string =>
  JSON.stringify([...new Set([...stringList(own), ...ours])])

// CODEX§26
function browserSandboxOverrides(sandbox: unknown, cacheDir: string): string[] {
  return [
    'sandbox_workspace_write.network_access=true',
    `sandbox_workspace_write.writable_roots=${mergedList(record(sandbox).writable_roots, [cacheDir])}`
  ]
}

const runsPlaywrightMcp = (word: string): boolean =>
  word.includes('@playwright/mcp') || path.basename(word) === 'playwright-mcp'

const KEY_THE_CODEX_FLAG_PARSER_TAKES = /^[A-Za-z0-9_-]+$/

// CODEX§26
export function playwrightEnvOverrides(mcpServers: unknown, approveTools = false): string[] {
  return Object.entries(record(mcpServers)).flatMap(([name, raw]) => {
    const entry = record(raw)
    const words = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])]
    if (!KEY_THE_CODEX_FLAG_PARSER_TAKES.test(name)) return []
    if (!words.some((w) => typeof w === 'string' && runsPlaywrightMcp(w))) return []
    return [
      `mcp_servers.${name}.env_vars=${mergedList(entry.env_vars, Object.keys(playwrightMcpEnv('')))}`,
      // CODEX§26
      ...(approveTools ? [`mcp_servers.${name}.default_tools_approval_mode="approve"`] : [])
    ]
  })
}

interface ListedHook {
  key: string
  command: string
  currentHash: string
  trustStatus: string
}

const ASSIST_MEMORY = `# Assist memory

This file is your memory folder. When the owner asks you to remember something, add it here as one short line. Keep everything already here.
`

// CODEX§17
function seedAssistMemory(folder: string): void {
  try {
    fs.writeFileSync(path.join(folder, 'AGENTS.md'), ASSIST_MEMORY, { flag: 'wx' })
  } catch {}
}

interface KoloftHook {
  event: string
  command: string
}

const GATE_HOOK: KoloftHook = { event: 'PreToolUse', command: CODEX_GATE_HOOK_COMMAND }

const hookOverrides = (hooks: KoloftHook[]): string[] =>
  hooks.map(({ event, command }) => codexHookOverride(event, command))

// CODEX§27
function koloftHooksIn(reply: unknown, wanted: KoloftHook[]): ListedHook[] {
  const found: ListedHook[] = []
  const lists = record(reply).data
  for (const list of Array.isArray(lists) ? lists : []) {
    const hooks = record(list).hooks
    for (const raw of Array.isArray(hooks) ? hooks : []) {
      const hook = record(raw)
      if (
        hook.source === 'sessionFlags' &&
        wanted.some(
          (w) =>
            w.command === hook.command &&
            w.event.toLowerCase() === String(hook.eventName).toLowerCase()
        ) &&
        typeof hook.key === 'string' &&
        typeof hook.currentHash === 'string'
      )
        found.push({
          key: hook.key,
          command: String(hook.command),
          currentHash: hook.currentHash,
          trustStatus: String(hook.trustStatus)
        })
    }
  }
  return found
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

// CODEX§11 CODEX§16
const MACHINE_TRUSTED_FOLDER_DEFAULT: Permissions = {
  approval: 'on-request',
  sandbox: 'workspace-write'
}

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

interface ListedThread {
  thread: CodexThread
  archived: boolean
}

// CODEX§15
async function listThreads(rpc: CodexRpc): Promise<ListedThread[]> {
  const threads: ListedThread[] = []
  for (const archived of [false, true]) {
    for await (const value of everyPage(rpc, 'thread/list', { archived, sourceKinds })) {
      const thread = userThread(value)
      if (thread) threads.push({ thread, archived })
    }
  }
  return threads
}

export interface CodexMachineHost {
  dirExists(p: string): Promise<boolean>
  fileExists(p: string): Promise<boolean>
  treeOps: TreeOps
}

export interface CodexMachineDeps {
  instance: string
  ready(): Promise<void>
  run(machine: string, cmd: string): Promise<RunResult>
  sshArgs(background: boolean): string[]
  machinePackage(): MachinePackage
  tabDir(tabId: string): string
  host(machine: string): CodexMachineHost
}

export interface CodexSessionDeps {
  machine?: CodexMachineDeps
  pty: PtyManager
  runtime: SessionRuntime
  projectInfo(p: string): ProjectInfo
  changed(): void
  replaced?(oldKey: string, newKey: string): void
  memberRemoved?(key: string): void
  leftWorktree?(resource: WorktreeResource): Promise<void>
  events(tabId: string, event: SessionEvent): void
  error(message: string): void
  trustFolder(root: string, env: NodeJS.ProcessEnv | undefined): void
  pickHome(resumeSessionId?: string): { account: string; home: string; notice?: string } | undefined
  assistOf(cwd: string, resumeKey?: string): { role: string; allow: string[] } | undefined
  conductorGate: { script: string; writeAllow(tabId: string, allow: string[]): string }
  replyLanguageScript: string
  browserEndpoint(tabId: string): string
  openShimRoot: string
  playwrightBin: string
  fallbackBin?: string
  gitBin?: string
  agent: {
    enabled(host: HostId): boolean
    answer(tabId: string | undefined, dir: string, name: string, raw: unknown): void
  }
  gitAccounts: {
    configEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
    picked(cwd: string): Promise<boolean>
    ghWrapper: string
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
  machine?: string
  releaseOpenShim(): void
}

export class CodexSessions {
  private crashLeftoversEnded?: Promise<void>
  private runs = new Map<string, Run>()
  private listedHooks = new Map<string, ListedHook>()
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
  private relaunchingKeys = new Set<string>()
  private pendingLaunches = new Set<Promise<{ id: string; cwd: string }>>()
  private shuttingDown = false
  private emitTimer?: ReturnType<typeof setTimeout>
  private lastEmitMs = 0
  private machineHistory = new Map<
    string,
    { at: number; reading?: Promise<void>; error?: unknown }
  >()
  private machinesSwept = new Map<string, Promise<void>>()
  readonly store: SessionStore
  readonly worktrees: SessionWorktrees

  constructor(
    file: string,
    private deps: CodexSessionDeps
  ) {
    this.store = new SessionStore(file)
    this.worktrees = new SessionWorktrees(this.store, (p) => {
      const machine = parseRemoteKey(p)?.host
      return machine ? this.machineDeps().host(machine).treeOps : LOCAL_TREE_OPS
    })
    deps.runtime.on('status', ({ tabId, next }: StatusEdge) => {
      const run = this.runs.get(tabId)
      if (!run?.info || run.explicitStop || run.stopping) return
      run.info.status = next
      run.info.updatedAt = Date.now()
      this.changedSoon()
    })
  }

  private machineDeps(): CodexMachineDeps {
    if (!this.deps.machine) throw new Error('Codex cannot reach remote machines here.')
    return this.deps.machine
  }

  private infoOf(cwd: string): ProjectInfo {
    const machine = parseRemoteKey(cwd)?.host
    return machine ? machineProjectInfo(cwd, machine) : this.deps.projectInfo(cwd)
  }

  private async dirThere(p: string): Promise<boolean> {
    const machine = parseRemoteKey(p)?.host
    return machine ? this.machineDeps().host(machine).dirExists(p) : exists(p)
  }

  machineOfTab(tabId: string): string | undefined {
    return this.runs.get(tabId)?.machine
  }

  machinesWithTabs(): string[] {
    return [...this.runs.values()].flatMap((r) => (r.machine ? [r.machine] : []))
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
      this.processEnv = this.withShippedTools(runtime.env)
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

  forgetAvailability(): void {
    this.probed = undefined
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
    await (this.crashLeftoversEnded ??= endCodexAppServersLeftByACrash(STATUS_LINE_CONFIG)
      .catch(() => {})
      .then(() => {
        removeFoldersLeftByEndedRuns(CODEX_TMP_DIR, CODEX_TMP_FOLDER)
        removeFoldersLeftByEndedRuns(this.deps.openShimRoot, CODEX_OPEN_SHIM_FOLDER)
      }))
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

  private withShippedTools(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const { fallbackBin, gitBin } = this.deps
    let pathVar = env.PATH
    if (fallbackBin) pathVar = pathWithDirLast(pathVar, fallbackBin)
    if (gitBin) pathVar = pathWithDirFirst(pathVar, gitBin)
    // ADR-0033
    return this.deps.gitAccounts.configEnv({ ...env, PATH: pathVar })
  }

  // ADR-0029 CODEX§27
  private async trustKoloftHooks(
    launch: CodexProcessOptions,
    configFile: string,
    wanted: KoloftHook[]
  ): Promise<Set<string>> {
    const onDisk = wanted.filter((w) => {
      const hook = this.listedHooks.get(w.command)
      return !!hook && codexHookTrusted(configFile, hook.key, hook.currentHash)
    })
    if (onDisk.length === wanted.length) return new Set(wanted.map((w) => w.command))
    return this.askHookTrust(
      { ...launch, configOverrides: [...(launch.configOverrides ?? []), ...hookOverrides(wanted)] },
      configFile,
      wanted
    )
  }

  // ADR-0038 CODEX§27
  private async koloftHookStates(wanted: KoloftHook[]): Promise<ListedHook[]> {
    const known = wanted.flatMap((w) => this.listedHooks.get(w.command) ?? [])
    if (known.length === wanted.length) return known
    const rpc = new CodexRpc({
      binary: this.binary!,
      env: this.processEnv,
      cwd: os.homedir(),
      configOverrides: hookOverrides(wanted)
    })
    try {
      const reply = await rpc.request('hooks/list', { cwds: [os.homedir()] }).catch(() => undefined)
      const hooks = koloftHooksIn(reply, wanted)
      for (const hook of hooks) this.listedHooks.set(hook.command, hook)
      return hooks
    } finally {
      await rpc.close().catch(() => {})
    }
  }

  // CODEX§27
  private async askHookTrust(
    launch: CodexProcessOptions,
    configFile: string,
    wanted: KoloftHook[]
  ): Promise<Set<string>> {
    const rpc = new CodexRpc(launch)
    try {
      const listed = async (): Promise<ListedHook[]> => {
        const hooks = koloftHooksIn(
          await rpc.request('hooks/list', { cwds: [launch.cwd] }).catch(() => undefined),
          wanted
        )
        for (const hook of hooks) this.listedHooks.set(hook.command, hook)
        return hooks
      }
      const first = await listed()
      const untrusted = first.filter((h) => h.trustStatus !== 'trusted')
      for (const h of untrusted)
        try {
          acceptCodexHookTrust(configFile, h.key, h.currentHash)
        } catch {}
      const now = untrusted.length ? await listed() : first
      return new Set(now.filter((h) => h.trustStatus === 'trusted').map((h) => h.command))
    } finally {
      await rpc.close().catch(() => {})
    }
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

  // CODEX§16
  private async withMachineRpc<T>(machine: string, use: (rpc: CodexRpc) => Promise<T>): Promise<T> {
    const m = this.machineDeps()
    await m.ready()
    const rpc = new CodexRpc({
      binary: 'ssh',
      args: [...m.sshArgs(true), machine, machineAppServerCmd()],
      cwd: os.homedir()
    })
    try {
      return await use(rpc)
    } finally {
      await rpc.close()
    }
  }

  private withRpcFor<T>(key: string, use: (rpc: CodexRpc) => Promise<T>): Promise<T> {
    const machine = machineOfCodexKey(key)
    return machine ? this.withMachineRpc(machine, use) : this.withRpc(undefined, use)
  }

  // ADR-0038 CODEX§16
  private machineLogin(home: string): MachineLogin {
    const read = (): LoginParams | undefined => {
      let auth: Record<string, unknown>
      try {
        auth = record(JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')))
      } catch {
        return undefined
      }
      const tokens = record(auth.tokens)
      if (typeof tokens.access_token === 'string' && typeof tokens.account_id === 'string')
        return {
          type: 'chatgptAuthTokens',
          accessToken: tokens.access_token,
          chatgptAccountId: tokens.account_id,
          chatgptPlanType: null
        }
      return typeof auth.OPENAI_API_KEY === 'string'
        ? { type: 'apiKey', apiKey: auth.OPENAI_API_KEY }
        : undefined
    }
    return {
      params: async () => read(),
      refreshed: async (stale) => {
        let now = read()
        if (!now?.accessToken || now.accessToken === stale) {
          await this.withRpc(home, (rpc) => rpc.request('account/read', { refreshToken: true }))
          now = read()
        }
        if (!now?.accessToken || now.accessToken === stale)
          throw new Error('The Codex account on this Mac could not renew its sign-in.')
        return {
          accessToken: now.accessToken,
          chatgptAccountId: now.chatgptAccountId,
          chatgptPlanType: now.chatgptPlanType
        }
      }
    }
  }

  // CODEX§26
  private async browserOverrides(home: string, cwd: string, conductor: boolean): Promise<string[]> {
    const readConfig = (): Promise<unknown> =>
      this.withRpc(home, (rpc) => rpc.request('config/read', { cwd }))
    // CODEX§28
    const read = await readConfig()
      .catch(readConfig)
      .catch(() => undefined)
    if (!read) return []
    const config = record(record(read).config)
    const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
    fs.mkdirSync(cacheDir, { recursive: true })
    return [
      ...playwrightEnvOverrides(config.mcp_servers, conductor),
      ...browserSandboxOverrides(config.sandbox_workspace_write, cacheDir)
    ]
  }

  // CODEX§15
  async readAccount(home: string): Promise<{ signedIn: boolean; limits?: unknown }> {
    return this.withRpc(home, async (rpc) => {
      const account = record(await rpc.request('account/read', {}))
      if (!account.account) return { signedIn: false }
      return { signedIn: true, limits: await rpc.request('account/rateLimits/read', {}) }
    })
  }

  // CODEX§15
  async useResetCredit(home: string): Promise<CodexResetOutcome> {
    const done = record(
      await this.withRpc(home, (rpc) =>
        rpc.request('account/rateLimitResetCredit/consume', { idempotencyKey: randomUUID() })
      )
    )
    return CODEX_RESET_OUTCOMES.find((o) => o === done.outcome) ?? 'failed'
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
  private readsRunning(key: string): boolean {
    return !!this.aliveTabFor(key) || this.relaunchingKeys.has(key)
  }
  occupantOf(dir: string): string | null {
    for (const run of this.runs.values()) {
      const info = run.info
      if (!info) {
        if (samePlace(run.cwd, dir)) return 'a starting Codex session'
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
        invalidCwd: missingHere(m.cwd),
        mtime: m.updatedAt
      }
      r.cwd = m.cwd
      r.invalidCwd = missingHere(m.cwd)
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

  private row(t: CodexThread, scope: RowScope): BackendSessionRow {
    const key = codexSessionKey(t.id, parseRemoteKey(t.cwd)?.host)
    const resource = scope.byPath.get(t.cwd)
    return {
      id: key,
      nativeSessionId: t.id,
      createdAt: (t.createdAt ?? 0) * 1000,
      title: t.name || t.preview?.slice(0, 100) || CODEX_PLACEHOLDER_TITLE,
      cwd: t.cwd,
      worktree: resource?.worktreeName ?? this.infoOf(t.cwd).worktreeName ?? 'main',
      running: this.readsRunning(key),
      invalidCwd: missingHere(t.cwd),
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
    const root = this.infoOf(cwd).root
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
    let threads: ListedThread[]
    try {
      const rpc = this.rpc(undefined)
      threads = await listThreads(rpc).finally(() => rpc.close())
    } catch (error) {
      if (binaryGone(error)) this.forgetProbe()
      this.historyError = error instanceof Error ? error : new Error(String(error))
      return
    }
    this.replaceHistory(undefined, threads)
    this.listed = true
    this.historyError = undefined
    this.changed()
  }

  private replaceHistory(machine: string | undefined, threads: ListedThread[]): void {
    const others = (key: string): boolean => machineOfCodexKey(key) !== machine
    this.history = new Map([...this.history].filter(([key]) => others(key)))
    this.archivedIds = new Set([...this.archivedIds].filter(others))
    for (const { thread, archived } of threads) {
      const key = codexSessionKey(thread.id, machine)
      this.history.set(
        key,
        machine ? { ...thread, cwd: formatRemoteKey(machine, thread.cwd) } : thread
      )
      if (archived) this.archivedIds.add(key)
    }
  }

  // CODEX§16
  async refreshMachineHistory(machine: string, force = false): Promise<void> {
    const state = this.machineHistory.get(machine) ?? { at: 0 }
    this.machineHistory.set(machine, state)
    if (state.reading) return state.reading
    if (!force && Date.now() - state.at < MACHINE_HISTORY_FRESH_MS) {
      if (state.error) throw state.error
      return
    }
    state.reading = this.readMachineHistory(machine)
      .then(
        () => {
          state.error = undefined
        },
        (error: unknown) => {
          state.error = error
          throw error
        }
      )
      .finally(() => {
        state.reading = undefined
        state.at = Date.now()
      })
    return state.reading
  }

  private async readMachineHistory(machine: string): Promise<void> {
    const home = await this.machineDeps().run(machine, HAS_CODEX_HOME_CMD)
    if (sshLinkBroke(home)) throw new Error(problemOf(home))
    const threads =
      home.code === 0 ? await this.withMachineRpc(machine, (rpc) => listThreads(rpc)) : []
    if (this.shuttingDown) return
    this.replaceHistory(machine, threads)
    this.changed()
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
    const machine = parseRemoteKey(workspace)?.host
    if (machine) await this.refreshMachineHistory(machine)
    else {
      await this.refreshHistory()
      if (this.historyError) throw this.historyError
    }
    return this.rows(workspace).filter(
      (r) => !r.running && !this.members().has(r.id) && !this.archivedIds.has(r.id)
    )
  }

  async transcriptExists(key: string): Promise<boolean> {
    const id = this.nativeId(key)
    if (this.archivedIds.has(key)) return false
    const machine = machineOfCodexKey(key)
    const file = await this.withRpcFor(key, async (rpc) => {
      const reply = record(await rpc.request('thread/read', { threadId: id, includeTurns: false }))
      return userThread(reply.thread)?.path
    })
    if (!file) return false
    return machine
      ? this.machineDeps().host(machine).fileExists(formatRemoteKey(machine, file))
      : fs.existsSync(file)
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
    return this.withRpcFor(key, async (rpc) => {
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
      codexSessionKey(identity.nativeSessionId, machineOfCodexKey(key)) !== key
    ) {
      throw new Error('A Codex session is required.')
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
    if (typeof cwd !== 'string' || !isAbsoluteOnHost(cwd) || !(await this.dirThere(cwd)))
      throw new Error('The session folder is missing.')
    const machine = parseRemoteKey(cwd)?.host
    const workspace = this.workspaceFor(cwd)
    if (opts.resumeSessionId && this.aliveTabFor(opts.resumeSessionId))
      throw new Error('This Codex session is already open.')
    // CODEX§15 ADR-0030
    const picked = this.deps.pickHome(opts.resumeSessionId)
    if (!picked) throw new Error(NO_USABLE_ACCOUNT.codex)
    if (picked.notice) this.deps.error(picked.notice)
    const home = picked.home
    const trustedOnMachine: string[] = []
    const trust = (dir: string, env: NodeJS.ProcessEnv | undefined): void => {
      if (machine) trustedOnMachine.push(barePath(dir))
      else this.deps.trustFolder(dir, env)
    }
    if (opts.worktreeResourceId) {
      const saved = this.store.getResource(opts.worktreeResourceId)
      if (!saved || saved.originalCwd !== workspace || opts.worktree || opts.resumeSessionId)
        throw new Error('Invalid worktree recovery request.')
      resource = await this.worktrees.rebuild(saved.id)
      cwd = resource.worktreePath
    } else if (opts.worktree) {
      resource = await this.worktrees.create(workspace, opts.worktree)
      cwd = resource.worktreePath
      // ADR-0026 CODEX§11
      if (!opts.scheduled) for (const dir of [workspace, cwd]) trust(dir, processEnv)
    } else if (!resource && this.infoOf(cwd).worktreeName) {
      resource = await this.worktrees.adopt(workspace, this.infoOf(cwd).treeRoot)
    }
    this.assertStarting()
    // ADR-0029
    const assist = machine ? undefined : this.deps.assistOf(cwd, opts.resumeSessionId)
    const conductor = !machine && (opts.conductor || !!assist)
    const role = opts.role ?? assist?.role
    const allow = opts.allow ?? assist?.allow ?? []
    if (opts.trustFolder || assist) trust(cwd, this.envFor(home))
    if (conductor && (opts.trustFolder || assist)) seedAssistMemory(cwd)
    const tabId = this.deps.pty.nextId()
    // ADR-0029
    const endpoint =
      machine || (conductor && !allowsTheBrowser(allow)) ? '' : this.deps.browserEndpoint(tabId)
    const browser = endpoint ? await this.browserOverrides(home, cwd, conductor) : []
    // CODEX§29
    const gitNetwork = (await this.deps.gitAccounts.picked(cwd))
      ? ['sandbox_workspace_write.network_access=true']
      : []
    this.assertStarting()
    let run: Run | undefined
    const observe = (event: CodexEvent): void => {
      if (event.type !== 'bound') {
        if (machine && event.type === 'open') return
        if (run) this.deps.events(run.tabId, event)
        else if (event.type === 'degraded') this.deps.error(event.message)
        return
      }
      if (run && !run.explicitStop && !run.stopping)
        this.bindThread(run, event.thread, event.change)
    }
    const agent = this.deps.agent.enabled(machine ? 'ssh' : 'local') ? this.deps.agent : undefined
    const openShim = machine
      ? undefined
      : this.startOpenShim(
          processEnv?.ZDOTDIR,
          (target) => observe({ type: 'open', target }),
          agent && ((dir, name, raw) => agent.answer(run?.tabId, dir, name, raw))
        )
    const env = openShim ? { ...this.envFor(home), ZDOTDIR: openShim.zdotDir } : this.envFor(home)
    const ownerWords = role && opts.firstPrompt ? ownerWordsIn(role) : undefined
    const said = openShim && path.join(openShim.shimDir, 'said')
    if (said && ownerWords) seedCodexOwnerWords(said, ownerWords)
    const observer = new CodexObservation(observe)
    const instructions = [
      ...(agent && !conductor ? [koloftPrompt('codex')] : []),
      ...(role ? [role] : [])
    ]
    const permission = opts.permission ?? 'default'
    const permissions = conductor ? CONDUCTOR_PERMISSIONS : PERMISSIONS[permission]
    const processOptions: CodexProcessOptions = {
      binary,
      env,
      sessionEnv: {
        ...(resource && { KOLOFT_PORT_OFFSET: String(portOffset(resource.worktreeName)) }),
        ...(machine ? { KOLOFT_TAB_ID: tabId } : browserControlEnv(tabId, endpoint)),
        ...(conductor && {
          [CODEX_GATE_ENV]: this.deps.conductorGate.script,
          [ASSIST_ALLOW_ENV]: this.deps.conductorGate.writeAllow(tabId, allow)
        }),
        ...(said && {
          [CODEX_REPLY_LANGUAGE_ENV]: this.deps.replyLanguageScript,
          [CODEX_SAID_ENV]: said
        })
      },
      cwd,
      configOverrides: [
        STATUS_LINE_CONFIG,
        ...browser,
        ...gitNetwork,
        ...(instructions.length ? [developerInstructions(instructions)] : []),
        ...(opts.resumeSessionId ? permissionConfig(permissions) : []),
        CODEX_ASKS_AND_WAITS
      ]
    }
    const hooks = [...(conductor ? [GATE_HOOK] : []), ...CODEX_REPLY_LANGUAGE_HOOKS]
    let transport: CodexTransport | undefined
    try {
      const askMachineTrust = !!machine && !permissions && !opts.resumeSessionId
      const [hookTrust, , trustedThere] = machine
        ? await Promise.all([
            this.koloftHookStates(hooks),
            this.machineReady(machine),
            askMachineTrust &&
              (trustedOnMachine.includes(barePath(cwd)) || this.machineTrusts(parseRemoteKey(cwd)!))
          ])
        : [[], undefined, false]
      // CODEX§16
      const launchPermissions = trustedThere ? MACHINE_TRUSTED_FOLDER_DEFAULT : permissions
      // ADR-0029 ADR-0031
      const trusted = machine
        ? new Set(hookTrust.map((h) => h.command))
        : await this.trustKoloftHooks(processOptions, codexConfigFile(this.envFor(home)), hooks)
      if (conductor && !trusted.has(GATE_HOOK.command)) throw new Error(CODEX_GATE_NOT_TRUSTED)
      this.assertStarting()
      const serverConfig = [
        ...processOptions.configOverrides!,
        ...hookOverrides(hooks.filter((h) => trusted.has(h.command)))
      ]
      const launchedIn = cwd
      transport = await this.startTransport({
        ...processOptions,
        ...(machine && {
          upstream: (frame, failure) =>
            new MachineCodexUpstream(
              this.machineUpstream(machine, tabId, home, () => run?.cwd ?? launchedIn),
              frame,
              failure
            )
        }),
        configOverrides: serverConfig,
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
        barePath(cwd),
        '-c',
        STATUS_LINE_CONFIG,
        '-c',
        NO_UPDATE_NOTICE_AT_START,
        ...(opts.resumeSessionId ? [] : permissionFlags(launchPermissions)),
        ...launchChoiceArgs(opts)
      ]
      if (opts.resumeSessionId) argv.push('resume', this.nativeId(opts.resumeSessionId))
      else if (opts.firstPrompt) argv.push(opts.firstPrompt)
      const launch = machine
        ? {
            cwd: os.homedir(),
            executable: '/bin/sh',
            argv: [
              '-c',
              this.machineLaunchLine(machine, tabId, [binary, ...argv], {
                version: available.version ?? '',
                cwd: barePath(cwd),
                trust: trustedOnMachine,
                env: processOptions.sessionEnv ?? {},
                config: serverConfig,
                hookTrust: hookTrust.map((h) => ({ key: h.key, hash: h.currentHash })),
                ownerWords,
                agentTools: !!agent
              })
            ]
          }
        : { cwd, executable: binary, argv }
      const handle = this.deps.pty.create({
        id: tabId,
        kind: 'codex',
        ...launch,
        cols: opts.cols,
        rows: opts.rows,
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
        machine,
        releaseOpenShim: openShim?.release ?? ((): void => {})
      }
      this.runs.set(handle.id, run)
      this.changed()
      this.warnUntestedVersion(available)
      return { id: handle.id, cwd }
    } catch (error) {
      await transport?.stop()
      openShim?.release()
      if (machine) fs.rmSync(this.machineDeps().tabDir(tabId), { recursive: true, force: true })
      const allowFile = processOptions.sessionEnv?.[ASSIST_ALLOW_ENV]
      if (allowFile) fs.rmSync(allowFile, { force: true })
      throw error
    }
  }

  // CODEX§11
  async machineTrusts(dir: RemoteKey): Promise<boolean> {
    const r = await this.machineDeps().run(dir.host, realDirAndConfigCmd(dir.path))
    if (r.code !== 0) return false
    const newline = r.stdout.indexOf('\n')
    return configTrusts(r.stdout.slice(newline + 1), r.stdout.slice(0, newline).trim())
  }

  // ADR-0038
  private machineReady(machine: string): Promise<void> {
    const m = this.machineDeps()
    let swept = this.machinesSwept.get(machine)
    if (!swept) {
      swept = m.run(machine, sweepCodexServersCmd(m.instance)).then(
        () => {},
        () => {}
      )
      this.machinesSwept.set(machine, swept)
    }
    return swept
  }

  // ADR-0038 CODEX§16
  private machineUpstream(
    machine: string,
    tabId: string,
    home: string,
    cwdNow: () => string
  ): MachineUpstreamOptions {
    const m = this.machineDeps()
    return {
      connect: () =>
        spawn('ssh', [...m.sshArgs(true), machine, proxyCmd(m.instance, tabId)], { stdio: 'pipe' }),
      login: this.machineLogin(home),
      macCwd: os.homedir(),
      machineCwd: () => barePath(cwdNow()),
      stopServer: async () => {
        await m.run(machine, stopCodexServerCmd(m.instance, tabId))
      },
      maxFrameBytes: DEFAULT_MAX_FRAME,
      report: (error) => this.deps.error(String(error))
    }
  }

  private machineLaunchLine(
    machine: string,
    tabId: string,
    tui: string[],
    spec: Omit<CodexTabSpec, 'tabId' | 'instance' | 'machineName'>
  ): string {
    const m = this.machineDeps()
    const pkg = m.machinePackage()
    const tabDir = m.tabDir(tabId)
    fs.mkdirSync(tabDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      path.join(tabDir, `${tabId}.sh`),
      codexTabScript({ ...spec, tabId, instance: m.instance, machineName: pkg.name }),
      { mode: 0o700 }
    )
    return codexLaunchLine({
      host: machine,
      sshOptions: m.sshArgs(false),
      machine: pkg,
      tabDir,
      tabId,
      tui
    })
  }

  // CODEX§12
  private startOpenShim(
    userZdotdir: string | undefined,
    open: (target: string) => void,
    agent?: (dir: string, name: string, raw: unknown) => void
  ): { shimDir: string; zdotDir: string; release(): void } {
    const shim = writeCodexOpenShim(
      this.deps.openShimRoot,
      ownedByThisRun(randomUUID()),
      userZdotdir
    )
    fs.symlinkSync(
      path.join(this.deps.playwrightBin, 'playwright-cli'),
      path.join(shim.shimDir, 'playwright-cli')
    )
    // PLATFORM§2
    if (this.deps.gitBin)
      fs.symlinkSync(path.join(this.deps.gitBin, 'git'), path.join(shim.shimDir, 'git'))
    fs.symlinkSync(this.deps.gitAccounts.ghWrapper, path.join(shim.shimDir, 'gh'))
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
      shimDir: shim.shimDir,
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
      case 'files-changed': {
        const at = (p: string | undefined): string | undefined => keyedOn(run.machine, p)
        info.files = event.files.map((f) => ({ ...f, src: at(f.src) ?? f.src }))
        info.lastTouched = at(event.lastTouched)
        info.lastWritten = at(event.lastWritten)
        info.liveWrites = event.liveWrites
        return this.changedSoon()
      }
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
    const key = codexSessionKey(thread.id, run.machine),
      old = run.info?.sessionId
    if (run.info) {
      run.cwd = run.machine ? formatRemoteKey(run.machine, thread.cwd) : thread.cwd
      run.workspace = this.workspaceFor(run.cwd)
      const treeRoot = this.infoOf(run.cwd).treeRoot
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
    const treeRemoved = !req.mode && !!resource && !(await this.dirThere(resource.worktreePath))
    if (req.mode === 'rebuild' || treeRemoved) {
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

  stop(tabId: string, nativeExitCode?: number, restarting = false): Promise<void> {
    const run = this.runs.get(tabId)
    if (!run) return Promise.resolve()
    if (run.stopping) return run.stopping
    const nativeExit = nativeExitCode === 0 && run.observer.unsubscribed && !run.explicitStop
    const unexpectedExit = nativeExitCode !== undefined && nativeExitCode !== 0 && !run.explicitStop
    run.explicitStop = true
    run.stopping = Promise.resolve()
      .then(() => run.transport.stop())
      .then(async () => {
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
        if (!this.shuttingDown && !restarting && run.resource)
          await this.deps.leftWorktree?.(run.resource)
        this.changed()
        if (!this.shuttingDown)
          void (
            run.machine ? this.refreshMachineHistory(run.machine, true) : this.refreshHistory()
          ).catch((error) => this.deps.error(String(error)))
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
