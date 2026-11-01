import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import type {
  BackendSessionInfo,
  BackendSessionRow,
  CreateTabOptions,
  HostId,
  CodexResetOutcome,
  LaunchPermission
} from '@shared/types'
import { CODEX_RESET_OUTCOMES } from '@shared/types'
import { barePath, keyedOn, parseRemoteKey, type RemoteKey } from '@shared/remoteKey'
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
  codexEnvironment,
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
  CODEX_ASKS_AND_WAITS,
  developerInstructions,
  hookOverrides,
  launchChoiceArgs,
  machineTrustedFolderFlags,
  NO_UPDATE_NOTICE_AT_START,
  permissionConfig,
  permissionFlags,
  PERMISSIONS,
  browserSandboxOverrides,
  playwrightEnvOverrides,
  seedAssistMemory,
  STATUS_LINE_CONFIG,
  trustedInPlace,
  type KoloftHook
} from './codexLaunchConfig'
import {
  CODEX_DISCORD_SAID_ENV,
  CODEX_HOLD_REG_ENV,
  CODEX_HOLD_SCRIPT_ENV,
  CODEX_REPLY_LANGUAGE_ENV,
  CODEX_REPLY_LANGUAGE_HOOKS,
  CODEX_SAID_ENV,
  CODEX_SHELL_WRITES_HOOKS,
  CODEX_SHELL_WROTE_ENV,
  codexHoldHook,
  discordSaidFile,
  HOLD_TAB_ENV,
  NOTICE_ENV,
  noticeFile,
  seedHandedOverOwnerWords,
  SHELL_WROTE_FIELD,
  SHELL_WROTE_SUFFIX
} from './hooks'
import { shellWrittenFiles } from './touchedFiles'
import {
  acceptCodexHookTrust,
  codexConfigFile,
  codexHookTrusted,
  configTrusts,
  koloftHooksIn,
  type ListedHook
} from './codexTrust'
import { CodexSideServers } from './codexSideServers'
import { mapAtMost } from './mapAtMost'
import { pipeSecretTo } from './secretOnStdin'
import {
  CODEX_TMP_DIR,
  CODEX_TMP_FOLDER,
  endCodexAppServersLeftByACrash,
  removeFoldersLeftByEndedRuns
} from './leftovers'
import { codexSessionKey } from './sessionStore'
import { resolveCodexRuntime, updateCodex } from './codexRuntime'
import { MIN_CODEX_VERSION, TESTED_CODEX_LINE } from './cliMinimums'
import { startToolShim } from './toolShim'
import { AGENT_SHIM_WAITS_MS } from './agentShim'
import { koloftPrompt } from '@shared/agentGuide'
import { browserControlEnv } from './browserControlEnv'
import { portOffset } from '@shared/worktreeName'
import type { CodexApproval, CodexQuestion } from './discord/dialog'
import {
  StoredSessions,
  hostOfKey,
  type HistoryListing,
  type StartContext,
  type StoredRun,
  type StoredSessionDeps
} from './storedSessions'

const MACHINE_HISTORY_FRESH_MS = 15_000

const QUEUE_ANSWER_INSIDE_THE_KOLOFT_WAIT_MS = AGENT_SHIM_WAITS_MS / 2
const MESSAGE_SHOWN_IN_A_NOTICE_CHARS = 120

export const CODEX_TAB_ENV = {
  koloftShim: false,
  finishEnv: (env: NodeJS.ProcessEnv) => codexEnvironment(env)
} as const

const sourceKinds = ['cli', 'vscode', 'appServer']

// CODEX§15
const rolloutFiles = (listedPath: string): string[] => [listedPath, listedPath + '.zst']
const rolloutOnThisMac = (listedPath: string): boolean =>
  rolloutFiles(listedPath).some((f) => fs.existsSync(f))

// CODEX§12
const IMAGES_FOLDER = 'generated_images'

// CODEX§12
export function machineImagesDir(
  machine: string,
  threadId: string,
  rollout: string | null | undefined
): string | undefined {
  const at = rollout?.lastIndexOf('/sessions/') ?? -1
  return at > 0
    ? keyedOn(machine, `${rollout!.slice(0, at)}/${IMAGES_FOLDER}/${threadId}`)
    : undefined
}

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

