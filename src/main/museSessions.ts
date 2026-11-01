import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type {
  BackendSessionInfo,
  BackgroundItem,
  CreateTabOptions,
  LaunchPermission
} from '@shared/types'
import { PLACEHOLDER_TITLES } from '@shared/types'
import type { Turn } from '@shared/turns'
import type { TranscriptPlaces } from './sessionBackends'
import { koloftPrompt } from '@shared/agentGuide'
import { portOffset } from '@shared/worktreeName'
import { resolveCliRuntime, type CliRuntime, type CliSpec } from './cliRuntime'
import { MIN_MUSE_VERSION, TESTED_MUSE_LINE } from './cliMinimums'
import { record } from './codexObservation'
import { writeWholeBeforeVisible } from './jsonDrops'
import { startToolShim } from './toolShim'
import { placeKoloftSkill, readJson } from './museAccounts'
import { mapAtMost } from './mapAtMost'
import { agentSkillMarkdown } from './agentPlugin'
import { pidAlive } from './leftovers'
import { inputBoxDraft } from './inputBox'
import { browserControlEnv } from './browserControlEnv'
import {
  PROGRAM_STATUS_REPLY,
  ProgramStatusParser,
  statusEvent,
  type ProgramStatus
} from './programStatus'
import {
  HOOK_DROP_PREFIX,
  MUSE_HOOKS_ENV,
  museHook,
  writeMuseHooks,
  type MuseHold,
  type MuseRelayFiles,
  type MuseHook
} from './museHooks'
import {
  LineTail,
  SessionLogTail,
  finishedWork,
  museConfigHome,
  museHome,
  museSessionLog,
  compactionEnds,
  compactionStarts,
  firedJob,
  museNameOf,
  replyIn,
  turnEndedIn,
  renamedTo,
  startsATurnByItself,
  saidInLog,
  textOfLogLine,
  type LogRecord
} from './museSessionLog'
import { noteRead, noteWrite, shellWrittenFiles, wroteEvent, type FileAcc } from './touchedFiles'
import { UUID, hostOfPath, museSessionKey } from './sessionStore'
import {
  listMuseSessions,
  readMuseAsk,
  readMuseTurns,
  type MuseAsk,
  type MuseHistoryEntry,
  type ServeOptions
} from './museServe'
import { isRemoteKey, resolveOnHost } from '@shared/remoteKey'
import {
  POSIX_SHELL_FOR_REMOTE_LAUNCH_LINE,
  TAB_TMUX_NAME_SH,
  tmuxSessionName
} from './remote/launch'
import type { MuseMachineLaunch, MuseMachinePlan } from './host/sshHost'
import { MIRROR_SUFFIX, MUSE_LOG_GREP, RUN_POINTER_SUFFIX } from './museRemote'
import { sleep } from './codexTransport'
import type { CodexApproval, CodexQuestion } from './discord/dialog'
import { museToolDid } from './rowActivity'
import { pathWithDirFirst } from './toolInstall'
import { realpathSafe } from './projectInfo'
import { SHELL_WROTE_FIELD } from './hooks'
import {
  REMOTE_EXIT_WAIT_MS,
  StoredSessions,
  hostOfKey,
  type HistoryListing,
  type StartContext,
  type StoredRun,
  type StoredSessionDeps
} from './storedSessions'

const exec = promisify(execFile)

export interface MuseHomePick {
  account: string
  env: Record<string, string>
  banner?: string
  notice?: string
}

export interface MuseSessionDeps extends StoredSessionDeps {
  openShimRoot: string
  pickHome(resumeSessionId?: string): MuseHomePick | undefined
  playwrightBin: string
  browserEndpoint(tabId: string): string
  assistOf(cwd: string, resumeKey?: string): { role: string } | undefined
  skipPermissions(): boolean
  serversAmong(pid: number, commands: Map<string, string>): Promise<Set<string>>
  agent: {
    enabled(remote: boolean): boolean
    answer(tabId: string | undefined, dir: string, name: string, raw: unknown): void
  }
  gitAccounts: StoredSessionDeps['gitAccounts'] & { ghWrapper: string }
  remote?: MuseRemoteDeps
}

export interface MuseMachine {
  launchMuse(spec: MuseMachineLaunch): Promise<MuseMachinePlan>
  museServe(args: string[]): { binary: string; args: string[] }
  museTrusts(dir: string): Promise<boolean>
  endTmuxSession(tmuxName: string): Promise<string | undefined>
  runScript(script: string, args: string[]): Promise<string | null>
}

export interface MuseRemoteDeps {
  machine(host: string): MuseMachine
  hosts(): string[]
  keyed(host: string, pathOnMachine: string): string
  mirrorDir(host: string): string
  gone(host: string, sessionId: string): boolean
  connected(host: string): boolean
  poke(host: string): void
  setupLine(): string | undefined
  hookSettings(tabId: string): string | undefined
}

interface MuseLaunch {
  binary: string
  account: string
  banner?: string
  env: NodeJS.ProcessEnv
}

interface MuseRun extends StoredRun {
  account: string
  pid?: number
  startedAt: number
  boundAt: number
  sinceClear: ProgramStatus[]
  prompt?: { turnId: string; text: string; at: number; reply?: string }
  children: Set<string>
  background: Map<string, BackgroundItem>
  commands: Map<string, string>
  jobs: Map<string, boolean>
  touched: Map<string, FileAcc>
  liveWrites: number
  log?: { sessionId: string; tail: SessionLogTail }
  endedTurns: Set<string>
  waiting?: { since: number; ask: MuseAsk }
  host?: string
  tmuxName?: string
  attachTo?: string
  mirror?: { runId: string; tail: LineTail; replay?: string[] }
  lastSeq: number
}

