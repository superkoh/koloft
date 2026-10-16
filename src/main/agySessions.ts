import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { promisify } from 'util'
import type {
  BackendSessionInfo,
  BackgroundItem,
  CreateTabOptions,
  LaunchPermission
} from '@shared/types'
import { NO_USABLE_ACCOUNT } from '@shared/accountUsage'
import type { Turn } from '@shared/turns'
import { koloftPrompt } from '@shared/agentGuide'
import { portOffset } from '@shared/worktreeName'
import { costUsdOf, resolvePricing } from '@shared/pricing'
import { resolveCliRuntime, type CliRuntime, type CliSpec } from './cliRuntime'
import { MIN_AGY_VERSION, TESTED_AGY_LINE } from './cliMinimums'
import { startToolShim } from './toolShim'
import { browserControlEnv } from './browserControlEnv'
import { allowsTheBrowser, conductorGateCommand } from './conductorGate'
import {
  PROGRAM_STATUS_REPLY,
  ProgramStatusParser,
  statusEvent,
  type ProgramStatus
} from './programStatus'
import {
  AGY_DROPS_ENV,
  AGY_GATE_ENV,
  AGY_HOOK_DROP_PREFIX,
  AGY_OWNER_TITLE_ENV,
  AGY_START_ENV,
  AGY_TITLE_LOG_ENV,
  AGY_TURN_ENV,
  LineTail,
  agyHook,
  everyTurnOutput,
  koloftHookEntry,
  sessionStartOutput,
  titleState,
  writeAgyScripts,
  type AgyHook,
  type AgyTitleState
} from './agyHooks'
import {
  agyTranscript,
  diffCounts,
  lastDiffFor,
  listAgyConversations,
  readAgyTurns,
  saidInTranscript,
  tokenTotals
} from './agyStore'
import {
  agyAccountEnv,
  agyTrustsFolder,
  mergeAgyHooks,
  mergeAgySettings,
  ownersTitleCommand,
  prepareAgyHome,
  trustAgyFolder
} from './agyAccounts'
import { AgyApi, activeHookName, type PendingInteraction } from './agyApi'
import { capTouched, noteWrite, touchedItem, type FileAcc } from './touchedFiles'
import { agySessionKey } from './sessionStore'
import {
  codexKeyFor,
  codexOptionKey,
  type CodexApproval,
  type CodexQuestion
} from './discord/dialog'
import { pathWithDirFirst } from './toolInstall'
import { replyLanguageReminder } from './hooks'
import { record } from './codexObservation'
import {
  StoredSessions,
  type HistoryEntry,
  type StartContext,
  type StoredRun,
  type StoredSessionDeps
} from './storedSessions'

const exec = promisify(execFile)

export interface AgyHomePick {
  account: string
  home: string
}

export interface AgySessionDeps extends StoredSessionDeps {
  openShimRoot: string
  scriptsDir: string
  ownersGemini(): string
  pickHome(resumeSessionId?: string): AgyHomePick | undefined
  apiKeyOf(account: string): Promise<string | undefined>
  playwrightBin: string
  browserEndpoint(tabId: string): string
  builtInStatusLine(account: string): string | undefined
  assistOf(cwd: string, resumeKey?: string): { role: string; allow: string[] } | undefined
  conductorGate: { script: string; writeAllow(tabId: string, allow: string[]): string }
  agent: {
    enabled(): boolean
    answer(tabId: string | undefined, dir: string, name: string, raw: unknown): void
  }
  gitAccounts: StoredSessionDeps['gitAccounts'] & { ghWrapper: string }
}

interface AgyLaunch {
  binary: string
  pick: AgyHomePick
  env: NodeJS.ProcessEnv
}

interface AgyAsk {
  id: string
  since: number
  approval?: CodexApproval
  question?: CodexQuestion
  pending?: PendingInteraction
  plan?: string
}