const THREADS_CHECKED_AT_ONCE = 8

// CODEX§24
const CODEX_OWN_BLOCK =
  /<\/?(environment_context|cwd|shell|current_date|timezone|INSTRUCTIONS)>|AGENTS\.md instructions for /

// CODEX§24
async function saidInThread(
  rpc: CodexRpc,
  hit: { id: string; snippet: string },
  searchTerm: string
): Promise<string | undefined> {
  const unchecked = CODEX_OWN_BLOCK.test(hit.snippet) ? undefined : hit.snippet
  try {
    const occurrences = record(
      await rpc.request('thread/searchOccurrences', { threadId: hit.id, searchTerm, limit: 1 })
    )
    const first = record(Array.isArray(occurrences.data) ? occurrences.data[0] : undefined)
    if (typeof first.snippet === 'string') return first.snippet
    const turns = record(await rpc.request('thread/turns/list', { threadId: hit.id, limit: 1 }))
    const indexed = Array.isArray(turns.data) && turns.data.length > 0
    return indexed ? undefined : unchecked
  } catch {
    return unchecked
  }
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

type UnboundEvent = Exclude<CodexEvent, { type: 'bound' }>

function keyedFiles(machine: string, event: UnboundEvent): UnboundEvent {
  if (event.type !== 'files-changed') return event
  const at = (p: string | undefined): string | undefined => keyedOn(machine, p)
  return {
    ...event,
    files: event.files.map((f) => ({ ...f, src: at(f.src)! })),
    lastTouched: at(event.lastTouched),
    lastWritten: at(event.lastWritten)
  }
}

export interface CodexMachineDeps {
  instance: string
  ready(): Promise<void>
  run(machine: string, cmd: string): Promise<RunResult>
  sshArgs(machine: string, background: boolean): string[]
  machinePackage(): MachinePackage
  tabDir(tabId: string): string
  fileExists(file: string): Promise<boolean>
  keyed(machine: string, onMachine: string): string
  mirrorDir(machine: string): string
  nextPull(machine: string): Promise<void>
}

function shellWritesFrom(file: string, pulled: () => Promise<void>): () => Promise<string[]> {
  let offset = 0
  return async () => {
    await pulled()
    let fresh: Buffer
    try {
      const fd = fs.openSync(file, 'r')
      try {
        const size = fs.fstatSync(fd).size
        if (size < offset) offset = 0
        const added = Buffer.alloc(size - offset)
        fs.readSync(fd, added, 0, added.length, offset)
        fresh = added.subarray(0, added.lastIndexOf(10) + 1)
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return []
    }
    offset += fresh.length
    return fresh
      .toString('utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          return shellWrittenFiles(JSON.parse(line)[SHELL_WROTE_FIELD])
        } catch {
          return []
        }
      })
  }
}

export interface CodexSessionDeps extends StoredSessionDeps {
  machine?: CodexMachineDeps
  trustFolder(root: string, env: NodeJS.ProcessEnv | undefined): void
  pickHome(resumeSessionId?: string): { account: string; home: string; notice?: string } | undefined
  assistOf(cwd: string, resumeKey?: string): { role: string } | undefined
  replyLanguageScript: string
  builtInStatusLine(): boolean
  browserEndpoint(tabId: string): string
  openShimRoot: string
  playwrightBin: string
  agent: {
    enabled(host: HostId): boolean
    answer(tabId: string | undefined, dir: string, name: string, raw: unknown): void
    skillsFolder(): string | undefined
  }
  gitAccounts: StoredSessionDeps['gitAccounts'] & {
    picked(cwd: string): Promise<boolean>
    ghWrapper: string
  }
}

interface CodexRun extends StoredRun {
  observer: CodexObservation
  transport: CodexTransport
  account: string
  machine?: string
  home: string
}

interface CodexLaunch {
  picked: { account: string; home: string }
  binary: string
  processEnv: NodeJS.ProcessEnv | undefined
}