const cwdRelative = (cwd: string, p: string): string =>
  isRemoteKey(cwd) ? resolveOnHost(`${cwd}/`, p) : path.resolve(cwd, p)

const textOrEmpty = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

function mirrorLine(raw: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(raw))
  } catch {
    return undefined
  }
}

// MUSE§11
const KEYS_TAKE_AFTER_A_DIALOG_SHOWS_MS = 2000

// MUSE§11
export function museShowsItsInputBox(lines: string[]): boolean {
  return inputBoxDraft(lines) !== undefined
}

// MUSE§1
const MUSE: CliSpec = {
  command: 'muse',
  testCommandEnv: 'KOLOFT_MUSE_CMD',
  name: 'Muse',
  cliName: 'Muse Code',
  notInstalled: 'Install Muse Code to start Muse sessions.',
  environment: (env) => env,
  version: /Muse Code (\d+)\.(\d+)\.(\d+)/,
  testedLine: TESTED_MUSE_LINE
}

// MUSE§14
const MUSE_UPDATE_TIMEOUT_MS = 5 * 60_000

// ADR-0038 MUSE§15
function approvalFlags(permission: LaunchPermission): string[] {
  if (permission === 'bypass') return ['--permission-profile', ':unrestricted']
  return ['--approval-judge', 'off', '--sandbox-network', 'enabled']
}

// MUSE§8
const PLAYWRIGHT_DIRS = {
  PWTEST_DAEMON_SESSION_DIR: 'pw-daemon',
  PWTEST_SOCKETS_DIR: 'pw-sockets',
  PWTEST_SERVER_REGISTRY: 'pw-registry'
} as const

// MUSE§4
const REGISTRY_SWEEP_MS = 500
const REGISTRY_WRITE_LEEWAY_MS = 1000

// MUSE§9
const BACKGROUND_RUNNING = 'background_running'
const LOGS_SEARCHED_AT_ONCE = 8
const WRITING_TOOLS = new Set(['write_file', 'edit_file'])
const SCHEDULED_JOB = /^Scheduled ([0-9a-f]{8})\b/

// MUSE§4
function registryDirs(env: NodeJS.ProcessEnv): string[] {
  return [
    path.join(museHome(env), 'runtime', 'muse', 'sessions'),
    ...(process.platform === 'darwin'
      ? [path.join('/tmp', `tbh-${process.getuid?.()}-rt`, 'muse', 'sessions')]
      : [])
  ]
}

// MUSE§2 MUSE§10
function trustFile(env: NodeJS.ProcessEnv): string {
  return path.join(museConfigHome(env), 'muse', 'trust.json')
}

const readTrust = (env: NodeJS.ProcessEnv): Record<string, unknown> => readJson(trustFile(env))

// MUSE§10
export function museTrustsFolder(env: NodeJS.ProcessEnv, dir: string): boolean {
  return record(record(readTrust(env).projects)[realpathSafe(dir)]).decision === 'trusted'
}

// ADR-0026 MUSE§10
export function trustMuseFolder(env: NodeJS.ProcessEnv, dir: string): void {
  if (museTrustsFolder(env, dir)) return
  const trust = readTrust(env)
  const projects = { ...record(trust.projects), [realpathSafe(dir)]: { decision: 'trusted' } }
  const file = trustFile(env)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeWholeBeforeVisible(
    realpathSafe(file),
    JSON.stringify({ schema_version: 1, ...trust, projects }, null, 2)
  )
}

interface RegistryEntry {
  sessionId: string
  pid: number
  mtimeMs: number
}

// MUSE§4
const registryPid = (entry: Record<string, unknown>): number =>
  Number(/^pid=(\d+)$/.exec(String(entry.process_generation_hint))?.[1])

// MUSE§4
function readRegistry(
  dir: string,
  pids: Set<number>,
  since: number
): { entries: RegistryEntry[]; whole: boolean } {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { entries: [], whole: true }
  }
  let whole = true
  const entries = names.flatMap((name) => {
    if (!name.endsWith('.json')) return []
    const full = path.join(dir, name)
    try {
      const { mtimeMs } = fs.statSync(full)
      if (mtimeMs < since) return []
      const entry = record(JSON.parse(fs.readFileSync(full, 'utf8')))
      const pid = registryPid(entry)
      if (entry.schema_version !== 1 || typeof entry.session_id !== 'string') return []
      if (!UUID.test(entry.session_id) || !pids.has(pid)) return []
      return [{ sessionId: entry.session_id, pid, mtimeMs }]
    } catch {
      whole = false
      return []
    }
  })
  return { entries, whole }
}

const responseOf = (input: Record<string, unknown>): Record<string, unknown> => {
  if (typeof input.tool_response !== 'string') return record(input.tool_response)
  try {
    return record(JSON.parse(input.tool_response))
  } catch {
    return {}
  }
}