interface AgyRun extends StoredRun {
  account: string
  home: string
  pid?: number
  api?: AgyApi
  dir: string
  titleTail: LineTail
  turnFile: string
  startedAt: number
  title?: AgyTitleState
  touched: Map<string, FileAcc>
  liveWrites: number
  background?: BackgroundItem
  lastTool?: { name: string; args: Record<string, unknown> }
  waiting?: AgyAsk
  stream?: { conversationId: string; close(): void }
  compacting?: { since: number; shown: boolean; timer?: ReturnType<typeof setTimeout> }
}

// AGY§1 AGY§3
const AGY: CliSpec = {
  command: 'agy',
  testCommandEnv: 'KOLOFT_AGY_CMD',
  name: 'Antigravity',
  cliName: 'Antigravity CLI',
  notInstalled: 'Install the Antigravity CLI to start Antigravity sessions.',
  environment: (env) => env,
  version: /^(\d+)\.(\d+)\.(\d+)/m,
  testedLine: TESTED_AGY_LINE,
  installedOffPath: (env) => path.join(env.HOME || '', '.local', 'bin', 'agy')
}

// AGY§3
const AGY_UPDATE_TIMEOUT_MS = 5 * 60_000
const TICK_MS = 500
// AGY§17
const COMPACTION_SHOWS_AFTER_MS = 500
const CONTEXT_SUMMARY = 'context_summary'
// AGY§14
const KEYS = { yes: ['1'], noCommand: ['4'], noFile: ['2'] } as const
// AGY§13
const WRITING_TOOLS = new Set(['write_to_file', 'replace_file_content'])

// AGY§26
function permissionFlags(permission: LaunchPermission | 'conductor'): string[] {
  if (permission === 'bypass' || permission === 'conductor')
    return ['--dangerously-skip-permissions']
  if (permission === 'acceptEdits') return ['--mode', 'accept-edits']
  return []
}

// AGY§8
function argOf(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  if (typeof value !== 'string') return undefined
  if (!value.startsWith('"')) return value
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'string' ? parsed : value
  } catch {
    return value
  }
}

function lineCount(file: string): number {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0
  } catch {
    return 0
  }
}

export class AgySessions extends StoredSessions<AgyRun, HistoryEntry, AgyLaunch> {
  readonly id = 'agy'
  private parsers = new Map<string, ProgramStatusParser>()
  private ticking?: ReturnType<typeof setInterval>
  private unreadable = new Set<string>()
  // AGY§3
  protected readonly cli = {
    product: 'Antigravity CLI',
    minVersion: MIN_AGY_VERSION,
    howToUpdate: 'Run "agy update"',
    find: () => resolveCliRuntime(AGY),
    update: async (runtime: CliRuntime): Promise<void> => {
      await exec(runtime.binary, ['update'], {
        env: runtime.env,
        timeout: AGY_UPDATE_TIMEOUT_MS
      }).catch(() => undefined)
    }
  }

  constructor(
    file: string,
    protected deps: AgySessionDeps
  ) {
    super(file, agySessionKey, deps)
    deps.pty.on('data', ({ id, data }: { id: string; data: string }) => this.onData(id, data))
  }

  protected untestedNotice(version: string): string {
    return `Antigravity CLI ${version} is newer than the version Koloft was tested with (${TESTED_AGY_LINE}.x). It may misbehave.`
  }

  private get gemini(): string {
    return this.deps.ownersGemini()
  }

  private transcriptOf(key: string): string {
    return agyTranscript(this.gemini, this.nativeId(key))
  }

  // AGY§8
  async searchSnippets(
    term: string,
    signal?: AbortSignal
  ): Promise<{ id: string; snippet: string }[]> {
    const wanted = term.toLowerCase()
    const found: { id: string; snippet: string }[] = []
    for (const key of this.history.keys()) {
      if (signal?.aborted) break
      let hit: string | undefined
      await saidInTranscript(this.transcriptOf(key), (text) => {
        if (signal?.aborted) return true
        if (!text.toLowerCase().includes(wanted)) return false
        hit = text
        return true
      }).catch(() => undefined)
      if (hit) found.push({ id: key, snippet: hit })
    }
    return found
  }

  // AGY§5
  trustsFolder(dir: string): boolean {
    const picked = this.deps.pickHome()
    return !!picked && agyTrustsFolder(picked.home, dir)
  }