export class CodexSessions extends StoredSessions<CodexRun, CodexThread, CodexLaunch> {
  readonly id = 'codex'
  private crashLeftoversEnded?: Promise<void>
  private listedHooks = new Map<string, ListedHook>()
  private sideServers = new CodexSideServers((home: string | undefined) => this.rpc(home))
  private machineSideServers = new CodexSideServers((machine: string) => this.machineRpc(machine))
  private machineHistory = new Map<
    string,
    { at: number; reading?: Promise<void>; error?: unknown }
  >()
  private machinesSwept = new Map<string, Promise<void>>()
  protected readonly cli = {
    product: 'Codex CLI',
    minVersion: MIN_CODEX_VERSION,
    howToUpdate: 'Run "codex update"',
    find: () => resolveCodexRuntime(),
    update: updateCodex
  }

  constructor(
    file: string,
    protected deps: CodexSessionDeps
  ) {
    super(file, codexSessionKey, deps)
  }

  protected untestedNotice(version: string): string {
    return `Codex ${version} is newer than the version Koloft was tested with (${TESTED_CODEX_LINE}.x). It may misbehave.`
  }

  private machineDeps(): CodexMachineDeps {
    if (!this.deps.machine) throw new Error('Codex cannot reach remote machines here.')
    return this.deps.machine
  }

  machineOfTab(tabId: string): string | undefined {
    return this.runs.get(tabId)?.machine
  }

  machinesWithTabs(): string[] {
    return [...this.runs.values()].flatMap((r) => (r.machine ? [r.machine] : []))
  }

  private async startTransport(
    options: Parameters<typeof createCodexTransport>[0]
  ): Promise<CodexTransport> {
    // CODEX§5
    await (this.crashLeftoversEnded ??= endCodexAppServersLeftByACrash(CODEX_ASKS_AND_WAITS)
      .catch(() => {})
      .then(() => removeFoldersLeftByEndedRuns(CODEX_TMP_DIR, CODEX_TMP_FOLDER)))
    try {
      return await createCodexTransport(options)
    } catch (error) {
      this.forgetProbe()
      throw error
    }
  }

  get cliBinary(): string | undefined {
    return this.binary
  }

  // CODEX§15
  private envFor(home: string | undefined): NodeJS.ProcessEnv | undefined {
    return home ? { ...this.processEnv, CODEX_HOME: home } : this.processEnv
  }

  // CODEX§27
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

  // CODEX§27
  private async askHookTrust(
    launch: CodexProcessOptions,
    configFile: string,
    wanted: KoloftHook[]
  ): Promise<Set<string>> {
    const rpc = new CodexRpc(launch)
    try {
      const listed = (): Promise<ListedHook[]> => this.listHooks(rpc, launch.cwd, wanted)
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

  // ADR-0039 CODEX§27
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
      return await this.listHooks(rpc, os.homedir(), wanted)
    } finally {
      await rpc.close().catch(() => {})
    }
  }

  // CODEX§27
  private async listHooks(rpc: CodexRpc, cwd: string, wanted: KoloftHook[]): Promise<ListedHook[]> {
    const hooks = koloftHooksIn(
      await rpc.request('hooks/list', { cwds: [cwd] }).catch(() => undefined),
      wanted
    )
    for (const hook of hooks) this.listedHooks.set(hook.command, hook)
    return hooks
  }

  // CODEX§16
  private machineRpc(machine: string): CodexRpc {
    const m = this.machineDeps()
    return new CodexRpc({
      binary: 'ssh',
      args: [...m.sshArgs(machine, true), machine, machineAppServerCmd(m.instance)],
      cwd: os.homedir()
    })
  }

  // ADR-0039
  private async withMachineRpc<T>(machine: string, use: (rpc: CodexRpc) => Promise<T>): Promise<T> {
    await this.machineDeps().ready()
    await this.sweptOnce(machine)
    return this.machineSideServers.ask(machine, use)
  }

  private withRpcFor<T>(key: string, use: (rpc: CodexRpc) => Promise<T>): Promise<T> {
    const machine = hostOfKey(key)
    return machine ? this.withMachineRpc(machine, use) : this.withRpc(undefined, use)
  }

  // ADR-0039 CODEX§15 CODEX§16
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
          await this.rereadSignIn(home)
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

  private rpc(home: string | undefined): CodexRpc {
    return new CodexRpc({ binary: this.binary!, env: this.envFor(home), cwd: os.homedir() })
  }