// MUSE§9
function patchDelta(response: Record<string, unknown>): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of Array.isArray(response.structuredPatch) ? response.structuredPatch : []) {
    const lines = record(hunk).lines
    for (const line of Array.isArray(lines) ? lines : []) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

export class MuseSessions extends StoredSessions<MuseRun, MuseHistoryEntry, MuseLaunch> {
  readonly id = 'muse'
  private parsers = new Map<string, ProgramStatusParser>()
  private sweeping?: ReturnType<typeof setInterval>
  private registrySeenAt?: number
  private unreadable = new Set<string>()
  private remoteHistory = new Map<string, MuseHistoryEntry[]>()
  // MUSE§2
  protected readonly keepsItsOwnTitle = true
  // MUSE§14
  protected readonly cli = {
    product: 'Muse Code',
    minVersion: MIN_MUSE_VERSION,
    howToUpdate: 'Run "muse --version" with a working network to update it',
    find: () => resolveCliRuntime(MUSE),
    update: async (runtime: CliRuntime): Promise<void> => {
      await exec(runtime.binary, ['--version'], {
        env: { ...runtime.env, MUSE_SYNC_UPDATE: '1' },
        timeout: MUSE_UPDATE_TIMEOUT_MS
      }).catch(() => undefined)
    }
  }

  constructor(
    file: string,
    protected deps: MuseSessionDeps
  ) {
    super(file, museSessionKey, deps)
    deps.pty.on('data', ({ id, data }: { id: string; data: string }) => this.onData(id, data))
  }

  protected untestedNotice(version: string): string {
    return `Muse Code ${version} is newer than the version Koloft was tested with (${TESTED_MUSE_LINE}.x). It may misbehave.`
  }

  private get env(): NodeJS.ProcessEnv {
    return this.processEnv ?? process.env
  }

  // MUSE§2
  async searchSnippets(
    term: string,
    signal?: AbortSignal
  ): Promise<{ id: string; snippet: string }[]> {
    const wanted = term.toLowerCase()
    const onMachines = new Map<string, Map<string, string>>()
    for (const [key, entry] of this.history) {
      const host = hostOfKey(key)
      if (!host || !this.deps.remote?.connected(host)) continue
      if (entry.logPath)
        onMachines.set(host, (onMachines.get(host) ?? new Map()).set(entry.logPath, key))
    }
    const remote = Promise.all(
      [...onMachines].map(async ([host, keyOfLog]) => {
        const out = await this.deps.remote
          ?.machine(host)
          .runScript(MUSE_LOG_GREP, [term, ...keyOfLog.keys()])
          .catch(() => null)
        const hits = new Map<string, string>()
        for (const line of out?.split('\n') ?? []) {
          const tab = line.indexOf('\t')
          const key = keyOfLog.get(line.slice(0, tab))
          const text = key && !hits.has(key) ? textOfLogLine(line.slice(tab + 1)) : undefined
          if (key && text?.toLowerCase().includes(wanted)) hits.set(key, text)
        }
        return [...hits].map(([id, snippet]) => ({ id, snippet }))
      })
    )
    const local = [...this.history.keys()].filter((key) => !hostOfKey(key))
    const hits = await mapAtMost(local, LOGS_SEARCHED_AT_ONCE, async (key) => {
      const file = !signal?.aborted && museSessionLog(this.env, this.nativeId(key))
      if (!file) return undefined
      let hit: string | undefined
      await saidInLog(file, (text) => {
        if (signal?.aborted) return true
        if (!text.toLowerCase().includes(wanted)) return false
        hit = text
        return true
      }).catch(() => undefined)
      return hit && { id: key, snippet: hit }
    })
    return [
      ...hits.filter((h): h is { id: string; snippet: string } => !!h),
      ...(await remote).flat()
    ]
  }

  trustsFolder(dir: string): boolean | Promise<boolean> {
    const host = hostOfPath(dir)
    if (!host) return museTrustsFolder(this.env, dir)
    return this.deps.remote?.machine(host).museTrusts(dir) ?? false
  }

  // MUSE§4
  runningElsewhere(key: string): boolean {
    if (hostOfKey(key)) return false
    return registryDirs(this.env).some((dir) => {
      const pid = registryPid(readJson(path.join(dir, `${this.nativeId(key)}.json`)))
      const ours = [...this.runs.values()].some((r) => r.pid === pid)
      return pid > 0 && !ours && pidAlive(pid)
    })
  }

  private serveOptions(): { binary: string; env: NodeJS.ProcessEnv } {
    if (!this.binary) throw new Error('Muse Code is unavailable.')
    return { binary: this.binary, env: this.env }
  }

  // MUSE§17
  private serveFor(key: string): ServeOptions {
    return this.serveOn(hostOfKey(key))
  }

  private serveOn(host: string | undefined): ServeOptions {
    if (!host) return this.serveOptions()
    const machine = this.deps.remote?.machine(host)
    if (!machine) throw new Error(`Koloft cannot reach ${host}.`)
    return { binary: 'ssh', env: this.env, over: (args) => machine.museServe(args) }
  }

  protected async listHistory(): Promise<HistoryListing<MuseHistoryEntry>> {
    const remote = this.deps.remote
    const hosts = remote?.hosts() ?? []
    const listedHosts: string[] = []
    const [sessions] = await Promise.all([
      listMuseSessions(this.serveOptions()),
      ...hosts
        .filter((host) => remote!.connected(host))
        .map(async (host) => {
          const listed = await listMuseSessions(this.serveOn(host)).catch(() => undefined)
          if (!listed) return
          this.remoteHistory.set(
            host,
            listed.map((entry) => ({ ...entry, cwd: remote!.keyed(host, entry.cwd) }))
          )
          listedHosts.push(host)
        })
    ])
    for (const host of this.remoteHistory.keys())
      if (!hosts.includes(host)) {
        this.remoteHistory.delete(host)
        this.listedAt.delete(host)
      }
    return {
      entries: [
        ...sessions.map((entry) => ({ key: museSessionKey(entry.id), entry, archived: false })),
        ...[...this.remoteHistory].flatMap(([host, entries]) =>
          entries.map((entry) => ({ key: museSessionKey(entry.id, host), entry, archived: false }))
        )
      ],
      listedHosts
    }
  }

  async transcriptExists(key: string): Promise<boolean> {
    if (!this.history.has(key)) await this.refreshHistory()
    return this.history.has(key)
  }

  // MUSE§5
  async readTurns(key: string, n: number): Promise<Turn[]> {
    if (!hostOfKey(key) && !this.binary && !(await this.availability()).available) return []
    try {
      const turns = await readMuseTurns(this.serveFor(key), this.nativeId(key), n)
      this.unreadable.delete(key)
      return turns
    } catch (error) {
      if (!this.unreadable.has(key)) {
        this.unreadable.add(key)
        this.deps.error(
          `Koloft could not read this Muse session's messages: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      return []
    }
  }

  // MUSE§2 MUSE§5
  transcriptPlaces(key: string): TranscriptPlaces | undefined {
    const listed = this.history.get(key)?.logPath
    if (hostOfKey(key)) return listed ? { onMachine: listed } : undefined
    const followed = [...this.runs.values()].find((r) => r.info?.sessionId === key)?.log?.tail.file
    const file = listed ?? followed
    return file ? { onThisMac: file } : undefined
  }

  get cliBinary(): string | undefined {
    return this.binary
  }

  protected prepare(opts: CreateTabOptions): MuseLaunch {
    // ADR-0030 MUSE§13
    const picked = this.deps.pickHome(opts.resumeSessionId)
    if (!picked) throw new Error(this.deps.noAccountMessage('muse'))
    if (picked.notice) this.deps.error(picked.notice)
    return {
      binary: this.binary!,
      account: picked.account,
      banner: picked.banner,
      env: { ...this.env, ...picked.env }
    }
  }

  protected launchAccount(launch: MuseLaunch): string {
    return launch.account
  }

  protected runDetails(run: MuseRun): Pick<BackendSessionInfo, 'details' | 'pickedAccount'> {
    return { pickedAccount: run.account }
  }

  // MUSE§2
  protected scratchpadOf(): undefined {
    return undefined
  }

  protected async startRun(ctx: StartContext, launch: MuseLaunch): Promise<MuseRun> {
    return isRemoteKey(ctx.cwd) ? this.startRemoteRun(ctx, launch) : this.startLocalRun(ctx, launch)
  }

  // ADR-0030 MUSE§13 MUSE§17
  private credentialFor(account: string, env: NodeJS.ProcessEnv, host: string): string {
    try {
      return fs.readFileSync(path.join(env.XDG_CONFIG_HOME ?? '', 'muse', 'auth.json'), 'utf8')
    } catch {
      throw new Error(
        `The Muse account ${account} keeps no credential file Koloft can carry to ${host}. Sign it in again in Settings ▸ Accounts.`
      )
    }
  }

  private museArgv(opts: CreateTabOptions, approval: string[], trust: boolean): string[] {
    return [
      ...(opts.model ? ['--model', opts.model] : []),
      ...(opts.effort ? ['--reasoning-effort', opts.effort] : []),
      ...approval,
      ...(trust ? ['--trust-workspace'] : []),
      ...(opts.resumeSessionId
        ? ['resume', this.nativeId(opts.resumeSessionId)]
        : opts.firstPrompt
          ? [opts.firstPrompt]
          : [])
    ]
  }

  private newRun(
    { opts, cwd, workspace, resource }: StartContext,
    handle: { id: string; startedAt: number },
    permission: LaunchPermission,
    account: string,
    own: Partial<MuseRun> & Pick<MuseRun, 'releaseTools'>
  ): MuseRun {
    return {
      tabId: handle.id,
      cwd,
      workspace,
      resource,
      explicitStop: false,
      resumeKey: opts.resumeSessionId,
      permission: opts.permission ?? 'default',
      bypassing: permission === 'bypass',
      launchName: opts.name,
      account,
      startedAt: handle.startedAt,
      boundAt: handle.startedAt,
      sinceClear: [],
      children: new Set(),
      background: new Map(),
      commands: new Map(),
      jobs: new Map(),
      touched: new Map(),
      liveWrites: 0,
      endedTurns: new Set(),
      lastSeq: 0,
      ...own
    }
  }

  // MUSE§17
  private async startRemoteRun(
    ctx: StartContext,
    { account, banner, env }: MuseLaunch
  ): Promise<MuseRun> {
    const { opts, cwd, workspace, resource, freshWorktree } = ctx
    const remote = this.deps.remote
    const host = hostOfPath(cwd)
    if (!remote || !host) throw new Error('Koloft cannot reach this machine.')
    const permission = this.permissionOf(opts)
    const resumeId = opts.resumeSessionId ? this.nativeId(opts.resumeSessionId) : undefined
    const agentTools = this.deps.agent.enabled(true)
    const tabId = opts.tabId ?? this.deps.pty.nextId()
    const plan = await remote.machine(host).launchMuse({
      cwd,
      fallbackCwd: workspace !== cwd ? workspace : undefined,
      resumeSessionId: resumeId,
      account: { name: account, auth: () => this.credentialFor(account, env, host) },
      banner,
      args: this.museArgv(opts, approvalFlags(permission), false),
      trust: freshWorktree ? [workspace, cwd] : opts.trustFolder ? [cwd] : [],
      trustIf: resource ? workspace : undefined,
      context: agentTools ? koloftPrompt('muse') : undefined,
      skill: agentTools ? agentSkillMarkdown() : undefined,
      portOffset: resource ? portOffset(resource.worktreeName) : undefined,
      ownerWords: opts.ownerWords,
      holdWhileBusy: !!this.deps.holdWhileBusy?.(tabId)
    })
    this.assertStarting()
    this.parsers.set(tabId, new ProgramStatusParser())
    try {
      const handle = this.deps.pty.create({
        id: tabId,
        kind: 'muse',
        koloftShim: { hookSettings: (tabId) => remote.hookSettings(tabId) },
        cwd: os.homedir(),
        cols: opts.cols,
        rows: opts.rows,
        shell: POSIX_SHELL_FOR_REMOTE_LAUNCH_LINE,
        setupCommand: remote.setupLine(),
        launchCommand: plan.launchCommand,
        resized: plan.resized,
        remoteHost: host,
        resumeSessionId: opts.resumeSessionId
      })
      const run = this.newRun(ctx, handle, permission, account, {
        host,
        tmuxName: plan.tmuxName(handle.id),
        attachTo: plan.attach ? resumeId : undefined,
        releaseTools: () => this.parsers.delete(handle.id)
      })
      if (!plan.attach) run.mirror = { runId: handle.id, tail: this.mirrorTail(run, handle.id) }
      remote.poke(host)
      return run
    } catch (error) {
      this.parsers.delete(tabId)
      throw error
    }
  }

  private mirrorTail(run: MuseRun, runId: string): LineTail {
    const file = path.join(this.deps.remote!.mirrorDir(run.host!), runId + MIRROR_SUFFIX)
    return new LineTail(file, (line) => {
      if (run.mirror?.replay) run.mirror.replay.push(line)
      else this.onMirrorLine(run, mirrorLine(line))
    })
  }

  private keepSweeping(): void {
    this.sweeping ??= setInterval(() => {
      this.sweepRegistry()
      this.followLogs()
    }, REGISTRY_SWEEP_MS)
    this.sweeping.unref?.()
  }

  private async startLocalRun(
    ctx: StartContext,
    { binary, account, banner, env }: MuseLaunch
  ): Promise<MuseRun> {
    const { opts, cwd, workspace, resource, freshWorktree } = ctx
    // ADR-0026 MUSE§10
    if (freshWorktree) for (const dir of [workspace, cwd]) trustMuseFolder(env, dir)
    // ADR-0029
    const assist = this.deps.assistOf(cwd, opts.resumeSessionId)
    const conductor = opts.conductor || !!assist
    const role = opts.role ?? assist?.role
    if (opts.trustFolder || assist) trustMuseFolder(env, cwd)
    const trust = !!resource && museTrustsFolder(this.env, workspace)
    const tabId = opts.tabId ?? this.deps.pty.nextId()
    const endpoint = this.deps.browserEndpoint(tabId)
    this.assertStarting()
    const permission = this.permissionOf(opts)
    const agent = this.deps.agent.enabled(false) ? this.deps.agent : undefined
    if (env.XDG_CONFIG_HOME) placeKoloftSkill(env.XDG_CONFIG_HOME, !!agent)
    const instructions = [
      ...(agent && !conductor ? [koloftPrompt('muse')] : []),
      ...(role ? [role] : [])
    ]
    let bound: MuseRun | undefined
    const hold = this.deps.holdWhileBusy?.(tabId) ? this.deps.holdScript : undefined
    const tools = this.startTools(
      (target) => this.deps.events(tabId, { type: 'open', target }),
      (hook) => bound && this.onHook(bound, hook),
      agent && ((dir, name, raw) => agent.answer(bound?.tabId, dir, name, raw)),
      instructions.join('\n\n') || undefined,
      opts.ownerWords,
      hold && { ...hold, tabId },
      this.deps.hookRegDir ? { regDir: this.deps.hookRegDir, tabId } : undefined
    )
    const argv = this.museArgv(opts, approvalFlags(permission), trust)
    this.parsers.set(tabId, new ProgramStatusParser())
    try {
      const handle = this.deps.pty.create({
        id: tabId,
        kind: 'muse',
        koloftShim: false,
        cwd,
        cols: opts.cols,
        rows: opts.rows,
        executable: binary,
        argv,
        // MUSE§1
        banner,
        processEnv: {
          ...env,
          PATH: pathWithDirFirst(env.PATH, tools.dir),
          ...tools.env,
          ...browserControlEnv(tabId, endpoint)
        },
        resumeSessionId: opts.resumeSessionId,
        extraEnv: resource ? { KOLOFT_PORT_OFFSET: String(portOffset(resource.worktreeName)) } : {}
      })
      const run = this.newRun(ctx, handle, permission, account, {
        pid: this.deps.pty.pidOf(handle.id),
        releaseTools: () => {
          tools.release()
          this.parsers.delete(handle.id)
        }
      })
      bound = run
      this.keepSweeping()
      return run
    } catch (error) {
      this.parsers.delete(tabId)
      tools.release()
      throw error
    }
  }

  // MUSE§8 MUSE§9
  private startTools(
    open: (target: string) => void,
    hook: (hook: MuseHook) => void,
    agent: ((dir: string, name: string, raw: unknown) => void) | undefined,
    context: string | undefined,
    ownerWords: string | undefined,
    hold: MuseHold | undefined,
    relay: MuseRelayFiles | undefined
  ): { dir: string; env: Record<string, string>; release(): void } {
    const tools = startToolShim(
      { ...this.deps, ghWrapper: this.deps.gitAccounts.ghWrapper },
      {
        backend: 'muse',
        open,
        agent,
        drop: (name) =>
          name.startsWith(HOOK_DROP_PREFIX)
            ? (obj, full): void => {
                fs.rm(full, { force: true }, () => {})
                const parsed = museHook(obj)
                if (parsed) hook(parsed)
              }
            : null
      }
    )
    const { shimDir, requestDir } = tools.shim
    try {
      const playwright = Object.fromEntries(
        Object.entries(PLAYWRIGHT_DIRS).map(([name, dir]) => {
          const full = path.join(requestDir, dir)
          fs.mkdirSync(full, { recursive: true })
          return [name, full]
        })
      )
      const hooksFile = writeMuseHooks(shimDir, requestDir, context, ownerWords, hold, relay)
      return {
        dir: shimDir,
        env: { [MUSE_HOOKS_ENV]: hooksFile, ...playwright },
        release: tools.release
      }
    } catch (error) {
      tools.release()
      throw error
    }
  }

  // MUSE§9
  private onHook(run: MuseRun, hook: MuseHook): void {
    if (run.explicitStop || run.stopping) return
    const { input } = hook
    if (hook.event === 'SubagentStart' || hook.event === 'SubagentStop') {
      if (typeof input.child_session_id === 'string') run.children.add(input.child_session_id)
      const id = typeof input.subagent_id === 'string' ? input.subagent_id : ''
      if (!UUID.test(id)) return
      if (hook.event === 'SubagentStart')
        run.background.set(`agent:${id}`, {
          id: `agent:${id}`,
          kind: 'agent',
          label: `Agent ${id.slice(0, 8)}`,
          state: 'working'
        })
      else run.background.delete(`agent:${id}`)
      return this.publishBackground(run)
    }
    if (run.children.has(hook.sessionId)) return
    if (hook.event === 'SessionStart' || hook.event === 'UserPromptSubmit')
      this.bindTo(run, hook.sessionId)
    if (run.info?.nativeSessionId !== hook.sessionId) return
    switch (hook.event) {
      case 'UserPromptSubmit': {
        const text = typeof input.prompt === 'string' ? input.prompt : ''
        const turnId = typeof input.turn_id === 'string' ? input.turn_id : ''
        run.prompt = { turnId, text, at: Date.now() }
        if (text && run.info.title === PLACEHOLDER_TITLES.muse)
          this.retitle(run.info, text.slice(0, 100))
        return
      }
      case 'Stop':
      case 'StopFailure':
        this.readLog(run)
        return this.endTurn(
          run,
          typeof input.turn_id === 'string' ? input.turn_id : '',
          typeof input.last_assistant_message === 'string' ? input.last_assistant_message : ''
        )
      case 'PostToolUse':
        return this.afterTool(run, input)
      case 'PostToolUseFailure':
        return this.noteShellWrote(run, input)
    }
  }

  private endTurn(run: MuseRun, turnId: string, reply: string): void {
    if (!turnId || run.endedTurns.has(turnId)) return
    run.endedTurns.add(turnId)
    const prompt = run.prompt?.turnId === turnId ? run.prompt : undefined
    const at = Date.now()
    const turn: Turn = {
      said: prompt?.text ? [{ who: 'owner', text: prompt.text, at: prompt.at }] : [],
      reply,
      at
    }
    this.deps.events(run.tabId, { type: 'stop' })
    if (reply) this.deps.events(run.tabId, { type: 'turn-ended', turn })
    void this.markServers(run)
  }

  // MUSE§8
  private async markServers(run: MuseRun): Promise<void> {
    if (!run.pid || !run.commands.size) return
    const servers = await this.deps
      .serversAmong(run.pid, run.commands)
      .catch(() => new Set<string>())
    let changed = false
    for (const id of servers) {
      run.commands.delete(id)
      const item = run.background.get(id)
      if (item?.kind !== 'command') continue
      run.background.set(item.id, { ...item, kind: 'server', state: 'waiting' })
      changed = true
    }
    if (changed) this.publishBackground(run)
  }

  private publishWrite(run: MuseRun, last: string): void {
    this.deps.events(run.tabId, wroteEvent(run.touched, last, ++run.liveWrites))
  }

  private noteShellWrote(run: MuseRun, input: Record<string, unknown>): void {
    const wrote = shellWrittenFiles(input[SHELL_WROTE_FIELD]).map((f) => cwdRelative(run.cwd, f))
    if (!wrote.length) return
    for (const file of wrote) noteWrite(run.touched, file, 0, 0, Date.now())
    this.publishWrite(run, wrote[wrote.length - 1])
  }

  // MUSE§9
  private afterTool(run: MuseRun, input: Record<string, unknown>): void {
    const tool = String(input.tool_name)
    const response = responseOf(input)
    const did = museToolDid(tool, record(input.tool_input), response)
    if (did) this.deps.events(run.tabId, { type: 'did', what: did })
    this.noteShellWrote(run, input)
    if (WRITING_TOOLS.has(tool) && typeof response.filePath === 'string') {
      const target = cwdRelative(run.cwd, response.filePath)
      const { added, removed } = patchDelta(response)
      noteWrite(run.touched, target, added, removed, Date.now())
      this.publishWrite(run, target)
    } else if (tool === 'read_file' && typeof record(input.tool_input).path === 'string') {
      noteRead(run.touched, cwdRelative(run.cwd, String(record(input.tool_input).path)))
    } else if (
      tool === 'bash' &&
      response.execution_state === BACKGROUND_RUNNING &&
      typeof response.work_id === 'string'
    ) {
      const command = record(input.tool_input).command
      if (typeof command === 'string') run.commands.set(response.work_id, command)
      run.background.set(response.work_id, {
        id: response.work_id,
        kind: 'command',
        label: typeof command === 'string' ? command.slice(0, 160) : 'Background command',
        state: 'working'
      })
      this.publishBackground(run)
    } else if (tool === 'monitor' && typeof response.work_id === 'string') {
      const id = response.work_id
      const what = record(input.tool_input)
      run.background.set(id, {
        id,
        kind: 'monitor',
        label: String(what.description ?? what.command ?? 'Monitor').slice(0, 160),
        state: 'waiting'
      })
      this.publishBackground(run)
      if (response.persistent !== true && typeof response.timeout_ms === 'number')
        setTimeout(() => {
          if (run.background.delete(id)) this.publishBackground(run)
        }, response.timeout_ms).unref?.()
    } else if (tool === 'cron_create') {
      const job = SCHEDULED_JOB.exec(String(input.tool_response))?.[1]
      if (job) run.jobs.set(job, record(input.tool_input).recurring === true)
      this.holdForJobs(run)
    } else if (tool === 'cron_delete') {
      run.jobs.delete(String(record(input.tool_input).id))
      this.holdForJobs(run)
    }
  }

  // MUSE§9
  private holdForJobs(run: MuseRun): void {
    this.deps.runtime.setWakeupPending(run.tabId, run.jobs.size > 0)
  }

  private publishBackground(run: MuseRun): void {
    this.deps.events(run.tabId, { type: 'background-changed', items: [...run.background.values()] })
  }

  // MUSE§2
  private readLog(run: MuseRun): void {
    const id = run.info?.nativeSessionId
    if (!id || run.host) return
    if (run.log?.sessionId !== id) {
      const file = museSessionLog(this.env, id)
      if (!file) return
      const createdAt = this.history.get(run.info!.sessionId)?.createdAt
      const resumed = createdAt !== undefined && createdAt * 1000 < run.boundAt
      const from = resumed ? (fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) : 0
      run.log = {
        sessionId: id,
        tail: new SessionLogTail(file, (r) => this.onLogRecord(run, r), from)
      }
    }
    run.log.tail.read()
  }

  // MUSE§2 MUSE§5
  peerName(key: string): string | null {
    return this.history.get(key)?.museName ?? null
  }

  private onLogRecord(run: MuseRun, r: LogRecord): void {
    const named = museNameOf(r)
    const entry = run.info && named && this.history.get(run.info.sessionId)
    if (entry) entry.museName = named
    const name = renamedTo(r)
    if (name && run.info) return this.retitle(run.info, name, true)
    const work = finishedWork(r)
    if (work) run.commands.delete(work)
    if (work && run.background.delete(work)) this.publishBackground(run)
    const prompt = run.prompt
    const reply = replyIn(r)
    if (prompt && reply?.turnId === prompt.turnId) prompt.reply = reply.text
    if (prompt && turnEndedIn(r) === prompt.turnId)
      this.endTurn(run, prompt.turnId, prompt.reply ?? '')
    const job = firedJob(r)
    if (job && run.jobs.get(job) === false) {
      run.jobs.delete(job)
      this.holdForJobs(run)
    }
    if ((r.atMs ?? 0) < run.boundAt) return
    if (startsATurnByItself(r) || compactionStarts(r)) this.emitState(run, { state: 'working' })
    else if (compactionEnds(r)) this.emitState(run, { state: 'done' })
  }

  // MUSE§3
  private onData(tabId: string, data: string): void {
    const parser = this.parsers.get(tabId)
    if (!parser) return
    const { asked, states } = parser.push(data)
    const run = this.runs.get(tabId)
    if (asked && !run?.host) this.deps.pty.write(tabId, PROGRAM_STATUS_REPLY)
    if (run) this.applyStates(run, states)
  }

  // MUSE§17
  private freshStates(run: MuseRun, states: ProgramStatus[]): ProgramStatus[] {
    if (!run.host) return states
    return states.filter((status) => {
      if (status.seq === undefined) return true
      if (!(status.seq > run.lastSeq)) return false
      run.lastSeq = status.seq
      return true
    })
  }

  private applyStates(run: MuseRun, arrived: ProgramStatus[]): void {
    if (run.explicitStop) return
    const states = this.freshStates(run, arrived)
    if (states.length === 0) return
    for (const status of states) {
      if (status.state !== 'clear') run.sinceClear = [...run.sinceClear, status].slice(-2)
      else {
        run.sinceClear = []
        this.registrySeenAt = undefined
      }
    }
    if (!run.host) {
      this.readLog(run)
      if (this.sweepRegistry().has(run)) return
    }
    if (!run.info) return
    for (const status of states) if (status.state !== 'clear') this.emitState(run, status)
  }

  // MUSE§17
  followMirrors(host: string): void {
    for (const run of this.runs.values()) {
      if (run.host !== host || run.explicitStop || run.stopping) continue
      if (run.attachTo && !run.info) this.bindTo(run, run.attachTo)
      if (!run.mirror && run.attachTo) {
        const pointer = path.join(
          this.deps.remote!.mirrorDir(run.host),
          tmuxSessionName(run.attachTo) + RUN_POINTER_SUFFIX
        )
        const runId = textOrEmpty(pointer)
        if (runId) run.mirror = { runId, tail: this.mirrorTail(run, runId), replay: [] }
      }
      const mirror = run.mirror
      if (!mirror) continue
      mirror.tail.read()
      if (mirror.replay?.length) {
        const lines = mirror.replay
        mirror.replay = undefined
        this.replayMirror(run, lines.map(mirrorLine))
      }
    }
  }

  private replayMirror(run: MuseRun, lines: (Record<string, unknown> | undefined)[]): void {
    const bound = lines.filter((l) => l?.t === 'bound').at(-1)
    if (bound) this.onMirrorLine(run, bound)
    const states = lines.filter((l) => l?.t === 'state' && typeof l.seq === 'number')
    const last = states.sort((a, b) => Number(a!.seq) - Number(b!.seq)).at(-1)
    if (last) this.onMirrorLine(run, last)
  }

  private onMirrorLine(run: MuseRun, line: Record<string, unknown> | undefined): void {
    if (!line || run.explicitStop) return
    if (line.t === 'bound' && typeof line.sessionId === 'string' && UUID.test(line.sessionId)) {
      this.bindTo(run, line.sessionId)
      run.tmuxName = tmuxSessionName(line.sessionId)
      if (run.host) this.deps.remote?.poke(run.host)
    } else if (line.t === 'state' && typeof line.state === 'string') {
      const kind = typeof line.kind === 'string' ? line.kind : undefined
      this.applyStates(run, [{ state: line.state, kind, seq: Number(line.seq) }])
    } else if (line.t === 'hook') {
      const hook = museHook(line)
      if (hook) this.onHook(run, hook)
    } else if (line.t === 'log' && typeof line.payloadType === 'string') {
      const aNewerStateCameFirst = Number(line.seq) < run.lastSeq
      this.onLogRecord(run, {
        payloadType: line.payloadType,
        payload: record(line.payload),
        atMs: aNewerStateCameFirst ? 0 : Date.now()
      })
    }
  }

  protected async endRun(run: MuseRun): Promise<void> {
    if (!run.host || !run.tmuxName || this.shuttingDown) return
    const machine = this.deps.remote?.machine(run.host)
    const runId = run.mirror?.runId
    const named = runId && (await machine?.runScript(TAB_TMUX_NAME_SH, [runId]))
    const problem = await machine?.endTmuxSession(named?.trim() || run.tmuxName)
    if (problem)
      this.deps.error(`Could not stop Muse on ${run.host}: ${problem}. It is still running there.`)
    this.deps.remote?.poke(run.host)
  }

  noticeRemoteExits(host: string, sessionIds: string[]): void {
    for (const run of this.runs.values()) {
      const sid = run.info?.nativeSessionId
      if (run.host !== host || !sid || !sessionIds.includes(sid)) continue
      setTimeout(() => {
        const still = this.runs.get(run.tabId) === run && run.info?.nativeSessionId === sid
        if (!still || !this.deps.remote?.gone(host, sid)) return
        void this.stop(run.tabId, 1).catch((error) => this.deps.error(String(error)))
      }, REMOTE_EXIT_WAIT_MS).unref()
    }
  }

  tabOnMachine(host: string, tmuxName: string, launchTab: string): string | undefined {
    for (const run of this.runs.values()) {
      if (run.host !== host || run.explicitStop) continue
      if ((tmuxName && run.tmuxName === tmuxName) || run.tabId === launchTab) return run.tabId
    }
    return undefined
  }

  private emitState(run: MuseRun, status: ProgramStatus): void {
    if (status.state === 'blocked') this.readAsk(run)
    else run.waiting = undefined
    const event = statusEvent(status)
    if (event) this.deps.events(run.tabId, event)
  }

  // MUSE§5 MUSE§11
  private readAsk(run: MuseRun): void {
    const sessionId = run.info?.nativeSessionId
    if (!sessionId || (!run.host && !this.binary)) return
    const waiting = { since: Date.now(), ask: {} as MuseAsk }
    run.waiting = waiting
    void readMuseAsk(this.serveFor(run.info!.sessionId), sessionId)
      .then((ask) => {
        if (run.waiting !== waiting) return
        waiting.ask = ask
        this.changedSoon()
      })
      .catch(() => undefined)
  }

  openApproval(tabId: string): CodexApproval | undefined {
    return this.runs.get(tabId)?.waiting?.ask.approval
  }

  openQuestion(tabId: string): CodexQuestion | undefined {
    return this.runs.get(tabId)?.waiting?.ask.question
  }

  // MUSE§11
  async answerable(tabId: string): Promise<void> {
    const since = this.runs.get(tabId)?.waiting?.since
    if (since !== undefined) await sleep(since + KEYS_TAKE_AFTER_A_DIALOG_SHOWS_MS - Date.now())
  }

  // MUSE§4 MUSE§9
  private bindTo(run: MuseRun, sessionId: string): boolean {
    if (run.info?.nativeSessionId === sessionId) return false
    const key = museSessionKey(sessionId, run.host)
    const known = this.history.get(key)
    const switched = !!known && (known.createdAt ?? 0) * 1000 < run.boundAt
    if (run.info) run.boundAt = Date.now()
    run.prompt = undefined
    run.children.clear()
    run.background.clear()
    run.commands.clear()
    run.jobs.clear()
    this.holdForJobs(run)
    run.endedTurns.clear()
    run.touched.clear()
    run.liveWrites = 0
    run.log = undefined
    this.bind(
      run,
      known ?? { id: sessionId, cwd: run.cwd, updatedAt: Date.now() / 1000 },
      switched ? 'switch' : 'replace'
    )
    this.readLog(run)
    for (const status of run.sinceClear) this.emitState(run, status)
    return true
  }

  // MUSE§4
  private sweepRegistry(): Set<MuseRun> {
    const rebound = new Set<MuseRun>()
    const live = [...this.runs.values()].filter(
      (r) => !r.explicitStop && !r.stopping && r.pid !== undefined
    )
    if (live.length === 0) {
      clearInterval(this.sweeping)
      this.sweeping = undefined
      return rebound
    }
    const dirs = registryDirs(this.env).flatMap((dir) => {
      const changed = fs.statSync(dir, { throwIfNoEntry: false })?.mtimeMs
      return changed === undefined ? [] : [{ dir, changed }]
    })
    if (!dirs.length) return rebound
    const changedAt = Math.max(...dirs.map((d) => d.changed))
    if (changedAt === this.registrySeenAt && live.every((r) => r.info)) return rebound
    const since = (run: MuseRun): number => run.startedAt - REGISTRY_WRITE_LEEWAY_MS
    const pids = new Set(live.map((r) => r.pid!))
    const oldest = Math.min(...live.map(since))
    const read = dirs.map(({ dir }) => readRegistry(dir, pids, oldest))
    const entries = read.flatMap((r) => r.entries)
    if (read.every((r) => r.whole)) this.registrySeenAt = changedAt
    for (const run of live) {
      const mine = entries
        .filter((e) => e.pid === run.pid && e.mtimeMs >= since(run))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
      if (mine && this.bindTo(run, mine.sessionId)) rebound.add(run)
    }
    return rebound
  }

  private followLogs(): void {
    for (const run of this.runs.values())
      if (!run.explicitStop && run.info && !run.host) this.readLog(run)
  }
}
