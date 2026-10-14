import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import type { BackgroundItem, LaunchPermission } from '@shared/types'
import { PLACEHOLDER_TITLES } from '@shared/types'
import type { Turn } from '@shared/turns'
import { koloftPrompt } from '@shared/agentGuide'
import { portOffset } from '@shared/worktreeName'
import { resolveCliRuntime, type CliRuntime, type CliSpec } from './cliRuntime'
import { MIN_MUSE_VERSION, TESTED_MUSE_LINE } from './cliMinimums'
import { isNewer } from './releaseNotes'
import { record } from './codexObservation'
import { oncePerName, watchJsonDrops, writeWholeBeforeVisible } from './jsonDrops'
import { openDropHandler } from './openDrop'
import { removeOpenShim, writeOpenShim } from './openShimScript'
import { writeCodexAgentShim } from './agentShim'
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
  type MuseHook
} from './museHooks'
import {
  SessionLogTail,
  finishedWork,
  museHome,
  museSessionLog,
  renamedTo,
  saidInLog,
  type LogRecord
} from './museSessionLog'
import { capTouched, noteWrite, touchedItem, type FileAcc } from './touchedFiles'
import { UUID, museSessionKey } from './sessionStore'
import {
  listMuseSessions,
  readMuseAsk,
  readMuseTurns,
  type MuseAsk,
  type MuseHistory
} from './museServe'
import { sleep } from './codexTransport'
import type { CodexApproval, CodexQuestion } from './discord/dialog'
import { pathWithDirFirst } from './toolInstall'
import { realpathSafe } from './projectInfo'
import {
  StoredSessions,
  type HistoryEntry,
  type StartContext,
  type StoredRun,
  type StoredSessionDeps
} from './storedSessions'

const exec = promisify(execFile)

export interface MuseSessionDeps extends StoredSessionDeps {
  openShimRoot: string
  playwrightBin: string
  browserEndpoint(tabId: string): string
  agent: {
    enabled(): boolean
    answer(tabId: string | undefined, dir: string, name: string, raw: unknown): void
  }
  gitAccounts: StoredSessionDeps['gitAccounts'] & {
    picked(cwd: string): Promise<boolean>
    ghWrapper: string
  }
}

interface MuseRun extends StoredRun {
  pid?: number
  startedAt: number
  boundAt: number
  sinceClear: ProgramStatus[]
  prompt?: { turnId: string; text: string; at: number }
  endedTurns: Set<string>
  children: Set<string>
  background: Map<string, BackgroundItem>
  touched: Map<string, FileAcc>
  liveWrites: number
  log?: { sessionId: string; tail: SessionLogTail }
  waiting?: { since: number; ask: MuseAsk }
}

// MUSE§11
const KEYS_TAKE_AFTER_A_DIALOG_SHOWS_MS = 2000

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

// MUSE§15
function approvalFlags(permission: LaunchPermission, networkOpen: boolean): string[] {
  if (permission === 'bypass') return ['--permission-profile', ':unrestricted']
  return ['--approval-judge', 'off', ...(networkOpen ? ['--sandbox-network', 'enabled'] : [])]
}

// MUSE§8
const PLAYWRIGHT_DIRS = {
  PWTEST_DAEMON_SESSION_DIR: 'pw-daemon',
  PWTEST_SOCKETS_DIR: 'pw-sockets',
  PWTEST_SERVER_REGISTRY: 'pw-registry'
} as const

// MUSE§4
const REGISTRY_SWEEP_MS = 500

// MUSE§9
const BACKGROUND_RUNNING = 'background_running'
const WRITING_TOOLS = new Set(['write_file', 'edit_file'])

// MUSE§4
function registryDir(env: NodeJS.ProcessEnv): string {
  return path.join(museHome(env), 'runtime', 'muse', 'sessions')
}

// MUSE§2 MUSE§10
function trustFile(env: NodeJS.ProcessEnv): string {
  const config = env.XDG_CONFIG_HOME || path.join(env.HOME || '', '.config')
  return path.join(config, 'muse', 'trust.json')
}