  private async binaryOrThrow(): Promise<string> {
    if (!this.binary && !(await this.availability()).available)
      throw new Error('Codex CLI is unavailable.')
    return this.binary!
  }

  private async withRpc<T>(
    home: string | undefined,
    use: (rpc: CodexRpc) => Promise<T>
  ): Promise<T> {
    await this.binaryOrThrow()
    try {
      return await this.sideServers.ask(home, use)
    } catch (error) {
      this.noteBinaryGone(error)
      throw error
    }
  }

  // CODEX§15
  rereadSignIn(home: string): Promise<void> {
    return this.sideServers.forget(home)
  }

  hasProcesses(): boolean {
    return super.hasProcesses() || this.sideServers.anyOpen || this.machineSideServers.anyOpen
  }

  async stopAll(deadlineMs?: number): Promise<void> {
    await Promise.all([
      super.stopAll(deadlineMs),
      this.sideServers.closeAll(),
      this.machineSideServers.closeAll()
    ])
  }

  // CODEX§26
  private ownConfig(home: string): Promise<Record<string, unknown>> {
    return this.withRpc(home, (rpc) => rpc.request('config/read', { cwd: os.homedir() }))
      .then((read) => record(record(read).config))
      .catch(() => ({}))
  }

  private async browserOverrides(home: string, cwd: string): Promise<string[]> {
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
      ...playwrightEnvOverrides(config.mcp_servers),
      ...browserSandboxOverrides(config.sandbox_workspace_write, cacheDir)
    ]
  }

  // CODEX§15
  async readAccount(home: string): Promise<{ signedIn: boolean; apiKey?: true; limits?: unknown }> {
    return this.withRpc(home, async (rpc) => {
      const account = record(await rpc.request('account/read', {}))
      if (!account.account) return { signedIn: false }
      if (record(account.account).type === 'apiKey') return { signedIn: true, apiKey: true }
      return { signedIn: true, limits: await rpc.request('account/rateLimits/read', {}) }
    })
  }

  // CODEX§15
  async storeApiKey(home: string, key: string): Promise<void> {
    const binary = await this.binaryOrThrow()
    await pipeSecretTo(binary, ['login', '--with-api-key'], this.envFor(home), key)
    await this.rereadSignIn(home)
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

  // CODEX§15
  protected async listHistory(): Promise<HistoryListing<CodexThread>> {
    const local = await this.withRpc(undefined, (rpc) => listThreads(rpc))
    const onMachines = [...this.history].flatMap(([key, entry]) =>
      hostOfKey(key) ? [{ key, entry, archived: this.archivedIds.has(key) }] : []
    )
    return { entries: [...this.listedOn(undefined, local), ...onMachines], listedHosts: [] }
  }

  private listedOn(
    machine: string | undefined,
    threads: ListedThread[]
  ): { key: string; entry: CodexThread; archived: boolean }[] {
    return threads.map(({ thread, archived }) => ({
      key: codexSessionKey(thread.id, machine),
      entry: machine ? { ...thread, cwd: this.machineDeps().keyed(machine, thread.cwd) } : thread,
      archived
    }))
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
    const startedAt = Date.now()
    const home = await this.machineDeps().run(machine, HAS_CODEX_HOME_CMD)
    if (sshLinkBroke(home)) throw new Error(problemOf(home))
    const threads =
      home.code === 0 ? await this.withMachineRpc(machine, (rpc) => listThreads(rpc)) : []
    if (this.shuttingDown) return
    const others = (key: string): boolean => hostOfKey(key) !== machine
    this.history = new Map([...this.history].filter(([key]) => others(key)))
    this.archivedIds = new Set([...this.archivedIds].filter(others))
    for (const { key, entry, archived } of this.listedOn(machine, threads)) {
      this.history.set(key, entry)
      if (archived) this.archivedIds.add(key)
    }
    if (home.code === 0) this.listedAt.set(machine, startedAt)
    else this.listedAt.delete(machine)
    this.changed()
  }

  async historyRows(workspace: string): Promise<BackendSessionRow[]> {
    const machine = parseRemoteKey(workspace)?.host
    if (!machine) return super.historyRows(workspace)
    await this.refreshMachineHistory(machine)
    return this.rows(workspace).filter(
      (r) => !r.running && !this.members().has(r.id) && !this.archivedIds.has(r.id)
    )
  }

  stop(tabId: string, nativeExitCode?: number, restarting = false): Promise<void> {
    const machine = this.runs.get(tabId)?.machine
    const stopped = super.stop(tabId, nativeExitCode, restarting)
    const state = machine && this.machineHistory.get(machine)
    if (restarting && state) state.at = 0
    else if (machine)
      void stopped.then(
        async () => {
          if (this.shuttingDown) return
          await this.refreshMachineHistory(machine, true).catch((error) =>
            this.deps.error(String(error))
          )
        },
        () => {}
      )
    return stopped
  }

  // CODEX§24
  async searchSnippets(
    term: string,
    signal?: AbortSignal
  ): Promise<{ id: string; snippet: string }[]> {
    if (!(await this.availability()).available) return []
    return this.searchSharedHome(term, signal).catch(() => [])
  }

  // CODEX§15 CODEX§24
  private searchSharedHome(
    term: string,
    signal?: AbortSignal
  ): Promise<{ id: string; snippet: string }[]> {
    return this.withRpc(undefined, async (rpc) => {
      const found: { id: string; snippet: string }[] = []
      const params = { searchTerm: term, archived: false, sourceKinds }
      for await (const value of everyPage(rpc, 'thread/search', params)) {
        if (signal?.aborted) return []
        const item = record(value)
        const thread = userThread(item.thread)
        if (thread)
          found.push({
            id: thread.id,
            snippet: typeof item.snippet === 'string' ? item.snippet : ''
          })
      }
      const said = await mapAtMost(found, THREADS_CHECKED_AT_ONCE, async (hit) => {
        if (signal?.aborted) return undefined
        const snippet = await saidInThread(rpc, hit, term)
        return snippet === undefined ? undefined : { id: codexSessionKey(hit.id), snippet }
      })
      return said.filter((h): h is { id: string; snippet: string } => !!h)
    })
  }

  // CODEX§15
  async transcriptExists(key: string): Promise<boolean> {
    if (this.archivedIds.has(key)) return false
    const machine = hostOfKey(key)
    const listed = machine ? undefined : this.history.get(key)?.path
    if (listed && rolloutOnThisMac(listed)) return true
    const id = this.nativeId(key)
    const file = await this.withRpcFor(key, async (rpc) => {
      const reply = record(await rpc.request('thread/read', { threadId: id, includeTurns: false }))
      return userThread(reply.thread)?.path
    })
    if (!file) return false
    if (!machine) return rolloutOnThisMac(file)
    const m = this.machineDeps()
    const found = await Promise.all(
      rolloutFiles(file).map((f) => m.fileExists(keyedOn(machine, f)!))
    )
    return found.includes(true)
  }

  openApproval(tabId: string): CodexApproval | undefined {
    return this.runs.get(tabId)?.observer.openApproval()
  }

  openQuestion(tabId: string): CodexQuestion | undefined {
    return this.runs.get(tabId)?.observer.openQuestion()
  }

  questionWentUnanswered(tabId: string): boolean {
    return !!this.runs.get(tabId)?.observer.questionWentUnanswered()
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

  // CODEX§11
  protected permissionOf(opts: CreateTabOptions): LaunchPermission {
    return opts.resumeSessionId ? (opts.permission ?? 'default') : super.permissionOf(opts)
  }

  protected prepare(opts: CreateTabOptions): CodexLaunch {
    // CODEX§15 CODEX§18 ADR-0030
    const picked = this.deps.pickHome(opts.resumeSessionId)
    if (!picked) throw new Error(this.deps.noAccountMessage('codex'))
    if (picked.notice) this.deps.error(picked.notice)
    return { picked, binary: this.binary!, processEnv: this.processEnv }
  }

  protected launchAccount({ picked }: CodexLaunch): string {
    return picked.account
  }

  protected async startRun(
    { opts, cwd, resource, freshWorktree, workspace }: StartContext,
    { picked, binary, processEnv }: CodexLaunch
  ): Promise<CodexRun> {
    const home = picked.home
    const machine = parseRemoteKey(cwd)?.host
    const trustedOnMachine: string[] = []
    const trust = (dir: string, env: NodeJS.ProcessEnv | undefined): void => {
      if (machine) trustedOnMachine.push(barePath(dir))
      else this.deps.trustFolder(dir, env)
    }
    // ADR-0026 CODEX§11
    if (freshWorktree) for (const dir of [workspace, cwd]) trust(dir, processEnv)
    // ADR-0029
    const assist = machine ? undefined : this.deps.assistOf(cwd, opts.resumeSessionId)
    const conductor = !machine && (opts.conductor || !!assist)
    const role = opts.role ?? assist?.role
    if (opts.trustFolder || assist) trust(cwd, this.envFor(home))
    if (conductor && (opts.trustFolder || assist)) seedAssistMemory(cwd)
    const tabId = opts.tabId ?? this.deps.pty.nextId()
    const holding = !!this.deps.holdWhileBusy?.(tabId)
    const holdHere = holding && !machine ? this.deps.holdScript : undefined
    const endpoint = machine ? '' : this.deps.browserEndpoint(tabId)
    const browser = endpoint ? await this.browserOverrides(home, cwd) : []
    // CODEX§29
    const gitNetwork = (await this.deps.gitAccounts.picked(cwd))
      ? ['sandbox_workspace_write.network_access=true']
      : []
    this.assertStarting()
    let bound: CodexRun | undefined
    const observe = (event: CodexEvent): void => {
      if (event.type !== 'bound') {
        if (machine && event.type === 'open') return
        if (bound) this.deps.events(bound.tabId, machine ? keyedFiles(machine, event) : event)
        else if (event.type === 'degraded') this.deps.error(event.message)
        return
      }
      if (!bound || bound.explicitStop || bound.stopping) return
      // CODEX§34
      if (bound.info?.nativeSessionId === event.thread.id) {
        this.rejoined(bound)
        return
      }
      const name = bound.launchName
      // CODEX§17
      if (name)
        bound.transport
          .request('thread/name/set', { threadId: event.thread.id, name })
          .catch((error) => this.deps.error(String(error)))
      this.bind(
        bound,
        machine
          ? { ...event.thread, cwd: this.machineDeps().keyed(machine, event.thread.cwd) }
          : event.thread,
        event.change
      )
    }
    const agent = this.deps.agent.enabled(machine ? 'ssh' : 'local') ? this.deps.agent : undefined
    const openShim = machine
      ? undefined
      : this.startOpenShim(
          processEnv?.ZDOTDIR,
          (target) => observe({ type: 'open', target }),
          agent && ((dir, name, raw) => agent.answer(bound?.tabId, dir, name, raw))
        )
    const env = openShim ? { ...this.envFor(home), ZDOTDIR: openShim.zdotDir } : this.envFor(home)
    const said = openShim && path.join(openShim.shimDir, 'said')
    if (said && opts.ownerWords) seedHandedOverOwnerWords(said, opts.ownerWords)
    const shellWroteDir = machine ? this.machineDeps().mirrorDir(machine) : this.deps.hookRegDir
    const shellWrote = shellWroteDir && path.join(shellWroteDir, tabId + SHELL_WROTE_SUFFIX)
    if (shellWrote) fs.rmSync(shellWrote, { force: true })
    const observer = new CodexObservation(
      observe,
      shellWrote
        ? shellWritesFrom(shellWrote, async () => {
            if (machine) await this.machineDeps().nextPull(machine)
          })
        : undefined
    )
    const instructions = [
      ...(agent && !conductor ? [koloftPrompt('codex')] : []),
      ...(role ? [role] : [])
    ]
    const permission = this.permissionOf(opts)
    const permissions = PERMISSIONS[permission]
    const builtInStatusLine = this.deps.builtInStatusLine()
    const processOptions: CodexProcessOptions = {
      binary,
      env,
      sessionEnv: {
        ...(resource && { KOLOFT_PORT_OFFSET: String(portOffset(resource.worktreeName)) }),
        ...(machine ? { KOLOFT_TAB_ID: tabId } : browserControlEnv(tabId, endpoint)),
        ...(said && {
          [CODEX_REPLY_LANGUAGE_ENV]: this.deps.replyLanguageScript,
          [CODEX_SAID_ENV]: said,
          ...(this.deps.hookRegDir && {
            [NOTICE_ENV]: noticeFile(this.deps.hookRegDir, tabId),
            [CODEX_DISCORD_SAID_ENV]: discordSaidFile(this.deps.hookRegDir, tabId),
            [CODEX_SHELL_WROTE_ENV]: path.join(this.deps.hookRegDir, tabId + SHELL_WROTE_SUFFIX)
          })
        }),
        ...(holdHere && {
          [CODEX_HOLD_SCRIPT_ENV]: holdHere.file,
          [CODEX_HOLD_REG_ENV]: holdHere.regDir,
          [HOLD_TAB_ENV]: tabId
        })
      },
      cwd,
      configOverrides: [
        ...(builtInStatusLine ? [STATUS_LINE_CONFIG] : []),
        ...browser,
        ...gitNetwork,
        ...(instructions.length ? [developerInstructions(instructions)] : []),
        ...(opts.resumeSessionId ? permissionConfig(permissions) : []),
        CODEX_ASKS_AND_WAITS
      ]
    }
    // ADR-0043
    const hooks: KoloftHook[] = [
      ...CODEX_REPLY_LANGUAGE_HOOKS,
      ...CODEX_SHELL_WRITES_HOOKS,
      ...((machine ? holding : holdHere) ? [codexHoldHook(machine ? 'hold-self' : 'hold')] : [])
    ]
    let transport: CodexTransport | undefined
    try {
      const askMachineTrust = !!machine && !permissions && !opts.resumeSessionId
      const [hookTrust, , trustedThere, ownConfig] = machine
        ? await Promise.all([
            this.koloftHookStates(hooks),
            this.sweptOnce(machine),
            askMachineTrust &&
              (trustedOnMachine.includes(barePath(cwd)) ||
                this.machineTrusts(parseRemoteKey(cwd)!)),
            askMachineTrust ? this.ownConfig(home) : {}
          ])
        : [[], undefined, false, {}]
      // CODEX§16
      const launchFlags = trustedThere
        ? machineTrustedFolderFlags(ownConfig)
        : permissionFlags(permissions)
      // ADR-0031
      const trusted = machine
        ? new Set(hookTrust.map((h) => h.command))
        : await this.trustKoloftHooks(processOptions, codexConfigFile(this.envFor(home)), hooks)
      this.assertStarting()
      const serverConfig = [
        ...processOptions.configOverrides!,
        ...hookOverrides(trustedInPlace(hooks, trusted))
      ]
      const skills = agent && !machine ? agent.skillsFolder() : undefined
      transport = await this.startTransport({
        ...processOptions,
        ...(skills && { skillRoots: [skills] }),
        ...(machine && {
          upstream: (frame, failure) =>
            new MachineCodexUpstream(
              this.machineUpstream(machine, tabId, home, () => bound?.cwd ?? cwd),
              frame,
              failure
            )
        }),
        configOverrides: serverConfig,
        onFrame: (direction, frame) => observer.receive(direction, frame),
        observes: (direction, head) => observer.wants(direction, head),
        onDisconnect: () => {
          observer.screenLeft()
          this.markDegraded(bound)
        },
        onServerReplaced: () => observer.serverReplaced(),
        onError: (error) => {
          this.markDegraded(bound)
          this.deps.error(String(error))
        }
      })
      this.assertStarting()
      const argv = [
        '--remote',
        transport.url,
        '-C',
        barePath(cwd),
        ...(builtInStatusLine ? ['-c', STATUS_LINE_CONFIG] : []),
        '-c',
        NO_UPDATE_NOTICE_AT_START,
        ...(opts.resumeSessionId ? [] : launchFlags),
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
                version: (await this.availability()).version ?? '',
                cwd: barePath(cwd),
                trust: trustedOnMachine,
                env: processOptions.sessionEnv ?? {},
                config: serverConfig,
                hookTrust: hookTrust.map((h) => ({ key: h.key, hash: h.currentHash })),
                ownerWords: opts.ownerWords,
                agentTools: !!agent
              })
            ]
          }
        : { cwd, executable: binary, argv }
      const handle = this.deps.pty.create({
        id: tabId,
        kind: 'codex',
        ...CODEX_TAB_ENV,
        ...launch,
        cols: opts.cols,
        rows: opts.rows,
        processEnv: env,
        resumeSessionId: opts.resumeSessionId
      })
      const run: CodexRun = {
        tabId: handle.id,
        cwd,
        workspace,
        resource,
        observer,
        transport,
        explicitStop: false,
        resumeKey: opts.resumeSessionId,
        launchName: opts.name,
        account: picked.account,
        permission,
        bypassing: permission === 'bypass',
        machine,
        home,
        releaseTools: openShim?.release ?? ((): void => {})
      }
      bound = run
      return run
    } catch (error) {
      await transport?.stop()
      openShim?.release()
      if (machine) fs.rmSync(this.machineDeps().tabDir(tabId), { recursive: true, force: true })
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

  // ADR-0039
  private sweptOnce(machine: string): Promise<void> {
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

  // ADR-0039 CODEX§16
  private machineUpstream(
    machine: string,
    tabId: string,
    home: string,
    cwdNow: () => string
  ): MachineUpstreamOptions {
    const m = this.machineDeps()
    return {
      connect: () =>
        spawn('ssh', [...m.sshArgs(machine, true), machine, proxyCmd(m.instance, tabId)], {
          stdio: 'pipe'
        }),
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
      sshOptions: m.sshArgs(machine, false),
      machine: pkg,
      tabDir,
      tabId,
      tui
    })
  }

  private startOpenShim(
    userZdotdir: string | undefined,
    open: (target: string) => void,
    agent?: (dir: string, name: string, raw: unknown) => void
  ): { shimDir: string; zdotDir: string; release(): void } {
    const { shim, release } = startToolShim(
      { ...this.deps, ghWrapper: this.deps.gitAccounts.ghWrapper },
      { backend: 'codex', userZdotdir, open, agent }
    )
    return { shimDir: shim.shimDir, zdotDir: shim.zdotDir, release }
  }

  // CODEX§34
  private rejoined(run: CodexRun): void {
    if (run.info) Object.assign(run.info, this.runDetails(run))
    this.changed()
    for (const cut of run.observer.takeQueuedCutOffByAReplacedServer()) {
      if (cut.sentAgain)
        this.deps.error(
          `Codex stopped twice in the middle of a message Koloft gave it, so Koloft did not send it a third time: "${cut.text.slice(0, MESSAGE_SHOWN_IN_A_NOTICE_CHARS)}"`
        )
      else
        this.queueInto(run.tabId, cut.text, `koloft-${randomUUID()}`, true).catch((error) =>
          this.deps.error(String(error))
        )
    }
  }

  // CODEX§17
  queueMessage(tabId: string, text: string, clientId = `koloft-${randomUUID()}`): Promise<void> {
    return this.queueInto(tabId, text, clientId, false)
  }

  private async queueInto(
    tabId: string,
    text: string,
    clientId: string,
    sentAgain: boolean
  ): Promise<void> {
    const run = this.runs.get(tabId)
    const threadId = run?.info?.nativeSessionId
    if (!run || !threadId) throw new Error('that Codex session has not started yet.')
    run.observer.queuedMessage(clientId, text, sentAgain)
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

  protected async endRun(run: CodexRun): Promise<void> {
    await run.transport.stop()
  }

  protected exitedOnItsOwn(run: CodexRun): boolean {
    return run.observer.unsubscribed
  }

  protected runDetails(run: CodexRun): Pick<BackendSessionInfo, 'details' | 'pickedAccount'> {
    return { details: { codex: { observation: 'live' } }, pickedAccount: run.account }
  }

  // CODEX§12 CODEX§15
  protected scratchpadOf(run: CodexRun, thread: CodexThread): string | undefined {
    return run.machine
      ? machineImagesDir(run.machine, thread.id, thread.path)
      : path.join(run.home, IMAGES_FOLDER, thread.id)
  }

  protected degradedDetails(): BackendSessionInfo['details'] {
    return { codex: { observation: 'degraded' } }
  }

  // CODEX§2
  protected archivedNotice(key: string): string {
    return `Archived in Codex. Run codex unarchive ${this.nativeId(key)} first.`
  }
}
