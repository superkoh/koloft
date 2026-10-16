import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type {
  BackendSessionInfo,
  BackgroundItem,
  CreateTabOptions,
  LaunchPermission
} from '@shared/types'
import { NO_USABLE_ACCOUNT } from '@shared/accountUsage'
import { PLACEHOLDER_TITLES } from '@shared/types'
import type { Turn } from '@shared/turns'
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
import { browserControlEnv } from './browserControlEnv'
import { allowsTheBrowser, conductorGateCommand } from './conductorGate'
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
  type MuseHook
} from './museHooks'
import {
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
  type LogRecord
} from './museSessionLog'
import { capTouched, noteRead, noteWrite, touchedItem, type FileAcc } from './touchedFiles'
import { UUID, museSessionKey } from './sessionStore'
import {
  listMuseSessions,
  readMuseAsk,
  readMuseTurns,
  type MuseAsk,
  type MuseHistoryEntry
} from './museServe'
import { sleep } from './codexTransport'
import type { CodexApproval, CodexQuestion } from './discord/dialog'
import { pathWithDirFirst } from './toolInstall'
import { realpathSafe } from './projectInfo'
import {
  StoredSessions,
  type StartContext,
  type StoredRun,
  type StoredSessionDeps
} from './storedSessions'

const exec = promisify(execFile)

export interface MuseSessionDeps extends StoredSessionDeps {
  openShimRoot: string
  pickHome(resumeSessionId?: string): { account: string; env: Record<string, string> } | undefined
  playwrightBin: string
  browserEndpoint(tabId: string): string
  assistOf(cwd: string, resumeKey?: string): { role: string; allow: string[] } | undefined
  conductorGate: { script: string; writeAllow(tabId: string, allow: string[]): string }
  skipPermissions(): boolean
  serversAmong(pid: number, commands: Map<string, string>): Promise<Set<string>>
  agent: {
    enabled(): boolean
    answer(tabId: string | undefined, dir: string, name: string, raw: unknown): void
  }
  gitAccounts: StoredSessionDeps['gitAccounts'] & { ghWrapper: string }
}

interface MuseLaunch {
  binary: string
  account: string
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
}

// MUSE§11
const KEYS_TAKE_AFTER_A_DIALOG_SHOWS_MS = 2000

const INPUT_BOX_RULE = /^─{8,}$/
const EMPTY_INPUT_ROW = '❯'