function readTrust(env: NodeJS.ProcessEnv): Record<string, unknown> {
  try {
    return record(JSON.parse(fs.readFileSync(trustFile(env), 'utf8')))
  } catch {
    return {}
  }
}

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
function readRegistry(
  dir: string,
  pids: Set<number>
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
      const entry = record(JSON.parse(fs.readFileSync(full, 'utf8')))
      const pid = Number(/^pid=(\d+)$/.exec(String(entry.process_generation_hint))?.[1])
      if (entry.schema_version !== 1 || typeof entry.session_id !== 'string') return []
      if (!UUID.test(entry.session_id) || !pids.has(pid)) return []
      return [{ sessionId: entry.session_id, pid, mtimeMs: fs.statSync(full).mtimeMs }]
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

export class MuseSessions extends StoredSessions<MuseRun, HistoryEntry, string> {
  readonly id = 'muse'
  private parsers = new Map<string, ProgramStatusParser>()
  private sweeping?: ReturnType<typeof setInterval>
  private registrySeenAt?: number
  private unreadable = new Set<string>()
  private updateTried = false

  constructor(
    file: string,
    protected deps: MuseSessionDeps
  ) {
    super(file, museSessionKey, deps)
    deps.pty.on('data', ({ id, data }: { id: string; data: string }) => this.onData(id, data))
  }

  // MUSE§14
  protected async resolveRuntime(): Promise<CliRuntime> {
    let runtime = await resolveCliRuntime(MUSE)
    if (!isNewer(MIN_MUSE_VERSION, runtime.version)) return runtime
    const updating = !this.updateTried
    if (updating) {
      this.updateTried = true
      this.deps.error(
        `Muse Code ${runtime.version} is older than ${MIN_MUSE_VERSION}, the oldest this Koloft supports. Updating it now…`
      )
      await exec(runtime.binary, ['--version'], {
        env: { ...runtime.env, MUSE_SYNC_UPDATE: '1' },
        timeout: MUSE_UPDATE_TIMEOUT_MS
      }).catch(() => undefined)
      runtime = await resolveCliRuntime(MUSE)
      if (!isNewer(MIN_MUSE_VERSION, runtime.version)) return runtime
    }
    const stillOld = `Koloft needs Muse Code ${MIN_MUSE_VERSION} or newer, and this Mac has ${runtime.version}. Run "muse --version" with a working network to update it, then try again.`
    if (updating) this.deps.error(stillOld)
    throw new Error(stillOld)
  }

  protected untestedNotice(version: string): string {
    return `Muse Code ${version} is newer than the version Koloft was tested with (${TESTED_MUSE_LINE}.x). It may misbehave.`
  }

  private get env(): NodeJS.ProcessEnv {
    return this.processEnv ?? process.env
  }

  // MUSE§2
  async searchSnippets(term: string): Promise<{ id: string; snippet: string }[]> {
    const wanted = term.toLowerCase()
    const found: { id: string; snippet: string }[] = []
    for (const key of this.history.keys()) {
      const file = museSessionLog(this.env, this.nativeId(key))
      if (!file) continue
      let hit: string | undefined
      await saidInLog(file, (text) => {
        if (!text.toLowerCase().includes(wanted)) return false
        hit = text
        return true
      }).catch(() => undefined)
      if (hit) found.push({ id: key, snippet: hit })
    }
    return found
  }

  trustsFolder(dir: string): boolean {
    return museTrustsFolder(this.env, dir)
  }

  private serveOptions(): { binary: string; env: NodeJS.ProcessEnv } {
    if (!this.binary) throw new Error('Muse Code is unavailable.')
    return { binary: this.binary, env: this.env }
  }

  protected async listHistory(): Promise<
    { key: string; entry: HistoryEntry; archived: boolean }[]
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
    return (await this.readHistoryOf(key, n))?.turns ?? []
  }

  private async readHistoryOf(key: string, n: number): Promise<MuseHistory | undefined> {
    if (!this.binary && !(await this.availability()).available) return undefined
    try {
      return await readMuseTurns(this.serveOptions(), this.nativeId(key), n)
    } catch (error) {
      if (!this.unreadable.has(key)) {
        this.unreadable.add(key)
        this.deps.error(
          `Koloft could not read this Muse session's messages: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      return undefined
    }
  }

  protected prepare(): string {
    return this.binary!
  }

  protected async startRun(
    { opts, cwd, workspace, resource, freshWorktree }: StartContext,
    binary: string
  ): Promise<MuseRun> {
    const env = this.env
    // ADR-0026 MUSE§10
    if (freshWorktree) for (const dir of [workspace, cwd]) trustMuseFolder(env, dir)
    if (opts.trustFolder) trustMuseFolder(env, cwd)
    const trust = !!resource && this.trustsFolder(workspace)
    const tabId = this.deps.pty.nextId()
    const endpoint = this.deps.browserEndpoint(tabId)
    // MUSE§8
    const networkOpen = !!endpoint || (await this.deps.gitAccounts.picked(cwd))
    this.assertStarting()
    const permission = opts.permission ?? 'default'
    const agent = this.deps.agent.enabled() ? this.deps.agent : undefined
    let bound: MuseRun | undefined
    const tools = this.startTools(
      (target) => this.deps.events(tabId, { type: 'open', target }),
      (hook) => bound && this.onHook(bound, hook),
      agent && ((dir, name, raw) => agent.answer(bound?.tabId, dir, name, raw)),
      agent ? koloftPrompt('muse') : undefined
    )
    const argv = [
      ...(opts.model ? ['--model', opts.model] : []),
      ...(opts.effort ? ['--reasoning-effort', opts.effort] : []),
      ...approvalFlags(permission, networkOpen),
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
        processEnv: { ...env, PATH: pathWithDirFirst(env.PATH, tools.dir) },
        resumeSessionId: opts.resumeSessionId,
        extraEnv: {
          ...tools.env,
          ...browserControlEnv(tabId, endpoint),
          ...(resource && { KOLOFT_PORT_OFFSET: String(portOffset(resource.worktreeName)) })
        }
      })
      const run: MuseRun = {
        tabId: handle.id,
        cwd,
        workspace,
        resource,
        explicitStop: false,
        resumeKey: opts.resumeSessionId,
        permission,
        pid: this.deps.pty.pidOf(handle.id),
        startedAt: handle.startedAt,
        boundAt: handle.startedAt,
        sinceClear: [],
        endedTurns: new Set(),
        children: new Set(),
        background: new Map(),
        touched: new Map(),
        liveWrites: 0,
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
    context: string | undefined
  ): { dir: string; env: Record<string, string>; release(): void } {
    const shim = writeOpenShim(this.deps.openShimRoot, randomUUID(), undefined)
    try {
      fs.symlinkSync(
        path.join(this.deps.playwrightBin, 'playwright-cli'),
        path.join(shim.shimDir, 'playwright-cli')
      )
      // PLATFORM§2
      if (this.deps.gitBin)
        fs.symlinkSync(path.join(this.deps.gitBin, 'git'), path.join(shim.shimDir, 'git'))
      fs.symlinkSync(this.deps.gitAccounts.ghWrapper, path.join(shim.shimDir, 'gh'))
      if (agent) writeCodexAgentShim(shim.shimDir, shim.requestDir)
      const playwright = Object.fromEntries(
        Object.entries(PLAYWRIGHT_DIRS).map(([name, dir]) => {
          const full = path.join(shim.requestDir, dir)
          fs.mkdirSync(full, { recursive: true })
          return [name, full]
        })
      )
      const hooksFile = writeMuseHooks(shim.shimDir, shim.requestDir, context)
      const opens = oncePerName(() => openDropHandler(open))
      const drops = watchJsonDrops(shim.requestDir, (name) => {
        if (name.startsWith('req-'))
          return agent ? (obj): void => agent(shim.requestDir, name, obj) : null
        if (name.startsWith('res-')) return null
        if (name.startsWith(HOOK_DROP_PREFIX))
          return (obj, full): void => {
            fs.rm(full, { force: true }, () => {})
            const parsed = museHook(obj)
            if (parsed) hook(parsed)
          }
        return opens(name)
      })
      return {
        dir: shim.shimDir,
        env: { [MUSE_HOOKS_ENV]: hooksFile, ...playwright },
        release: () => {
          drops?.close()
          removeOpenShim(shim)
        }
      }
    } catch (error) {
      removeOpenShim(shim)
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
        return this.endTurn(run, input)
      case 'PostToolUse':
        return this.afterTool(run, input)
    }
  }

  private endTurn(run: MuseRun, input: Record<string, unknown>): void {
    const turnId = typeof input.turn_id === 'string' ? input.turn_id : ''
    if (!turnId || run.endedTurns.has(turnId)) return
    run.endedTurns.add(turnId)
    const reply =
      typeof input.last_assistant_message === 'string' ? input.last_assistant_message : ''
    const prompt = run.prompt?.turnId === turnId ? run.prompt : undefined
    const at = Date.now()
    const turn: Turn = {
      said: prompt?.text ? [{ who: 'owner', text: prompt.text, at: prompt.at }] : [],
      reply,
      at
    }
    this.deps.events(run.tabId, { type: 'stop' })
    if (reply) this.deps.events(run.tabId, { type: 'turn-ended', turn })
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
    } else if (
      tool === 'bash' &&
      response.execution_state === BACKGROUND_RUNNING &&
      typeof response.work_id === 'string'
    ) {
      const command = record(input.tool_input).command
      run.background.set(response.work_id, {
        id: response.work_id,
        kind: 'command',
        label: typeof command === 'string' ? command.slice(0, 160) : 'Background command',
        state: 'working'
      })
      this.publishBackground(run)
    }
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
      run.log = { sessionId: id, tail: new SessionLogTail(file, (r) => this.onLogRecord(run, r)) }
    }
    run.log.tail.read()
  }

  private onLogRecord(run: MuseRun, r: LogRecord): void {
    const name = renamedTo(r)
    if (name && run.info) return this.retitle(run.info, name)
    const work = finishedWork(r)
    if (work && run.background.delete(work)) this.publishBackground(run)
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
    run.log = undefined
    this.bind(run, known ?? { id: sessionId, cwd: run.cwd }, switched ? 'switch' : 'replace')
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
    const { entries, whole } = readRegistry(dir, new Set(live.map((r) => r.pid!)))
    if (whole) this.registrySeenAt = changedAt
    for (const run of live) {
      const mine = entries
        .filter((e) => e.pid === run.pid && e.mtimeMs >= run.startedAt - 1000)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
      if (mine && this.bindTo(run, mine.sessionId)) rebound.add(run)
    }
    return rebound
  }

  private followLogs(): void {
    for (const run of this.runs.values()) if (!run.explicitStop && run.info) this.readLog(run)
  }
}