  protected async listHistory(): Promise<
    { key: string; entry: HistoryEntry; archived: boolean }[]
  > {
    const entries = await listAgyConversations(this.gemini)
    return entries.map((entry) => ({ key: agySessionKey(entry.id), entry, archived: false }))
  }

  async transcriptExists(key: string): Promise<boolean> {
    if (!this.history.has(key)) await this.refreshHistory()
    return this.history.has(key)
  }

  // AGY§8
  async readTurns(key: string, n: number): Promise<Turn[]> {
    try {
      const turns = await readAgyTurns(this.transcriptOf(key), n)
      this.unreadable.delete(key)
      return turns
    } catch (error) {
      if (!this.unreadable.has(key)) {
        this.unreadable.add(key)
        this.deps.error(
          `Koloft could not read this Antigravity session's messages: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      return []
    }
  }

  get cliBinary(): string | undefined {
    return this.binary
  }

  protected prepare(opts: CreateTabOptions): AgyLaunch {
    // ADR-0030
    const pick = this.deps.pickHome(opts.resumeSessionId)
    if (!pick) throw new Error(NO_USABLE_ACCOUNT.agy)
    return { binary: this.binary!, pick, env: { ...(this.processEnv ?? process.env) } }
  }

  protected runDetails(run: AgyRun): Pick<BackendSessionInfo, 'details' | 'pickedAccount'> {
    return { pickedAccount: run.account }
  }

  // AGY§9 AGY§24
  private async heldElsewhere(conversationId: string): Promise<boolean> {
    const lock = path.join(this.gemini, 'antigravity-cli', 'presence', `${conversationId}.lock`)
    if (!fs.existsSync(lock)) return false
    const { stdout } = await exec('lsof', ['-t', lock]).catch(() => ({ stdout: '' }))
    const ours = new Set([...this.runs.values()].map((r) => r.pid))
    return stdout
      .split('\n')
      .map(Number)
      .some((pid) => pid > 0 && !ours.has(pid))
  }

  protected async startRun(
    { opts, cwd, workspace, resource, freshWorktree }: StartContext,
    { binary, pick, env }: AgyLaunch
  ): Promise<AgyRun> {
    const resumeId = opts.resumeSessionId ? this.nativeId(opts.resumeSessionId) : undefined
    const apiKey = await this.deps.apiKeyOf(pick.account)
    if (resumeId && (await this.heldElsewhere(resumeId)))
      throw new Error(
        'This Antigravity session is open in another agy window. Close it there first: two windows on one conversation lose each other’s turns.'
      )
    this.assertStarting()
    const assist = this.deps.assistOf(cwd, opts.resumeSessionId)
    const conductor = opts.conductor || !!assist
    const role = opts.role ?? assist?.role
    const allow = opts.allow ?? assist?.allow ?? []
    const permission = opts.permission ?? 'default'
    const tabId = this.deps.pty.nextId()
    const endpoint = conductor && !allowsTheBrowser(allow) ? '' : this.deps.browserEndpoint(tabId)
    const agent = this.deps.agent.enabled() ? this.deps.agent : undefined
    const instructions = [
      ...(agent && !conductor ? [koloftPrompt('agy')] : []),
      ...(role ? [role] : [])
    ].join('\n\n')
    const scripts = writeAgyScripts(this.deps.scriptsDir)
    const gemini = this.gemini
    // AGY§4
    prepareAgyHome(pick.home, gemini)
    // ADR-0026 AGY§5
    const trust = [cwd, workspace].filter((d, i, all) => all.indexOf(d) === i)
    mergeAgySettings(pick.home, gemini, {
      trust: freshWorktree || opts.trustFolder || assist ? trust : [],
      titleCommand: `/bin/sh ${JSON.stringify(scripts.title)}`,
      statusLine: this.deps.builtInStatusLine(pick.account),
      apiKey: !!apiKey
    })
    if (freshWorktree || opts.trustFolder || assist) trustAgyFolder(pick.home, trust)
    mergeAgyHooks(pick.home, gemini, koloftHookEntry(scripts.hook))
    let bound: AgyRun | undefined
    const tools = startToolShim(
      { ...this.deps, ghWrapper: this.deps.gitAccounts.ghWrapper },
      {
        open: (target) => this.deps.events(tabId, { type: 'open', target }),
        agent: agent && ((dir, name, raw) => agent.answer(bound?.tabId, dir, name, raw)),
        drop: (name) =>
          name.startsWith(AGY_HOOK_DROP_PREFIX)
            ? (obj, full): void => {
                fs.rm(full, { force: true }, () => {})
                const hook = agyHook(obj)
                if (hook && bound) this.onHook(bound, hook)
              }
            : null
      }
    )
    const dir = tools.shim.shimDir
    const titleLog = path.join(dir, 'agy-title.jsonl')
    const startFile = path.join(dir, 'agy-session-start.json')
    const turnFile = path.join(dir, 'agy-every-turn.json')
    try {
      fs.writeFileSync(titleLog, '')
      if (instructions) fs.writeFileSync(startFile, sessionStartOutput(instructions))
      const token = randomBytes(24).toString('hex')
      const gate = conductor
        ? conductorGateCommand(
            this.deps.conductorGate.script,
            this.deps.conductorGate.writeAllow(tabId, allow)
          )
        : undefined
      const ownerTitle = ownersTitleCommand(gemini)
      const argv = [
        `--gemini_dir=${pick.home}`,
        `--csrf_token=${token}`,
        ...(opts.model ? ['--model', opts.model] : []),
        ...(opts.effort ? ['--effort', opts.effort] : []),
        ...permissionFlags(conductor ? 'conductor' : permission),
        ...(resumeId
          ? [`--conversation=${resumeId}`]
          : opts.firstPrompt
            ? ['-i', opts.firstPrompt]
            : [])
      ]
      this.parsers.set(tabId, new ProgramStatusParser())
      const handle = this.deps.pty.create({
        id: tabId,
        kind: 'agy',
        cwd,
        cols: opts.cols,
        rows: opts.rows,
        executable: binary,
        argv,
        processEnv: {
          ...env,
          PWD: cwd,
          PATH: pathWithDirFirst(env.PATH, dir),
          [AGY_DROPS_ENV]: tools.shim.requestDir,
          [AGY_TITLE_LOG_ENV]: titleLog,
          ...(instructions ? { [AGY_START_ENV]: startFile } : {}),
          [AGY_TURN_ENV]: turnFile,
          ...(gate ? { [AGY_GATE_ENV]: gate } : {}),
          ...(ownerTitle ? { [AGY_OWNER_TITLE_ENV]: ownerTitle } : {}),
          ...agyAccountEnv(apiKey),
          ...browserControlEnv(tabId, endpoint)
        },
        resumeSessionId: opts.resumeSessionId,
        extraEnv: resource ? { KOLOFT_PORT_OFFSET: String(portOffset(resource.worktreeName)) } : {}
      })
      const pid = this.deps.pty.pidOf(handle.id)
      const run: AgyRun = {
        tabId: handle.id,
        cwd,
        workspace,
        resource,
        explicitStop: false,
        resumeKey: opts.resumeSessionId,
        permission,
        account: pick.account,
        home: pick.home,
        pid,
        api: pid ? new AgyApi(pid, token) : undefined,
        dir,
        titleTail: new LineTail(titleLog, (line) => {
          const state = titleState(line)
          if (state && bound) this.onTitle(bound, state)
        }),
        turnFile,
        startedAt: handle.startedAt,
        touched: new Map(),
        liveWrites: 0,
        releaseTools: () => {
          tools.release()
          this.parsers.delete(handle.id)
        }
      }
      bound = run
      this.ticking ??= setInterval(() => this.tick(), TICK_MS)
      this.ticking.unref?.()
      return run
    } catch (error) {
      this.parsers.delete(tabId)
      tools.release()
      throw error
    }
  }

  protected async endRun(run: AgyRun): Promise<void> {
    run.stream?.close()
    if (run.compacting?.timer) clearTimeout(run.compacting.timer)
  }

  private tick(): void {
    if (this.runs.size === 0 && this.ticking) {
      clearInterval(this.ticking)
      this.ticking = undefined
      return
    }
    for (const run of this.runs.values()) if (!run.explicitStop) run.titleTail.read()
  }

  // AGY§9 AGY§11
  private onTitle(run: AgyRun, state: AgyTitleState): void {
    if (run.explicitStop || run.stopping) return
    const before = run.title
    run.title = state
    if (state.conversationId && run.info?.nativeSessionId !== state.conversationId)
      this.bindTo(run, state.conversationId)
    if (!run.info) return
    if (state.title && state.title !== before?.title) this.retitle(run.info, state.title)
    // AGY§19
    if (state.agentState === 'reviewing' && before?.agentState !== 'reviewing')
      void this.readPlan(run)
    else if (state.agentState !== 'reviewing' && run.waiting?.plan) run.waiting = undefined
  }

  private bindTo(run: AgyRun, conversationId: string): void {
    const key = agySessionKey(conversationId)
    const known = this.history.get(key)
    const switched = !!run.info && !!known
    run.touched.clear()
    run.liveWrites = 0
    run.background = undefined
    run.waiting = undefined
    run.stream?.close()
    run.stream = undefined
    this.bind(run, known ?? { id: conversationId, cwd: run.cwd }, switched ? 'switch' : 'replace')
    void this.refreshHistory().catch(() => undefined)
  }

  // AGY§12
  private onHook(run: AgyRun, hook: AgyHook): void {
    if (run.explicitStop || run.stopping) return
    if (hook.conversationId !== run.info?.nativeSessionId) return
    const { input } = hook
    switch (hook.event) {
      case 'PreToolUse': {
        const call = record(input.toolCall)
        run.lastTool = { name: String(call.name ?? ''), args: record(call.args) }
        return
      }
      case 'PostToolUse':
        return void this.afterTool(run, input)
      case 'Stop':
        return this.onStop(run, input)
    }
  }

  // AGY§8 AGY§12
  private async afterTool(run: AgyRun, input: Record<string, unknown>): Promise<void> {
    const call = record(input.toolCall)
    const name = String(call.name ?? '')
    const target = argOf(record(call.args), 'TargetFile')
    if (!WRITING_TOOLS.has(name) || !target) return
    const file = path.resolve(run.cwd, target)
    let counts = { added: 0, removed: 0 }
    if (name === 'write_to_file') counts = { added: lineCount(file), removed: 0 }
    else if (run.info) {
      const diff = await lastDiffFor(agyTranscript(this.gemini, run.info.nativeSessionId!), file)
      if (diff) counts = diffCounts(diff)
    }
    noteWrite(run.touched, file, counts.added, counts.removed, Date.now())
    run.liveWrites++
    this.deps.events(run.tabId, {
      type: 'files-changed',
      files: capTouched([...run.touched].map(([src, acc]) => touchedItem(src, acc))),
      lastTouched: file,
      lastWritten: file,
      liveWrites: run.liveWrites
    })
  }

  // AGY§12 AGY§17
  private onStop(run: AgyRun, input: Record<string, unknown>): void {
    if (input.terminationReason === 'TERMINAL_CUSTOM_HOOK') this.endCompaction(run)
    const busy = input.fullyIdle === false
    if (busy === !!run.background) return
    run.background = busy
      ? { id: 'agy-background', kind: 'agent', label: 'Background work', state: 'working' }
      : undefined
    this.deps.events(run.tabId, {
      type: 'background-changed',
      items: run.background ? [run.background] : []
    })
  }

  // AGY§10
  private onData(tabId: string, data: string): void {
    const parser = this.parsers.get(tabId)
    if (!parser) return
    const { asked, states } = parser.push(data)
    if (asked) this.deps.pty.write(tabId, PROGRAM_STATUS_REPLY)
    const run = this.runs.get(tabId)
    if (!run || run.explicitStop || states.length === 0) return
    run.titleTail.read()
    if (!run.info) return
    for (const status of states) this.emitState(run, status)
  }

  private emitState(run: AgyRun, status: ProgramStatus): void {
    if (status.state === 'blocked' && status.kind !== 'auth') void this.readAsk(run, status)
    else if (!run.waiting?.plan) run.waiting = undefined
    if (status.state === 'working') this.turnStarted(run)
    if (status.state === 'done') void this.turnDone(run)
    const event = statusEvent(status)
    if (event) this.deps.events(run.tabId, event)
  }

  // ADR-0031 AGY§12
  private turnStarted(run: AgyRun): void {
    this.watchCompaction(run)
    const id = run.info?.nativeSessionId
    if (!id) return
    void readAgyTurns(agyTranscript(this.gemini, id), 1).then((turns) => {
      const said = turns[0]?.said.at(-1)?.text
      if (said) fs.writeFile(run.turnFile, everyTurnOutput(replyLanguageReminder(said)), () => {})
    })
  }

  // AGY§8 AGY§10
  private async turnDone(run: AgyRun): Promise<void> {
    this.endCompaction(run)
    const id = run.info?.nativeSessionId
    if (!id) return
    const file = agyTranscript(this.gemini, id)
    const [turn] = await readAgyTurns(file, 1).catch(() => [] as Turn[])
    if (turn?.reply) this.deps.events(run.tabId, { type: 'turn-ended', turn })
    const t = await tokenTotals(file).catch(() => undefined)
    if (!t) return
    const tokens = { inTok: t.input, outTok: t.output, cacheReadTok: t.cacheRead, cacheWriteTok: 0 }
    const model = run.title?.model
    const pricing = model ? resolvePricing(model) : undefined
    const used = run.title?.contextUsed
    this.deps.events(run.tabId, {
      type: 'usage',
      usage: {
        ...tokens,
        ...(pricing ? { costUsd: costUsdOf(pricing, tokens) } : {}),
        ...(used !== undefined ? { ctxPct: used / 100 } : {}),
        model
      }
    })
  }

  // AGY§17
  private watchCompaction(run: AgyRun): void {
    const id = run.info?.nativeSessionId
    if (!run.api || !id || run.stream?.conversationId === id) return
    run.stream?.close()
    const stream = run.api.streamState(id, (message) => {
      const hook = activeHookName(message)
      if (hook === CONTEXT_SUMMARY && !run.compacting) {
        const compacting: AgyRun['compacting'] = { since: Date.now(), shown: false }
        compacting.timer = setTimeout(() => {
          compacting.shown = true
          this.deps.events(run.tabId, { type: 'compacting' })
        }, COMPACTION_SHOWS_AFTER_MS)
        run.compacting = compacting
      } else if (hook !== CONTEXT_SUMMARY && run.compacting) this.endCompaction(run)
    })
    run.stream = { conversationId: id, close: stream.close }
  }

  private endCompaction(run: AgyRun): void {
    const c = run.compacting
    if (!c) return
    run.compacting = undefined
    if (c.timer) clearTimeout(c.timer)
    if (c.shown) this.deps.events(run.tabId, { type: 'compacted' })
  }

  // AGY§10 AGY§16
  private async readAsk(run: AgyRun, status: ProgramStatus): Promise<void> {
    const id = run.info?.nativeSessionId
    if (!id) return
    if (status.msg === 'Approve plan') return this.readPlan(run)
    const since = Date.now()
    const fromHook = this.askFromHook(run, status, since)
    run.waiting = fromHook
    const pending = await run.api?.pending(id).catch(() => undefined)
    if (!pending || run.waiting !== fromHook) return
    const askId = `${pending.trajectoryId}:${pending.stepIndex}`
    const question = pending.questions?.[0]
    run.waiting = {
      id: askId,
      since,
      pending,
      ...(pending.kind === 'question' && question
        ? {
            question: {
              id: askId,
              question: question.question,
              options: question.options.map((o) => ({ label: o.text }))
            }
          }
        : {
            approval: {
              id: askId,
              command: pending.target,
              reason: pending.kind === 'file' ? 'Write this file' : undefined
            }
          })
    }
  }

  // AGY§12 AGY§13
  private askFromHook(run: AgyRun, status: ProgramStatus, since: number): AgyAsk {
    const id = `hook:${since}`
    const tool = run.lastTool
    if (status.kind === 'question' && tool?.name === 'ask_question') {
      const raw = record(tool.args).questions
      const first = record(Array.isArray(raw) ? raw[0] : undefined)
      const options = Array.isArray(first.options) ? first.options : []
      return {
        id,
        since,
        question: {
          id,
          question: typeof first.question === 'string' ? first.question : (status.msg ?? ''),
          options: options.map((o) => ({ label: String(o) }))
        }
      }
    }
    const target = tool && (argOf(tool.args, 'CommandLine') ?? argOf(tool.args, 'TargetFile'))
    return { id, since, approval: { id, command: target ?? status.msg } }
  }

  // AGY§19
  private async readPlan(run: AgyRun): Promise<void> {
    const id = run.info?.nativeSessionId
    if (!id) return
    const brain = path.join(this.gemini, 'antigravity-cli', 'brain', id)
    let names: string[] = []
    try {
      names = fs.readdirSync(brain).filter((n) => n.endsWith('.md.metadata.json'))
    } catch {}
    const waiting = names
      .map((n) => ({ n, meta: record(safeJson(path.join(brain, n))) }))
      .filter((x) => x.meta.requestFeedback === true)
      .map((x) => x.n.replace(/\.metadata\.json$/, ''))
    const plan = waiting[0]
    if (!plan) return
    const askId = `plan:${id}:${plan}`
    run.waiting = {
      id: askId,
      since: Date.now(),
      plan,
      approval: { id: askId, command: plan, reason: 'Approve the plan' }
    }
    this.deps.events(run.tabId, { type: 'notify', need: 'approval' })
  }

  openApproval(tabId: string): CodexApproval | undefined {
    return this.runs.get(tabId)?.waiting?.approval
  }

  openQuestion(tabId: string): CodexQuestion | undefined {
    return this.runs.get(tabId)?.waiting?.question
  }

  // AGY§14 AGY§16 AGY§19
  async answer(tabId: string, reply: string): Promise<string | undefined | false> {
    const run = this.runs.get(tabId)
    const ask = run?.waiting
    const id = run?.info?.nativeSessionId
    if (!run || !ask || !id) return false
    if (ask.question) {
      const key = codexOptionKey(ask.question, reply)
      if (!key) return 'this Antigravity question takes the number or the name of one option.'
      run.waiting = undefined
      const option = ask.pending?.questions?.[0]?.options[Number(key) - 1]
      const viaApi =
        ask.pending && option
          ? await run.api?.pick(id, ask.pending, [option.id]).then(
              () => true,
              () => false
            )
          : false
      if (!viaApi) this.deps.pty.write(tabId, key)
      return undefined
    }
    const key = codexKeyFor(reply)
    if (!key) return 'an Antigravity approval takes yes or no.'
    const yes = key === 'y'
    run.waiting = undefined
    if (ask.plan) {
      await this.deliverText(run, id, `[${yes ? 'Approved' : 'Rejected'}] ${ask.plan}`)
      return undefined
    }
    const viaApi = ask.pending
      ? await run.api?.allow(id, ask.pending, yes).then(
          () => true,
          () => false
        )
      : false
    if (!viaApi) {
      const file = ask.pending?.kind === 'file' || WRITING_TOOLS.has(run.lastTool?.name ?? '')
      const keys = yes ? KEYS.yes : file ? KEYS.noFile : KEYS.noCommand
      for (const k of keys) this.deps.pty.write(tabId, k)
    }
    return undefined
  }

  // AGY§15 AGY§16
  private async deliverText(run: AgyRun, conversationId: string, text: string): Promise<void> {
    const sent = await run.api?.send(conversationId, text).catch(() => false)
    if (!sent) this.deps.pty.write(run.tabId, `\x1b[200~${text}\x1b[201~\r`)
  }

  // AGY§16
  async deliver(tabId: string, text: string): Promise<boolean> {
    const run = this.runs.get(tabId)
    const id = run?.info?.nativeSessionId
    if (!run?.api || !id) return false
    return run.api.send(id, text).catch(() => false)
  }
}

function safeJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}