// MUSE§11
export function museShowsAnEmptyInputBox(lines: string[]): boolean {
  const rules = lines.flatMap((line, i) => (INPUT_BOX_RULE.test(line.trim()) ? [i] : []))
  if (rules.length < 2) return false
  const [above, below] = rules.slice(-2)
  return below === above + 2 && lines[above + 1].trim() === EMPTY_INPUT_ROW
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

// ADR-0029 ADR-0038 MUSE§15
function approvalFlags(permission: LaunchPermission | 'conductor'): string[] {
  if (permission === 'bypass') return ['--permission-profile', ':unrestricted']
  return [
    ...(permission === 'conductor' ? ['--approval-mode', 'never'] : ['--approval-judge', 'off']),
    '--sandbox-network',
    'enabled'
  ]
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
function registryDir(env: NodeJS.ProcessEnv): string {
  return path.join(museHome(env), 'runtime', 'muse', 'sessions')
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
    const hits = await mapAtMost([...this.history.keys()], LOGS_SEARCHED_AT_ONCE, async (key) => {
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
    return hits.filter((h): h is { id: string; snippet: string } => !!h)
  }

  trustsFolder(dir: string): boolean {
    return museTrustsFolder(this.env, dir)
  }

  // MUSE§4
  runningElsewhere(key: string): boolean {
    const pid = registryPid(
      readJson(path.join(registryDir(this.env), `${this.nativeId(key)}.json`))
    )
    const ours = [...this.runs.values()].some((r) => r.pid === pid)
    return pid > 0 && !ours && pidAlive(pid)
  }

  private serveOptions(): { binary: string; env: NodeJS.ProcessEnv } {
    if (!this.binary) throw new Error('Muse Code is unavailable.')
    return { binary: this.binary, env: this.env }
  }

  protected async listHistory(): Promise<
    { key: string; entry: MuseHistoryEntry; archived: boolean }[]
  > {
    const sessions = await listMuseSessions(this.serveOptions())
    return sessions.map((entry) => ({ key: museSessionKey(entry.id), entry, archived: false }))
  }

  async transcriptExists(key: string): Promise<boolean> {
    if (!this.history.has(key)) await this.refreshHistory()
    return this.history.has(key)
  }

  // MUSE§5
  async readTurns(key: string, n: number): Promise<Turn[]> {
    if (!this.binary && !(await this.availability()).available) return []
    try {
      const turns = await readMuseTurns(this.serveOptions(), this.nativeId(key), n)
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

  get cliBinary(): string | undefined {
    return this.binary
  }

  protected prepare(opts: CreateTabOptions): MuseLaunch {
    // ADR-0030 MUSE§13
    const picked = this.deps.pickHome(opts.resumeSessionId)
    if (!picked) throw new Error(NO_USABLE_ACCOUNT.muse)
    return { binary: this.binary!, account: picked.account, env: { ...this.env, ...picked.env } }
  }

  protected runDetails(run: MuseRun): Pick<BackendSessionInfo, 'details' | 'pickedAccount'> {
    return { pickedAccount: run.account }
  }

  protected async startRun(
    { opts, cwd, workspace, resource, freshWorktree }: StartContext,
    { binary, account, env }: MuseLaunch
  ): Promise<MuseRun> {
    // ADR-0026 MUSE§10
    if (freshWorktree) for (const dir of [workspace, cwd]) trustMuseFolder(env, dir)
    // ADR-0029
    const assist = this.deps.assistOf(cwd, opts.resumeSessionId)
    const conductor = opts.conductor || !!assist
    const role = opts.role ?? assist?.role
    const allow = opts.allow ?? assist?.allow ?? []
    if (opts.trustFolder || assist) trustMuseFolder(env, cwd)
    const trust = !!resource && this.trustsFolder(workspace)
    const tabId = this.deps.pty.nextId()
    const endpoint = conductor && !allowsTheBrowser(allow) ? '' : this.deps.browserEndpoint(tabId)
    this.assertStarting()
    const asked = opts.permission ?? 'default'
    const permission = asked === 'default' && this.deps.skipPermissions() ? 'bypass' : asked
    const agent = this.deps.agent.enabled() ? this.deps.agent : undefined
    if (env.XDG_CONFIG_HOME)
      placeKoloftSkill(env.XDG_CONFIG_HOME, agent ? agentSkillMarkdown() : undefined)
    const instructions = [
      ...(agent && !conductor ? [koloftPrompt('muse')] : []),
      ...(role ? [role] : [])
    ]
    let bound: MuseRun | undefined
    const tools = this.startTools(
      (target) => this.deps.events(tabId, { type: 'open', target }),
      (hook) => bound && this.onHook(bound, hook),
      agent && ((dir, name, raw) => agent.answer(bound?.tabId, dir, name, raw)),
      instructions.join('\n\n') || undefined,
      conductor
        ? conductorGateCommand(
            this.deps.conductorGate.script,
            this.deps.conductorGate.writeAllow(tabId, allow)
          )
        : undefined
    )
    const argv = [
      ...(opts.model ? ['--model', opts.model] : []),
      ...(opts.effort ? ['--reasoning-effort', opts.effort] : []),
      ...approvalFlags(conductor ? 'conductor' : permission),
      ...(trust ? ['--trust-workspace'] : []),
      ...(opts.resumeSessionId
        ? ['resume', this.nativeId(opts.resumeSessionId)]
        : opts.firstPrompt
          ? [opts.firstPrompt]
          : [])
    ]
    this.parsers.set(tabId, new ProgramStatusParser())
    try {
      const handle = this.deps.pty.create({
        id: tabId,
        kind: 'muse',
        cwd,
        cols: opts.cols,
        rows: opts.rows,
        executable: binary,
        argv,
        processEnv: {
          ...env,
          PATH: pathWithDirFirst(env.PATH, tools.dir),
          ...tools.env,
          ...browserControlEnv(tabId, endpoint)
        },
        resumeSessionId: opts.resumeSessionId,
        extraEnv: resource ? { KOLOFT_PORT_OFFSET: String(portOffset(resource.worktreeName)) } : {}
      })
      const run: MuseRun = {
        tabId: handle.id,
        cwd,
        workspace,
        resource,
        explicitStop: false,
        resumeKey: opts.resumeSessionId,
        permission,
        launchName: opts.name,
        account,
        pid: this.deps.pty.pidOf(handle.id),
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
        releaseTools: () => {
          tools.release()
          this.parsers.delete(handle.id)
        }
      }
      bound = run
      this.sweeping ??= setInterval(() => {
        this.sweepRegistry()
        this.followLogs()
      }, REGISTRY_SWEEP_MS)
      this.sweeping.unref?.()
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
    gate: string | undefined
  ): { dir: string; env: Record<string, string>; release(): void } {
    const tools = startToolShim(
      { ...this.deps, ghWrapper: this.deps.gitAccounts.ghWrapper },
      {
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
      const hooksFile = writeMuseHooks(shimDir, requestDir, context, gate)
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

  // MUSE§9
  private afterTool(run: MuseRun, input: Record<string, unknown>): void {
    const tool = String(input.tool_name)
    const response = responseOf(input)
    if (WRITING_TOOLS.has(tool) && typeof response.filePath === 'string') {
      const target = path.resolve(run.cwd, response.filePath)
      const { added, removed } = patchDelta(response)
      noteWrite(run.touched, target, added, removed, Date.now())
      run.liveWrites++
      this.deps.events(run.tabId, {
        type: 'files-changed',
        files: capTouched([...run.touched].map(([src, acc]) => touchedItem(src, acc))),
        lastTouched: target,
        lastWritten: target,
        liveWrites: run.liveWrites
      })
    } else if (tool === 'read_file' && typeof record(input.tool_input).path === 'string') {
      noteRead(run.touched, path.resolve(run.cwd, String(record(input.tool_input).path)))
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
    if (!id) return
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
    if (name && run.info) return this.retitle(run.info, name)
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
    if (asked) this.deps.pty.write(tabId, PROGRAM_STATUS_REPLY)
    const run = this.runs.get(tabId)
    if (!run || run.explicitStop || states.length === 0) return
    for (const status of states) {
      if (status.state !== 'clear') run.sinceClear = [...run.sinceClear, status].slice(-2)
      else {
        run.sinceClear = []
        this.registrySeenAt = undefined
      }
    }
    this.readLog(run)
    if (this.sweepRegistry().has(run) || !run.info) return
    for (const status of states) if (status.state !== 'clear') this.emitState(run, status)
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
    if (!sessionId || !this.binary) return
    const waiting = { since: Date.now(), ask: {} as MuseAsk }
    run.waiting = waiting
    void readMuseAsk(this.serveOptions(), sessionId)
      .then((ask) => {
        if (run.waiting === waiting) waiting.ask = ask
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
    const key = museSessionKey(sessionId)
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
    run.log = undefined
    this.bind(run, known ?? { id: sessionId, cwd: run.cwd }, switched ? 'switch' : 'replace')
    this.readLog(run)
    for (const status of run.sinceClear) this.emitState(run, status)
    return true
  }

  // MUSE§4
  private sweepRegistry(): Set<MuseRun> {
    const rebound = new Set<MuseRun>()
    if (this.runs.size === 0 && this.sweeping) {
      clearInterval(this.sweeping)
      this.sweeping = undefined
      return rebound
    }
    const dir = registryDir(this.env)
    let changedAt: number
    try {
      changedAt = fs.statSync(dir).mtimeMs
    } catch {
      return rebound
    }
    const unbound = [...this.runs.values()].some((r) => !r.info && !r.explicitStop)
    if (changedAt === this.registrySeenAt && !unbound) return rebound
    const live = [...this.runs.values()].filter(
      (r) => !r.explicitStop && !r.stopping && r.pid !== undefined
    )
    const since = (run: MuseRun): number => run.startedAt - REGISTRY_WRITE_LEEWAY_MS
    const { entries, whole } = readRegistry(
      dir,
      new Set(live.map((r) => r.pid!)),
      Math.min(...live.map(since))
    )
    if (whole) this.registrySeenAt = changedAt
    for (const run of live) {
      const mine = entries
        .filter((e) => e.pid === run.pid && e.mtimeMs >= since(run))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
      if (mine && this.bindTo(run, mine.sessionId)) rebound.add(run)
    }
    return rebound
  }

  private followLogs(): void {
    for (const run of this.runs.values()) if (!run.explicitStop && run.info) this.readLog(run)
  }
}
