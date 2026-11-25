import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { promisify } from 'util'
import {
  PLACEHOLDER_TITLES,
  type BackendSessionInfo,
  type BackgroundItem,
  type CreateTabOptions,
  type LaunchPermission
} from '@shared/types'
import type { Turn } from '@shared/turns'
import type { TranscriptPlaces } from '@core/transcriptPlaces'
import { portOffset } from '@shared/worktreeName'
import { costUsdOf, resolvePricing } from '@shared/pricing'
import { resolveCliRuntime, type CliRuntime, type CliSpec } from '../../../main/cliRuntime'
import { AGY_UPDATE_TIMEOUT_MS, MIN_AGY_VERSION, TESTED_AGY_LINE } from './agyMinimum'
import { startToolShim } from '../../../main/toolShim'
import { COULD_NOT_REACH_KOLOFT } from '@core/command'
import { browserControlEnv } from '../../../main/browserControlEnv'
import { BACKGROUND_LABEL_CHARS, scheduleLabel } from '@core/scheduleLabel'
import {
  PROGRAM_STATUS_REPLY,
  ProgramStatusParser,
  statusEvent,
  type ProgramStatus
} from '../../../main/programStatus'
import {
  AGY_COST_ENV,
  AGY_LOG_ENV,
  AGY_OWNER_TITLE_ENV,
  AGY_START_ENV,
  agyLogLine,
  koloftHookEntry,
  runWithSh,
  sessionStartOutput,
  writeAgyScripts,
  type AgyHook,
  type AgyLogLine,
  type AgyTitleState
} from './agyHooks'
import {
  agyTranscript,
  AGY_APP_DIR,
  AGY_HISTORY_STORE,
  agyBrain,
  ancestryOfAgyConversation,
  diffCounts,
  historyEntries,
  lastDiffFor,
  listAgyConversations,
  readAgyConversationTitle,
  readAgyTurns,
  saidInTranscript,
  TranscriptFollower
} from './agyStore'
import {
  agyAccountEnv,
  agyJsonText,
  agyOnboardingFile,
  agyTokenFile,
  agyTrustsFolder,
  anyAccountHomeTrusts,
  mergeAgyHooks,
  mergeAgySettings,
  mergedAgyHooks,
  mergedAgySettings,
  ownersPlaywrightMcp,
  ownersTitleCommand,
  prepareAgyHome,
  titleCommandIn,
  trustsIn
} from './agyAccounts'
import { readJson } from '../../../main/jsonDrops'
import { LineTail } from '../../../main/lineTail'
import { bracketedPaste } from '@core/typeKeys'
import { TAB_TMUX_NAME_SH, tmuxSessionName } from '../../../main/remote/launch'
import { AgyApi, agentStateUpdate, type AgyBackgroundTask, type PendingInteraction } from './agyApi'
import {
  AGY_HOOK_FILE,
  AGY_KEY_FROM_KOLOFT,
  AGY_SIGN_IN_FROM_KOLOFT,
  AGY_REMOTE_GEMINI,
  AGY_SKILLS,
  AGY_STATUSLINE_FILE,
  AGY_TITLE_FILE,
  agyLogName,
  agyLogPointer,
  agyTab,
  runMachineScript
} from './agyTab'
import { agyFoldersToMirror } from './agyMirror'
import type { MirrorFolder } from '@core/agent/mirrorFolders'
import {
  agyConversations,
  agyConversationTitle,
  agyHeldElsewhere,
  agySend,
  launchAgy,
  readAgyConfig
} from './agyMachine'
import type { Machine } from '../../../main/host/machine'
import { seedAssistMemory } from '../../../main/assistMemory'
import { NOTICE_ENV, noticeFile, SHELL_WROTE_FIELD } from '@plugins/sessions/main/hooks'
import { formatRemoteKey, keyedOn, parseRemoteKey, type RemoteKey } from '@shared/remoteKey'
import { AGY_ARTIFACT_SIDECAR } from '../shared/agyBrain'
import { noteWrite, shellWrittenFiles, wroteEvent, type FileAcc } from '../../../main/touchedFiles'
import { agySessionKey } from '@agents/kit/main/sessionStore'
import {
  codexKeyFor,
  labelsOf,
  questionAnswers,
  type CodexApproval,
  type CodexQuestion,
  type Question,
  type SentAnswer
} from '@plugins/sessions/main/dialog'
import { pathWithDirFirst } from '../../../main/toolInstall'
import { record } from '@core/unknownValue'
import { agyToolDid } from '../../../main/rowActivity'
import {
  REMOTE_EXIT_WAIT_MS,
  StoredSessions,
  hostOfKey,
  type HistoryEntry,
  ownerTextFor,
  type HistoryListing,
  type StartContext,
  type StoredRun,
  type StoredSessionDeps
} from '@agents/kit/main/storedSessions'
import { promptParts, type LaunchIdentity } from '../../../main/launchPrompt'

const exec = promisify(execFile)

export interface AgyHomePick {
  account: string
  home: string
  banner?: string
  notice?: string
}

export interface AgySessionDeps extends StoredSessionDeps {
  openShimRoot: string
  scriptsDir: string
  ownersGemini(): string
  keepSkillsIn(skillsDir: string, koloftOn: boolean): void
  pickHome(resumeSessionId?: string, onlyAsking?: boolean): AgyHomePick | undefined
  apiKeyOf(account: string): Promise<string | undefined>
  playwrightBin: string
  browserEndpoint(tabId: string): string
  builtInStatusLine(account: string): string | undefined
  skipPermissions(): boolean
  assistOf(cwd: string, resumeKey?: string): LaunchIdentity | undefined
  agent: {
    enabled(): boolean
    answer(tabId: string | undefined, dir: string, name: string, raw: unknown): void
  }
  gitAccounts: StoredSessionDeps['gitAccounts'] & { ghWrapper: string }
  remote: AgyRemoteDeps
}

export interface AgyRemoteDeps {
  machine(host: string): Machine
  saidWhenTheMachineWantsAPasswordFirst: string
  hosts(): string[]
  keyed(host: string, pathOnMachine: string): string
  mirrorDir(host: string): string
  mirrorGemini(host: string): string
  gone(host: string, sessionId: string): boolean
  connected(host: string): boolean
  nextPull(host: string): Promise<void>
  setupLine(): string | undefined
  hookSettings(tabId: string): string | undefined
}

interface AgyLaunch {
  binary: string
  pick: AgyHomePick
  env: NodeJS.ProcessEnv
}

interface AgyAsk {
  approval?: CodexApproval
  question?: CodexQuestion
  pending?: PendingInteraction
  plan?: string
  noKey?: string
}

interface AgyCommand {
  item: BackgroundItem
  shown: boolean
  ran?: boolean
  startTime?: number
}

interface AgySchedule {
  item: BackgroundItem
  shown: boolean
  ran?: boolean
  isDaemon: boolean
  startTime?: number
}

interface AgyChild {
  id: string
  parentId: string
  label: string
  state: 'working' | 'waiting'
  isSwarm?: boolean
  swarmGroup?: string
  fromTitle?: boolean
  needsRecentClaim?: boolean
}

interface PendingSpawn {
  id: string
  parentId: string
  stepIdx?: string
  label: string
  isSwarm?: boolean
  swarmGroup?: string
}

interface KnownChild {
  parentId: string
  label: string
  isSwarm?: boolean
  swarmGroup?: string
}

interface AgyRun extends StoredRun {
  account: string
  brain?: string
  pid?: number
  api?: AgyApi
  dir?: string
  remote?: { host: string; tmuxName: string }
  shown?: string
  lastTitleState?: string
  statesBeforeBind?: ProgramStatus[]
  firstLine?: string
  log: LineTail
  title?: AgyTitleState
  givenTitle?: string
  titleChase?: { id: string; readsLeft: number; timer?: ReturnType<typeof setTimeout> }
  workingTitleChasedFor?: string
  touched: Map<string, FileAcc>
  liveWrites: number
  unattributedBackground?: boolean
  mainTurnActive?: boolean
  exitedAskToIdle?: boolean
  lastTool?: { name: string; args: Record<string, unknown> }
  schedules?: Map<string, AgySchedule>
  commands?: Map<string, AgyCommand>
  children?: Map<string, AgyChild>
  knownChildren?: Map<string, KnownChild>
  pendingSpawns?: PendingSpawn[]
  recentSpawns?: PendingSpawn[]
  foreignChecked?: Set<string>
  foreignTries?: Map<string, number>
  foreignResolving?: Set<string>
  foreignTimers?: Map<string, ReturnType<typeof setTimeout>>
  pendingForeignHooks?: Map<string, AgyHook[]>
  wokenBySend?: Map<string, { id: string; prev: 'working' | 'waiting' }[]>
  askingCommands?: boolean
  askCommandsAgain?: { run: boolean; pruneFor?: string }
  countsTasks?: boolean
  waiting?: AgyAsk
  stream?: { conversationId: string; close(): void }
  streamShowsRunning?: boolean
  streamRunStarts?: number
  terminalState?: string
  turnEndedOnTerminal?: boolean
  terminalTurnStarts?: number
  compacting?: { shown: boolean; timer?: ReturnType<typeof setTimeout> }
  transcript?: TranscriptFollower
}

function sinceThePrompt(held: ProgramStatus[], arrived: ProgramStatus[]): ProgramStatus[] {
  let kept = held
  for (const status of arrived) {
    const last = kept.at(-1)
    if (status.state === 'idle') kept = [status]
    else if (last?.state !== status.state || last.kind !== status.kind) kept = [...kept, status]
  }
  return kept
}

// AGY§6 AGY§9 AGY§25
function agyEnvironment(given: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...given }
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('KOLOFT_AGY_') ||
      key.startsWith('ANTIGRAVITY_') ||
      key === NOTICE_ENV ||
      key === 'GEMINI_API_KEY'
    )
      delete env[key]
  }
  return env
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
const TICK_MS = 500
// AGY§17
const COMPACTION_SHOWS_AFTER_MS = 500
const CONTEXT_SUMMARY = 'context_summary'
// AGY§8
const LISTED_TITLE_AFTER_PROMPT_MS = 1000
const LISTED_TITLE_REREADS_AFTER_A_TURN = 10
// AGY§14 AGY§26
const KEYS = { yes: '1', noCommand: '4', noEdit: '2', noCreateOrRead: '\x1b' } as const
const TOOL_IN_BLOCKED_MESSAGE_RE = /^Approve (\w+):/
const EDITS_RE = /^(EditFile|ReplaceFileContent|edit_file|replace_file_content)$/
const CREATES_OR_READS_RE =
  /^(WriteFile|WriteToFile|ReadFile|ViewFile|write_file|write_to_file|read_file|view_file)$/
// AGY§13
const READING_TOOLS = new Set(['read_file', 'view_file'])

// AGY§26 AGY§29
function noKeyFor(blockedMessage: string | undefined, toolFromHook: string | undefined): string {
  const asking = TOOL_IN_BLOCKED_MESSAGE_RE.exec(blockedMessage ?? '')?.[1] ?? toolFromHook ?? ''
  if (EDITS_RE.test(asking)) return KEYS.noEdit
  return CREATES_OR_READS_RE.test(asking) ? KEYS.noCreateOrRead : KEYS.noCommand
}
// AGY§9 AGY§24
const HELD_ELSEWHERE =
  'This Antigravity session is open in another agy window. Close it there first: two windows on one conversation lose each other’s turns.'
// AGY§13
const WRITING_TOOLS = new Set(['write_to_file', 'replace_file_content', 'write_file', 'edit_file'])
// AGY§13
const TASK_LINE_MARKS = [
  '"schedule"',
  '"manage_task"',
  '"run_command"',
  '"invoke_subagent"',
  '"manage_subagents"',
  '"send_message"',
  '"post_message"',
  '"swarm"',
  '"swarm_wait"',
  '"subagents"',
  '"tool_confirmation_pending"',
  '"SessionStart"',
  '"PreInvocation"',
  '"Stop"'
]
const FINISHED_TITLE_STATES = new Set([
  'done',
  'completed',
  'complete',
  'finished',
  'killed',
  'cancelled',
  'canceled',
  'errored',
  'failed',
  'stopped'
])
const IDLE_TITLE_STATES = new Set(['idle', 'waiting_for_message', 'waiting'])
const FOREIGN_DB_MAX_TRIES = 10
const FOREIGN_DB_RETRY_MS = 100
const FOREIGN_BUFFER_MAX = 200

// AGY§27
function withoutTheTerminalName(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, TERM_PROGRAM: undefined }
}

// AGY§26
function permissionFlags(permission: LaunchPermission): string[] {
  if (permission === 'bypass') return ['--dangerously-skip-permissions']
  if (permission === 'acceptEdits') return ['--mode', 'accept-edits']
  return []
}

// AGY§31
function firstLineToType(opts: CreateTabOptions, resumeId: string | undefined): string | undefined {
  return !resumeId && opts.firstPrompt?.startsWith('/') ? opts.firstPrompt : undefined
}

// AGY§1 AGY§21 AGY§26 AGY§31
function agyArgs(
  opts: CreateTabOptions,
  resumeId: string | undefined,
  permission: LaunchPermission,
  firstLine: string | undefined
): string[] {
  return [
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.effort ? ['--effort', opts.effort] : []),
    ...permissionFlags(permission),
    ...(resumeId
      ? [`--conversation=${resumeId}`]
      : opts.firstPrompt && !firstLine
        ? ['-i', opts.firstPrompt]
        : [])
  ]
}

// AGY§14
function agyQuestion(question: string, raw: unknown, multiSelect: boolean): Question {
  const options = labelsOf(raw)
  return {
    question,
    options,
    ...(options.length > 0 && { ownWords: true as const }),
    ...(multiSelect && { multiSelect: true as const })
  }
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

function lineCount(text: string): number {
  return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0
}

function replacementCounts(
  target: string,
  replacement: string
): { added: number; removed: number } {
  const from = target.split('\n')
  const to = replacement.split('\n')
  let same = 0
  while (same < from.length && same < to.length && from[same] === to[same]) same++
  let sameTail = 0
  while (
    sameTail < from.length - same &&
    sameTail < to.length - same &&
    from[from.length - 1 - sameTail] === to[to.length - 1 - sameTail]
  )
    sameTail++
  return { added: to.length - same - sameTail, removed: from.length - same - sameTail }
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

const LOG_TAIL_READ_ON_ATTACH_BYTES = 256 * 1024
const REPLAY_LOG_MAX_BYTES = 16 * 1024 * 1024
const SHORT_ROLE_MAX_CHARS = 80

function logTail(file: string): { size: number; text: string } {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const buf = Buffer.alloc(Math.min(size, LOG_TAIL_READ_ON_ATTACH_BYTES))
      fs.readSync(fd, buf, 0, buf.length, size - buf.length)
      return { size, text: buf.toString('utf8') }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return { size: 0, text: '' }
  }
}

function readReplayLines(file: string): string[] {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      if (size === 0) return []
      const len = Math.min(size, REPLAY_LOG_MAX_BYTES)
      const start = size - len
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, start)
      const lines = buf.toString('utf8').split('\n')
      return start > 0 ? lines.slice(1) : lines
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return []
  }
}

function attachedLog(mirror: string, conversationId: string): string | undefined {
  return readText(path.join(mirror, agyLogPointer(conversationId)))?.trim() || undefined
}

// AGY§13
function commandsOf(run: AgyRun, conversationId: string): [string, AgyCommand][] {
  return [...(run.commands ?? [])].filter(([id]) => id.startsWith(`${conversationId}/`))
}

function schedulesOf(run: AgyRun, conversationId: string): [string, AgySchedule][] {
  return [...(run.schedules ?? [])].filter(([id]) => id.startsWith(`${conversationId}/`))
}

function agyScheduleLabel(args: Record<string, unknown>): string {
  return scheduleLabel({
    seconds:
      typeof args.DurationSeconds === 'number' && Number.isFinite(args.DurationSeconds)
        ? args.DurationSeconds
        : undefined,
    cron: argOf(args, 'CronExpression'),
    prompt: argOf(args, 'Prompt')
  })
}

// AGY§13
function subagentSpecs(args: Record<string, unknown>, stepIdx: unknown): { label: string }[] {
  const list =
    Array.isArray(args.Subagents) && args.Subagents.length
      ? args.Subagents
      : argOf(args, 'TypeName') || argOf(args, 'Role') || argOf(args, 'Prompt')
        ? [args]
        : []
  if (!list.length) {
    const summary = argOf(args, 'toolSummary')?.replace(/\s+/g, ' ').trim()
    return [
      { label: summary?.slice(0, BACKGROUND_LABEL_CHARS) || `Subagent (${String(stepIdx ?? '')})` }
    ]
  }
  return list.map((raw) => {
    const spec = record(raw)
    const typeName = argOf(spec, 'TypeName')?.trim()
    const role = argOf(spec, 'Role')?.replace(/\s+/g, ' ').trim()
    const prompt = argOf(spec, 'Prompt')?.replace(/\s+/g, ' ').trim()
    const label = role
      ? typeName && typeName !== 'self' && !role.toLowerCase().includes(typeName.toLowerCase())
        ? `${typeName}: ${role}`
        : role
      : (typeName && typeName !== 'self' ? typeName : undefined) || prompt || 'Subagent'
    return { label: label.slice(0, BACKGROUND_LABEL_CHARS) }
  })
}

// AGY§13
function swarmMemberNames(base: string, args: Record<string, unknown>): string[] {
  if (Array.isArray(args.tasks) && args.tasks.length > 0)
    return args.tasks.map((_, i) => `${base}-${i + 1}`)
  const count = typeof args.n === 'number' && Number.isInteger(args.n) && args.n > 1 ? args.n : 1
  return count > 1 ? Array.from({ length: count }, (_, i) => `${base}-${i + 1}`) : [base]
}

// AGY§11
function titleSubagentLabel(sub: { name?: string; role?: string }): string {
  const shortRole =
    sub.role && !sub.role.includes('\n') && sub.role.length <= SHORT_ROLE_MAX_CHARS
      ? sub.role.trim()
      : undefined
  const cleanName = sub.name && sub.name !== 'self' ? sub.name.trim() : undefined
  const fallbackRole = sub.role?.replace(/\s+/g, ' ').trim()
  return (shortRole || cleanName || fallbackRole || 'Subagent').slice(0, BACKGROUND_LABEL_CHARS)
}

function swarmMentions(text: string): { all: boolean; names: Set<string> } {
  const names = new Set<string>()
  let all = false
  for (const m of text.matchAll(/(?:^|[^a-z0-9_-])@([a-z0-9_-]+)/gi)) {
    const target = m[1]!.toLowerCase()
    if (target === 'all') all = true
    else names.add(target)
  }
  return { all, names }
}

function listFromStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : []
}

// AGY§11 AGY§12 AGY§29
function remoteStatus(run: AgyRun, read: AgyLogLine): ProgramStatus | undefined {
  if ('hook' in read) {
    if (read.hook.conversationId !== run.info?.nativeSessionId) return undefined
    if (read.hook.event === 'PreInvocation') return { state: 'working' }
    if (read.hook.event === 'Stop') return { state: 'done' }
    return undefined
  }
  const { agentState, confirmationPending } = read.title
  const interruptedMidTurn =
    run.shown === 'working' &&
    (run.lastTitleState === 'working' || run.lastTitleState === 'tool_use')
  const exitedReview = run.lastTitleState === 'reviewing' && run.shown !== 'done'
  run.lastTitleState = agentState
  if (
    agentState === 'idle' &&
    (run.shown === undefined || run.shown === 'blocked' || interruptedMidTurn || exitedReview)
  )
    return { state: 'idle' }
  if (agentState === 'tool_use' && confirmationPending)
    return {
      state: 'blocked',
      kind: run.lastTool?.name === 'ask_question' ? 'question' : 'permission'
    }
  if (agentState === 'working' && run.shown === 'blocked') return { state: 'working' }
  return undefined
}

export class AgySessions extends StoredSessions<AgyRun, HistoryEntry, AgyLaunch> {
  readonly id = 'agy'
  readonly historyStore = AGY_HISTORY_STORE
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

  private remoteHistory = new Map<string, HistoryEntry[]>()

  private get gemini(): string {
    return this.deps.ownersGemini()
  }

  private geminiOf(cwd: string | undefined): string {
    const key = cwd ? parseRemoteKey(cwd) : null
    return key ? this.deps.remote.mirrorGemini(key.host) : this.gemini
  }

  private cwdOf(key: string): string | undefined {
    return this.store.getMember(key)?.cwd ?? this.history.get(key)?.cwd
  }

  private transcriptOf(key: string): string {
    return agyTranscript(this.geminiOf(this.cwdOf(key)), this.nativeId(key))
  }

  usesHost(host: string): boolean {
    return (
      [...this.runs.values()].some((r) => r.remote?.host === host) ||
      !!this.remoteHistory.get(host)?.length
    )
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
  trustsFolder(dir: string): boolean | Promise<boolean> {
    const key = parseRemoteKey(dir)
    if (!key && this.trustedHere(undefined, dir)) return true
    const picked = this.deps.pickHome(undefined, true)
    if (!picked) return false
    if (!key) return this.trustedHere(picked.home, dir)
    const { remote } = this.deps
    return readAgyConfig(
      remote.machine(key.host),
      picked.account,
      remote.saidWhenTheMachineWantsAPasswordFirst
    ).then((config) => trustsIn(key.path, config.ownSettings, config.ownersSettings))
  }

  // AGY§5
  private trustedHere(accountHome: string | undefined, dir: string): boolean {
    return [this.gemini, accountHome].some((home) => !!home && agyTrustsFolder(home, dir))
  }

  protected async listHistory(): Promise<HistoryListing<HistoryEntry>> {
    const local = await listAgyConversations(this.gemini)
    const { remote } = this.deps
    const hosts = remote.hosts()
    for (const host of this.remoteHistory.keys())
      if (!hosts.includes(host)) {
        this.remoteHistory.delete(host)
        this.listedAt.delete(host)
      }
    const listedHosts: string[] = []
    // AGY§8
    await Promise.all(
      hosts
        .filter((host) => remote.connected(host))
        .map(async (host) => {
          const rows = await agyConversations(remote.machine(host)).catch(() => undefined)
          if (!rows) return
          this.remoteHistory.set(
            host,
            historyEntries(rows).map((e) => ({ ...e, cwd: remote.keyed(host, e.cwd) }))
          )
          listedHosts.push(host)
        })
    )
    return {
      entries: [
        ...local.map((entry) => ({ key: agySessionKey(entry.id), entry, archived: false })),
        ...[...this.remoteHistory].flatMap(([host, entries]) =>
          entries.map((entry) => ({ key: agySessionKey(entry.id, host), entry, archived: false }))
        )
      ],
      listedHosts
    }
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

  // AGY§4 AGY§8
  transcriptPlaces(key: string): TranscriptPlaces {
    const id = this.nativeId(key)
    const host = hostOfKey(key)
    if (!host) return { onThisMac: agyTranscript(this.gemini, id) }
    return {
      onThisMac: agyTranscript(this.deps.remote.mirrorGemini(host), id),
      onMachine: agyTranscript(path.posix.join('~', AGY_REMOTE_GEMINI), id)
    }
  }

  get cliBinary(): string | undefined {
    return this.binary
  }

  protected prepare(opts: CreateTabOptions): AgyLaunch {
    // ADR-0030
    const pick = this.deps.pickHome(opts.resumeSessionId)
    if (!pick) throw new Error(this.deps.noAccountMessage('agy'))
    if (pick.notice) this.deps.error(pick.notice)
    return { binary: this.binary!, pick, env: agyEnvironment(this.processEnv ?? process.env) }
  }

  protected launchAccount({ pick }: AgyLaunch): string {
    return pick.account
  }

  protected runDetails(run: AgyRun): Pick<BackendSessionInfo, 'details' | 'pickedAccount'> {
    return { pickedAccount: run.account }
  }

  // AGY§8 AGY§19
  protected scratchpadOf(run: AgyRun, entry: HistoryEntry): string | undefined {
    return run.brain && keyedOn(run.remote?.host, path.posix.join(run.brain, entry.id))
  }

  // AGY§12
  private learnBrain(run: AgyRun, artifactDir: unknown): void {
    if (typeof artifactDir !== 'string' || !artifactDir.startsWith('/')) return
    const brain = path.posix.dirname(artifactDir)
    if (run.brain === brain || path.posix.basename(brain) !== 'brain') return
    run.brain = brain
    if (!run.info) return
    run.info.scratchpadDir = this.scratchpadOf(run, { id: run.info.nativeSessionId!, cwd: run.cwd })
    this.changed()
  }

  // AGY§9 AGY§24
  private async heldElsewhere(conversationId: string): Promise<boolean> {
    const lock = path.join(this.gemini, AGY_APP_DIR, 'presence', `${conversationId}.lock`)
    if (!fs.existsSync(lock)) return false
    const { stdout } = await exec('lsof', ['-t', lock]).catch(() => ({ stdout: '' }))
    const ours = new Set([...this.runs.values()].map((r) => r.pid))
    return stdout
      .split('\n')
      .map(Number)
      .some((pid) => pid > 0 && !ours.has(pid))
  }

  protected async startRun(ctx: StartContext, launch: AgyLaunch): Promise<AgyRun> {
    const remote = parseRemoteKey(ctx.cwd)
    return remote ? this.startRemoteRun(ctx, launch, remote) : this.startLocalRun(ctx, launch)
  }

  private async startLocalRun(
    ctx: StartContext,
    { binary, pick, env }: AgyLaunch
  ): Promise<AgyRun> {
    const { opts, cwd, workspace, resource, freshWorktree, rules } = ctx
    const resumeId = opts.resumeSessionId ? this.nativeId(opts.resumeSessionId) : undefined
    const firstLine = firstLineToType(opts, resumeId)
    const apiKey = await this.deps.apiKeyOf(pick.account)
    if (resumeId && (await this.heldElsewhere(resumeId))) throw new Error(HELD_ELSEWHERE)
    this.assertStarting()
    const assist = this.deps.assistOf(cwd, opts.resumeSessionId)
    const conductor = opts.conductor || !!assist
    const role = opts.role ?? assist?.role
    if (conductor && (opts.trustFolder || assist)) seedAssistMemory(cwd)
    const permission = this.permissionOf(opts)
    const tabId = opts.tabId ?? this.deps.pty.nextId()
    const endpoint = this.deps.browserEndpoint(tabId)
    const agent = this.deps.agent.enabled() ? this.deps.agent : undefined
    const instructions = promptParts(
      !!agent && !conductor && this.deps.koloftPrompt(this.id, rules),
      role,
      ownerTextFor(ctx, conductor, assist)
    ).join('\n\n')
    const scripts = writeAgyScripts(this.deps.scriptsDir)
    const gemini = this.gemini
    // AGY§4
    prepareAgyHome(pick.home, gemini)
    // AGY§31
    this.deps.keepSkillsIn(path.join(pick.home, AGY_SKILLS), !!agent)
    // ADR-0026 AGY§5
    const trust = [cwd, workspace].filter((d, i, all) => all.indexOf(d) === i)
    const koloftWorktreeOfTrustedWorkspace = (): boolean =>
      !!resource?.managed && this.trustedHere(pick.home, workspace)
    const resumeInFolderAnAccountTrusts = (): boolean =>
      !!resumeId && anyAccountHomeTrusts(pick.home, cwd)
    mergeAgySettings(pick.home, gemini, {
      trust:
        freshWorktree || opts.trustFolder || assist || koloftWorktreeOfTrustedWorkspace()
          ? trust
          : resumeInFolderAnAccountTrusts()
            ? [cwd]
            : [],
      titleCommand: runWithSh(scripts.title),
      statusLine: this.deps.builtInStatusLine(pick.account),
      apiKey: !!apiKey,
      allowKoloft: !!agent,
      playwrightServers: ownersPlaywrightMcp(gemini),
      workbenchBrowser: !!endpoint
    })
    mergeAgyHooks(pick.home, gemini, koloftHookEntry(runWithSh(scripts.hook)))
    let bound: AgyRun | undefined
    const tools = startToolShim(
      { ...this.deps, ghWrapper: this.deps.gitAccounts.ghWrapper },
      {
        backend: 'agy',
        cannotWriteTheRequest: COULD_NOT_REACH_KOLOFT,
        open: (target) => this.deps.events(tabId, { type: 'open', target }),
        agent: agent && ((dir, name, raw) => agent.answer(bound?.tabId, dir, name, raw)),
        rules
      }
    )
    const dir = tools.shim.shimDir
    const log = path.join(dir, 'agy.jsonl')
    const startFile = path.join(dir, 'agy-session-start.json')
    try {
      fs.writeFileSync(log, '')
      if (instructions) fs.writeFileSync(startFile, sessionStartOutput(instructions))
      const token = randomBytes(24).toString('hex')
      const ownerTitle = ownersTitleCommand(gemini)
      const argv = [
        `--gemini_dir=${pick.home}`,
        `--csrf_token=${token}`,
        ...agyArgs(opts, resumeId, permission, firstLine)
      ]
      this.parsers.set(tabId, new ProgramStatusParser())
      const handle = this.deps.pty.create({
        id: tabId,
        kind: 'agy',
        koloftShim: false,
        finishEnv: withoutTheTerminalName,
        cwd,
        cols: opts.cols,
        rows: opts.rows,
        executable: binary,
        argv,
        aboveItsTools: true,
        // AGY§27
        banner: pick.banner,
        processEnv: {
          ...env,
          PWD: cwd,
          PATH: pathWithDirFirst(env.PATH, dir),
          ...agyAccountEnv(apiKey)
        },
        envSetForThisTab: {
          [AGY_LOG_ENV]: log,
          ...(instructions ? { [AGY_START_ENV]: startFile } : {}),
          [AGY_COST_ENV]: path.join(dir, 'agy-cost'),
          ...(this.deps.hookRegDir && { [NOTICE_ENV]: noticeFile(this.deps.hookRegDir, tabId) }),
          ...(ownerTitle ? { [AGY_OWNER_TITLE_ENV]: ownerTitle } : {}),
          ANT_ACCOUNT: pick.account,
          // AGY§30
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
        launchName: opts.name,
        givenTitle: opts.name,
        permission: opts.permission ?? 'default',
        bypassing: permission === 'bypass',
        firstLine,
        account: pick.account,
        brain: agyBrain(pick.home),
        pid,
        api: pid ? new AgyApi(pid, token) : undefined,
        dir,
        log: new LineTail(log, (line) => bound && this.onLogLine(bound, line)),
        touched: new Map(),
        liveWrites: 0,
        releaseTools: () => {
          tools.release()
          this.parsers.delete(handle.id)
        }
      }
      bound = run
      this.startTicking()
      return run
    } catch (error) {
      this.parsers.delete(tabId)
      tools.release()
      throw error
    }
  }

  private async startRemoteRun(
    ctx: StartContext,
    { pick }: AgyLaunch,
    where: RemoteKey
  ): Promise<AgyRun> {
    const { opts, cwd, workspace, resource, freshWorktree, rules } = ctx
    const { remote } = this.deps
    const machine = remote.machine(where.host)
    const resumeId = opts.resumeSessionId ? this.nativeId(opts.resumeSessionId) : undefined
    const firstLine = firstLineToType(opts, resumeId)
    if (
      resumeId &&
      (remote.gone(where.host, resumeId) || (await machine.tmux.endedByKoloft(resumeId))) &&
      (await agyHeldElsewhere(machine, resumeId))
    )
      throw new Error(HELD_ELSEWHERE)
    const [apiKey, config] = await Promise.all([
      this.deps.apiKeyOf(pick.account),
      readAgyConfig(machine, pick.account, remote.saidWhenTheMachineWantsAPasswordFirst)
    ])
    this.assertStarting()
    const tabId = opts.tabId ?? this.deps.pty.nextId()
    const permission = this.permissionOf(opts)
    const workspacePath = parseRemoteKey(workspace)?.path ?? where.path
    const koloftWorktreeOfTrustedWorkspace =
      !!resource?.managed && trustsIn(workspacePath, config.ownSettings, config.ownersSettings)
    const trusted = freshWorktree || opts.trustFolder || koloftWorktreeOfTrustedWorkspace
    const trust = [where.path, workspacePath].filter((d, i, all) => all.indexOf(d) === i)
    // ADR-0026 AGY§5
    const resumeInFolderAnAccountTrusts =
      !!resumeId && trustsIn(where.path, ...config.accountsSettings)
    const m = machine.packageName()
    const agentTools = this.deps.agent.enabled()
    const settings = mergedAgySettings(config.ownSettings, config.ownersSettings, {
      trust: trusted ? trust : resumeInFolderAnAccountTrusts ? [where.path] : [],
      titleCommand: runMachineScript(m, AGY_TITLE_FILE),
      statusLine: this.deps.builtInStatusLine(pick.account)
        ? runMachineScript(m, AGY_STATUSLINE_FILE)
        : undefined,
      apiKey: !!apiKey,
      allowKoloft: agentTools,
      playwrightServers: [],
      workbenchBrowser: false
    })
    const hooks = mergedAgyHooks(
      config.ownersHooks,
      koloftHookEntry(runMachineScript(m, AGY_HOOK_FILE))
    )
    const instructions = promptParts(
      agentTools && this.deps.koloftPrompt(this.id, rules),
      opts.role,
      ownerTextFor(ctx, false)
    ).join('\n\n')
    const ownerTitle = titleCommandIn(config.ownersSettings)
    const signIn = apiKey ? undefined : readText(agyTokenFile(pick.home))
    const plan = await launchAgy(machine, {
      tabId,
      cwd,
      resumeId,
      env: {
        ANT_ACCOUNT: pick.account,
        ...(apiKey ? { [AGY_KEY_FROM_KOLOFT]: apiKey } : {}),
        ...(signIn ? { [AGY_SIGN_IN_FROM_KOLOFT]: signIn } : {}),
        ...(ownerTitle ? { [AGY_OWNER_TITLE_ENV]: ownerTitle } : {})
      },
      program: agyTab({
        tabId,
        account: pick.account,
        banner: pick.banner,
        args: [
          `--csrf_token=${randomBytes(24).toString('hex')}`,
          ...agyArgs(opts, resumeId, permission, firstLine)
        ],
        settings: agyJsonText(settings),
        hooks: agyJsonText(hooks),
        onboarding: readText(agyOnboardingFile(pick.home)),
        start: instructions ? sessionStartOutput(instructions) : undefined,
        koloftSkill: agentTools
      }),
      portOffset: resource ? portOffset(resource.worktreeName) : undefined
    })
    const handle = this.deps.pty.create({
      id: tabId,
      kind: 'agy',
      koloftShim: { hookSettings: (tabId) => remote.hookSettings(tabId) },
      cwd: plan.spawnCwd,
      cols: opts.cols,
      rows: opts.rows,
      shell: plan.shell,
      setupCommand: remote.setupLine(),
      launchCommand: () => plan.launchCommand(),
      resumeSessionId: opts.resumeSessionId,
      resized: plan.resized,
      remoteHost: where.host
    })
    const mirror = remote.mirrorDir(where.host)
    const attachTo = plan.attach ? resumeId : undefined
    const logFile = path.join(
      mirror,
      (attachTo && attachedLog(mirror, attachTo)) || agyLogName(tabId)
    )
    const alreadyThere = attachTo ? logTail(logFile) : { size: 0, text: '' }
    const run: AgyRun = {
      tabId: handle.id,
      cwd,
      workspace,
      resource,
      explicitStop: false,
      resumeKey: opts.resumeSessionId,
      permission: opts.permission ?? 'default',
      bypassing: permission === 'bypass',
      firstLine,
      account: pick.account,
      remote: { host: where.host, tmuxName: plan.tmuxName },
      log: new LineTail(logFile, (line) => this.onLogLine(run, line), alreadyThere.size),
      touched: new Map(),
      liveWrites: 0,
      releaseTools: () => undefined
    }
    if (attachTo)
      setImmediate(() => {
        if (this.runs.get(run.tabId) !== run || run.explicitStop || run.stopping) return
        this.bindTo(run, attachTo)
        this.showLastState(run, alreadyThere.text)
      })
    void remote.nextPull(where.host)
    return run
  }

  private startTicking(): void {
    this.ticking ??= setInterval(() => this.tick(), TICK_MS)
    this.ticking.unref?.()
  }

  protected async endRun(run: AgyRun): Promise<void> {
    run.stream?.close()
    this.stopTitleChase(run)
    if (run.compacting?.timer) clearTimeout(run.compacting.timer)
    this.clearForeignTimers(run)
    if (!run.remote || this.shuttingDown) return
    const { host, tmuxName } = run.remote
    const machine = this.deps.remote.machine(host)
    // ADR-0044
    const named = await machine.runScript(TAB_TMUX_NAME_SH, [run.tabId])
    const problem = await machine.tmux.end(named?.trim() || tmuxName, run.tabId)
    if (problem)
      this.deps.error(
        `Could not stop Antigravity on ${host}: ${problem}. It is still running there.`
      )
  }

  private tick(): void {
    if (![...this.runs.values()].some((r) => !r.remote) && this.ticking) {
      clearInterval(this.ticking)
      this.ticking = undefined
      return
    }
    for (const run of this.runs.values()) {
      if (run.explicitStop || run.remote) continue
      run.log.read()
      if (
        [...(run.commands?.values() ?? [])].some(
          (c) => c.shown && c.item.kind === 'server' && c.startTime !== undefined
        )
      )
        this.publishBackground(run)
    }
  }

  private dropSpawnsOf(
    run: AgyRun,
    drop: (spawn: PendingSpawn) => boolean,
    includeRecent = true
  ): boolean {
    let changed = false
    if (run.pendingSpawns?.length) {
      const next = run.pendingSpawns.filter((s) => !drop(s))
      if (next.length !== run.pendingSpawns.length) {
        run.pendingSpawns = next.length ? next : undefined
        changed = true
      }
    }
    if (includeRecent && run.recentSpawns?.length) {
      const next = run.recentSpawns.filter((s) => !drop(s))
      if (next.length !== run.recentSpawns.length) {
        run.recentSpawns = next.length ? next : undefined
      }
    }
    return changed
  }

  // AGY§11 AGY§13 AGY§19
  private settleCommands(
    run: AgyRun,
    { conversationId, agentState, taskCount, subagents }: AgyTitleState,
    replaying = false,
    wasConfirming = false
  ): void {
    if (taskCount !== undefined) run.countsTasks = true
    if (agentState !== 'idle' && agentState !== 'reviewing') return
    let changed = false
    const hasActiveTitleSubagent = subagents?.some(
      (s) => !FINISHED_TITLE_STATES.has((s.state ?? '').toLowerCase())
    )
    const blocked =
      !replaying &&
      (run.shown === 'blocked' ||
        ((this.deps.runtime.turn(run.tabId) === 'approval' ||
          this.deps.runtime.turn(run.tabId) === 'input' ||
          !!run.exitedAskToIdle) &&
          !run.waiting?.plan))
    if (!replaying && (!conversationId || conversationId === run.info?.nativeSessionId))
      run.exitedAskToIdle = false
    const declinedConfirm = wasConfirming || blocked
    const canPruneSpawns =
      declinedConfirm ||
      (subagents !== undefined && !hasActiveTitleSubagent) ||
      !(run.countsTasks && (taskCount ?? 0) > 0)
    if (!hasActiveTitleSubagent && canPruneSpawns) {
      if (
        this.dropSpawnsOf(
          run,
          (s) => s.parentId === conversationId,
          declinedConfirm || subagents !== undefined
        )
      )
        changed = true
    } else if (!hasActiveTitleSubagent && (declinedConfirm || subagents !== undefined)) {
      if (run.recentSpawns?.length) {
        const next = run.recentSpawns.filter((s) => s.parentId !== conversationId)
        run.recentSpawns = next.length ? next : undefined
      }
    }
    if (declinedConfirm && (!taskCount || !run.api || replaying))
      this.pruneUnconfirmedTasksFor(run, conversationId)
    if (!run.commands?.size && !run.schedules?.size) {
      if (
        run.unattributedBackground &&
        run.countsTasks &&
        !taskCount &&
        subagents !== undefined &&
        subagents.length === 0 &&
        !run.children?.size &&
        !run.pendingSpawns?.length
      ) {
        run.unattributedBackground = false
        changed = true
      }
      if (changed && !replaying) this.publishBackground(run)
      return
    }
    if (run.api && !replaying) {
      if (changed) this.publishBackground(run)
      return this.askCommands(run, declinedConfirm ? conversationId : undefined)
    }
    const myCommands = commandsOf(run, conversationId)
    const mySchedules = schedulesOf(run, conversationId)
    if (!taskCount && run.countsTasks) {
      const dropped = this.dropTasks(
        run,
        myCommands.map(([id]) => id),
        mySchedules.map(([id]) => id),
        replaying
      )
      if (changed && !dropped && !replaying) this.publishBackground(run)
      return
    }
    for (const [, command] of myCommands) command.shown ||= !!command.ran
    for (const [, schedule] of mySchedules) schedule.shown ||= !!schedule.ran
    this.syncWakeupPending(run)
    if (!replaying) this.publishBackground(run)
  }

  // AGY§13 AGY§16
  private askCommands(run: AgyRun, pruneDeclinedFor?: string): void {
    if (run.askingCommands) {
      run.askCommandsAgain = {
        run: true,
        pruneFor: pruneDeclinedFor ?? run.askCommandsAgain?.pruneFor
      }
      return
    }
    const asked = new Set([...(run.commands?.keys() ?? []), ...(run.schedules?.keys() ?? [])])
    const conversations = new Set([...asked].map((id) => id.split('/')[0]))
    if (!conversations.size) return
    run.askingCommands = true
    void Promise.all(
      [...conversations].map((id) => run.api!.backgroundTasks(id).then((tasks) => ({ id, tasks })))
    )
      .then((lists) => {
        if (this.runs.get(run.tabId) !== run || run.explicitStop) return
        for (const { id, tasks } of lists) this.applyApiTasks(run, id, tasks, false, true, asked)
        this.publishBackground(run)
      })
      .catch(() => {
        if (!pruneDeclinedFor || this.runs.get(run.tabId) !== run || run.explicitStop) return
        if (this.pruneUnconfirmedTasksFor(run, pruneDeclinedFor)) this.publishBackground(run)
      })
      .finally(() => {
        run.askingCommands = false
        const next = run.askCommandsAgain
        run.askCommandsAgain = undefined
        if (next?.run && this.runs.get(run.tabId) === run && !run.explicitStop)
          this.askCommands(run, next.pruneFor)
      })
  }

  private applyApiTasks(
    run: AgyRun,
    conversationId: string,
    tasks: AgyBackgroundTask[],
    publish = true,
    dropUnshown = true,
    asked?: ReadonlySet<string>
  ): void {
    const live = new Set(tasks.map((t) => t.taskId))
    for (const task of tasks) {
      const richLabel = (task.description || task.toolSummary || '').slice(
        0,
        BACKGROUND_LABEL_CHARS
      )
      if (task.toolName === 'schedule') {
        const existing = run.schedules?.get(task.taskId)
        if (existing) {
          existing.shown = true
          existing.ran = true
          if (task.isDaemon !== undefined) existing.isDaemon = task.isDaemon
          existing.item.state = 'waiting'
          if (richLabel) existing.item.label = richLabel
          if (task.startTime !== undefined) existing.startTime = task.startTime
        } else {
          const isDaemon = task.isDaemon === true
          const label = richLabel || 'Scheduled task'
          ;(run.schedules ??= new Map()).set(task.taskId, {
            item: {
              id: task.taskId,
              kind: 'monitor',
              label,
              state: 'waiting'
            },
            shown: true,
            ran: true,
            isDaemon,
            startTime: task.startTime
          })
        }
      } else {
        const existing = run.commands?.get(task.taskId)
        if (existing) {
          existing.shown = true
          existing.ran = true
          if (task.isDaemon !== undefined) {
            existing.item.kind = task.isDaemon ? 'server' : 'command'
            existing.item.state = task.isDaemon ? 'waiting' : 'working'
          }
          if (richLabel) existing.item.label = richLabel
          if (task.startTime !== undefined) existing.startTime = task.startTime
        } else {
          const isDaemon = task.isDaemon === true
          const label = richLabel || 'Background command'
          ;(run.commands ??= new Map()).set(task.taskId, {
            item: {
              id: task.taskId,
              label,
              ...(isDaemon
                ? { kind: 'server', state: 'waiting' }
                : { kind: 'command', state: 'working' })
            },
            shown: true,
            ran: true,
            startTime: task.startTime
          })
        }
      }
    }
    const canDrop = (id: string, shown: boolean): boolean =>
      !live.has(id) && (shown || (dropUnshown && (!asked || asked.has(id))))
    const deadCommands = commandsOf(run, conversationId)
      .filter(([id, c]) => canDrop(id, c.shown))
      .map(([id]) => id)
    const deadSchedules = schedulesOf(run, conversationId)
      .filter(([id, s]) => canDrop(id, s.shown))
      .map(([id]) => id)
    for (const id of deadCommands) run.commands?.delete(id)
    for (const id of deadSchedules) run.schedules?.delete(id)
    this.syncWakeupPending(run)
    if (publish) this.publishBackground(run)
  }

  // AGY§12 AGY§13
  private sortAnswered(
    run: AgyRun,
    conversationId: string,
    input: Record<string, unknown>,
    replaying = false
  ): void {
    const myCommands = commandsOf(run, conversationId)
    const mySchedules = schedulesOf(run, conversationId)
    if (input.invocationNum !== 0) {
      let revealed = false
      for (const [, command] of myCommands) {
        command.ran = true
        if (!command.shown) {
          command.shown = true
          revealed = true
        }
      }
      for (const [, schedule] of mySchedules) {
        schedule.ran = true
        if (!schedule.shown) {
          schedule.shown = true
          revealed = true
        }
      }
      this.syncWakeupPending(run)
      if (revealed && !replaying) this.publishBackground(run)
    } else {
      const declinedCommands = myCommands
        .filter(([, command]) => !command.ran && !command.shown)
        .map(([id]) => id)
      const declinedSchedules = mySchedules
        .filter(([, schedule]) => !schedule.ran && !schedule.shown)
        .map(([id]) => id)
      const spawnDropped = this.dropSpawnsOf(run, (s) => s.parentId === conversationId)
      const dropped = this.dropTasks(run, declinedCommands, declinedSchedules, replaying)
      if (spawnDropped && !dropped && !replaying) this.publishBackground(run)
    }
  }

  private dropTasks(
    run: AgyRun,
    commandIds: string[],
    scheduleIds: string[],
    replaying = false
  ): boolean {
    let changed = false
    for (const id of commandIds) if (run.commands?.delete(id)) changed = true
    for (const id of scheduleIds) if (run.schedules?.delete(id)) changed = true
    this.syncWakeupPending(run)
    if (changed && !replaying) this.publishBackground(run)
    return changed
  }

  private syncWakeupPending(run: AgyRun): void {
    const confirmed = [...(run.schedules?.values() ?? [])].some((s) => s.shown || s.ran)
    this.deps.runtime.setWakeupPending(run.tabId, confirmed)
  }

  private hasActiveAttributed(run: AgyRun): boolean {
    for (const c of run.commands?.values() ?? [])
      if (c.shown && c.item.state === 'working') return true
    for (const s of run.schedules?.values() ?? []) if (s.shown && !s.isDaemon) return true
    for (const ch of run.children?.values() ?? []) if (ch.state === 'working') return true
    return (run.pendingSpawns?.length ?? 0) > 0
  }

  private publishBackground(run: AgyRun): void {
    const items: BackgroundItem[] = []
    let hasExplainedNonIdle = false
    let idleTeammates = 0
    for (const ch of run.children?.values() ?? []) {
      if (ch.state === 'working') {
        items.push({ id: ch.id, kind: 'agent', label: ch.label, state: 'working' })
        hasExplainedNonIdle = true
      } else {
        idleTeammates++
      }
    }
    for (const sp of run.pendingSpawns ?? []) {
      items.push({ id: sp.id, kind: 'agent', label: sp.label, state: 'working' })
      hasExplainedNonIdle = true
    }
    const now = Date.now()
    for (const c of run.commands?.values() ?? []) {
      if (!c.shown) continue
      const item: BackgroundItem =
        c.item.kind === 'server' && c.startTime !== undefined
          ? {
              ...c.item,
              ageMs: Math.floor(Math.max(0, now - c.startTime) / 60_000) * 60_000
            }
          : c.item
      if (item.state === 'working') hasExplainedNonIdle = true
      items.push(item)
    }
    for (const s of run.schedules?.values() ?? []) {
      if (!s.shown) continue
      if (!s.isDaemon) hasExplainedNonIdle = true
      items.push(s.item)
    }
    if (idleTeammates > 0)
      items.push({
        id: 'teammates',
        kind: 'teammate',
        label: `${idleTeammates} idle`,
        state: 'waiting'
      })
    if (run.unattributedBackground && !hasExplainedNonIdle)
      items.push({
        id: 'agy-background',
        kind: 'agent',
        label: 'Active background task',
        state: 'working'
      })
    this.deps.events(run.tabId, {
      type: 'background-changed',
      items
    })
  }

  foldersToMirrorFrom(host: string, landing: string): MirrorFolder[] {
    return this.usesHost(host) ? agyFoldersToMirror(landing) : []
  }

  // AGY§29
  mirrorPulled(host: string): void {
    for (const run of this.runs.values())
      if (run.remote?.host === host && !run.explicitStop) run.log.read()
  }

  noticeRemoteExits(host: string, sessionIds: string[]): void {
    for (const run of this.runs.values()) {
      const sid = run.info?.nativeSessionId
      if (run.remote?.host !== host || !sid || !sessionIds.includes(sid)) continue
      setTimeout(() => {
        const still = this.runs.get(run.tabId) === run && run.info?.nativeSessionId === sid
        if (!still || !this.deps.remote.gone(host, sid)) return
        void this.stop(run.tabId, 1).catch((error) => this.deps.error(String(error)))
      }, REMOTE_EXIT_WAIT_MS).unref()
    }
  }

  tmuxOfTab(tabId: string): string | undefined {
    return this.runs.get(tabId)?.remote?.tmuxName
  }

  tabOnMachine(host: string, tmuxName: string, launchTab: string): string | undefined {
    for (const run of this.runs.values()) {
      if (run.remote?.host !== host || run.explicitStop) continue
      if ((tmuxName && run.remote.tmuxName === tmuxName) || run.tabId === launchTab)
        return run.tabId
    }
    return undefined
  }

  // AGY§11 AGY§12
  private showLastState(run: AgyRun, earlierLog: string): void {
    let last: ProgramStatus | undefined
    let reviewing = false
    for (const read of earlierLog.split('\n').map((line) => agyLogLine(line))) {
      if (!read) continue
      if ('hook' in read && read.hook.event === 'PreToolUse') this.onHook(run, read.hook)
      if ('title' in read && read.title.conversationId === run.info?.nativeSessionId)
        reviewing = read.title.agentState === 'reviewing'
      last = remoteStatus(run, read) ?? last
      if (last) run.shown = last.state
    }
    if (last) this.emitState(run, last.state === 'done' ? { state: 'idle' } : last)
    // AGY§19
    if (reviewing) void this.readPlan(run)
    this.replayTasks(run)
  }

  private resetTransientForSwitch(run: AgyRun, nextId: string): void {
    run.unattributedBackground = false
    run.mainTurnActive = false
    run.exitedAskToIdle = false
    run.pendingSpawns = undefined
    run.recentSpawns = undefined
    run.knownChildren = undefined
    for (const [id, ch] of [...(run.children ?? [])]) {
      if (ch.fromTitle || id === nextId) this.removeChild(run, id)
    }
    run.wokenBySend = undefined
  }

  // AGY§11 AGY§13
  private replayTasks(run: AgyRun): void {
    const mainId = run.info?.nativeSessionId
    const titleIds = new Set<string>()
    const entries: AgyLogLine[] = []
    for (const line of readReplayLines(run.log.file)) {
      const isTitleLine = line.includes('"conversation_id"')
      if (!isTitleLine && !TASK_LINE_MARKS.some((mark) => line.includes(mark))) continue
      const read = agyLogLine(line)
      if (!read) continue
      if ('title' in read && read.title.conversationId) titleIds.add(read.title.conversationId)
      entries.push(read)
    }
    let activeConv: string | undefined
    let mainSeen = false
    let prevTitle: AgyTitleState | undefined
    for (const read of entries) {
      if ('hook' in read) {
        const { hook } = read
        if (hook.conversationId === mainId) {
          mainSeen = true
          if (activeConv !== mainId) {
            if (activeConv !== undefined) {
              this.resetTransientForSwitch(run, hook.conversationId)
              prevTitle = undefined
            }
            activeConv = mainId
          }
          this.trackTasks(run, hook, true, activeConv)
          this.applyMainLifecycleHook(run, hook, true)
        } else if (
          !mainSeen &&
          !hook.parentConversationId &&
          !hook.rootConversationId &&
          (titleIds.has(hook.conversationId) ||
            (hook.event === 'SessionStart' &&
              !run.children?.has(hook.conversationId) &&
              !run.pendingSpawns?.length &&
              !run.recentSpawns?.length))
        ) {
          if (activeConv !== undefined && hook.conversationId !== activeConv) {
            this.resetTransientForSwitch(run, hook.conversationId)
            prevTitle = undefined
          }
          activeConv = hook.conversationId
          this.trackTasks(run, hook, true, activeConv)
          this.applyMainLifecycleHook(run, hook, true)
        } else if (activeConv && this.isAttributedChild(run, hook, activeConv)) {
          this.trackTasks(run, hook, true, activeConv)
          this.onChildHook(run, hook, true, activeConv)
        } else if (
          !mainSeen &&
          !hook.parentConversationId &&
          !hook.rootConversationId &&
          (activeConv === undefined ||
            hook.conversationId === activeConv ||
            hook.event === 'SessionStart')
        ) {
          if (activeConv !== undefined && hook.conversationId !== activeConv) {
            this.resetTransientForSwitch(run, hook.conversationId)
            prevTitle = undefined
          }
          activeConv = hook.conversationId
          this.trackTasks(run, hook, true, activeConv)
          this.applyMainLifecycleHook(run, hook, true)
        } else if (hook.event === 'PostToolUse') {
          this.trackTasks(run, hook, true, activeConv)
        }
      } else {
        const tid = read.title.conversationId
        if (!tid) continue
        if (tid === mainId) {
          mainSeen = true
          if (activeConv !== undefined && activeConv !== mainId) {
            this.resetTransientForSwitch(run, mainId)
            prevTitle = undefined
          }
          activeConv = mainId
        } else if (!mainSeen && (activeConv === undefined || tid !== activeConv)) {
          if (activeConv !== undefined) {
            this.resetTransientForSwitch(run, tid)
            prevTitle = undefined
          }
          activeConv = tid
        }
        if (tid === activeConv) {
          const wasConfirming =
            prevTitle?.agentState === 'tool_use' && !!prevTitle.confirmationPending
          prevTitle = read.title
          if (read.title.agentState === 'idle' || read.title.agentState === 'reviewing')
            run.mainTurnActive = false
          if (read.title.subagents !== undefined)
            this.reconcileTitleSubagents(run, read.title.subagents, true, activeConv)
          this.settleCommands(run, read.title, true, wasConfirming)
        }
      }
    }
    this.syncWakeupPending(run)
    this.publishBackground(run)
  }

  // AGY§11 AGY§12
  private onLogLine(run: AgyRun, line: string): void {
    const read = agyLogLine(line)
    if (!read) return
    if ('hook' in read) this.learnBrain(run, read.hook.input.artifactDirectoryPath)
    if ('hook' in read && !run.info && !run.explicitStop) this.bindTo(run, read.hook.conversationId)
    if ('hook' in read) {
      const { hook } = read
      const mainId = run.info?.nativeSessionId
      if (!mainId || hook.conversationId === mainId) {
        this.trackTasks(run, hook)
        this.onHook(run, hook)
      } else if (this.isAttributedChild(run, hook)) {
        this.trackTasks(run, hook)
        this.onChildHook(run, hook)
      } else if (run.remote || run.foreignChecked?.has(hook.conversationId)) {
        if (hook.event === 'PostToolUse') this.trackTasks(run, hook)
      } else {
        if (hook.event === 'PostToolUse') this.trackTasks(run, hook)
        const buf = (run.pendingForeignHooks ??= new Map()).get(hook.conversationId) ?? []
        if (buf.length < FOREIGN_BUFFER_MAX || hook.event === 'Stop') buf.push(hook)
        run.pendingForeignHooks.set(hook.conversationId, buf)
        if (!run.foreignResolving?.has(hook.conversationId)) {
          ;(run.foreignResolving ??= new Set()).add(hook.conversationId)
          void this.resolveChildFromDb(run, hook.conversationId)
        }
      }
    } else this.onTitle(run, read.title)
    const status = run.remote && run.info && !run.explicitStop && remoteStatus(run, read)
    if (status && status.state !== run.shown) {
      run.shown = status.state
      this.emitState(run, status)
    }
  }

  private clearForeignTimers(run: AgyRun): void {
    for (const timer of run.foreignTimers?.values() ?? []) clearTimeout(timer)
    run.foreignTimers = undefined
  }

  private async resolveChildFromDb(run: AgyRun, childId: string): Promise<void> {
    let retrying = false
    try {
      const ancestry = await ancestryOfAgyConversation(this.gemini, childId).catch(() => undefined)
      if (
        this.runs.get(run.tabId) !== run ||
        run.explicitStop ||
        run.stopping ||
        !run.pendingForeignHooks?.has(childId)
      )
        return
      const mainId = run.info?.nativeSessionId
      const belongs =
        !!mainId &&
        !!ancestry &&
        (ancestry.ancestors.includes(mainId) ||
          ancestry.ancestors.some((a) => run.children?.has(a) || run.knownChildren?.has(a)))
      if (belongs && !ancestry.killed) {
        const buffered = run.pendingForeignHooks.get(childId) ?? []
        run.pendingForeignHooks.delete(childId)
        run.foreignTries?.delete(childId)
        for (const hook of buffered) {
          const attributed: AgyHook = {
            ...hook,
            parentConversationId: ancestry.parentId,
            ...(ancestry.agentName && !hook.agentName ? { agentName: ancestry.agentName } : {})
          }
          if (hook.event !== 'PostToolUse') this.trackTasks(run, attributed)
          this.onChildHook(run, attributed)
        }
      } else if (ancestry) {
        run.pendingForeignHooks.delete(childId)
        run.foreignTries?.delete(childId)
        ;(run.foreignChecked ??= new Set()).add(childId)
      } else {
        const tries = (run.foreignTries?.get(childId) ?? 0) + 1
        ;(run.foreignTries ??= new Map()).set(childId, tries)
        if (tries >= FOREIGN_DB_MAX_TRIES) {
          run.pendingForeignHooks.delete(childId)
          run.foreignTries.delete(childId)
          ;(run.foreignChecked ??= new Set()).add(childId)
        } else {
          retrying = true
          const timer = setTimeout(() => {
            run.foreignTimers?.delete(childId)
            if (
              this.runs.get(run.tabId) !== run ||
              run.explicitStop ||
              run.stopping ||
              !run.pendingForeignHooks?.has(childId)
            ) {
              run.foreignResolving?.delete(childId)
              return
            }
            void this.resolveChildFromDb(run, childId)
          }, FOREIGN_DB_RETRY_MS)
          timer.unref?.()
          ;(run.foreignTimers ??= new Map()).set(childId, timer)
        }
      }
    } finally {
      if (!retrying) run.foreignResolving?.delete(childId)
    }
  }

  // AGY§9 AGY§11 AGY§19
  private onTitle(run: AgyRun, state: AgyTitleState): void {
    if (run.explicitStop || run.stopping) return
    // AGY§31
    if (run.firstLine && state.agentState === 'idle') {
      this.deps.pty.write(run.tabId, bracketedPaste(run.firstLine) + '\r')
      run.firstLine = undefined
    }
    const before = run.title
    const wasConfirming = before?.agentState === 'tool_use' && !!before.confirmationPending
    run.title = state
    if (state.conversationId && run.info?.nativeSessionId !== state.conversationId)
      this.bindTo(run, state.conversationId)
    if (!run.info) return
    if (
      (state.agentState === 'idle' || state.agentState === 'reviewing') &&
      (!state.conversationId || state.conversationId === run.info.nativeSessionId)
    )
      run.mainTurnActive = false
    if (state.subagents !== undefined) this.reconcileTitleSubagents(run, state.subagents)
    this.settleCommands(run, state, false, wasConfirming)
    if (state.title && state.title !== before?.title) {
      run.givenTitle = undefined
      this.stopTitleChase(run)
      this.retitle(run.info, state.title)
    } else if (
      state.agentState === 'working' &&
      before?.agentState !== 'working' &&
      !run.givenTitle &&
      run.info.title === PLACEHOLDER_TITLES.agy &&
      run.info.nativeSessionId &&
      run.workingTitleChasedFor !== run.info.nativeSessionId &&
      !this.history.get(agySessionKey(run.info.nativeSessionId, run.remote?.host))?.name
    ) {
      run.workingTitleChasedFor = run.info.nativeSessionId
      this.chaseListedTitle(run, run.info.nativeSessionId, true)
    }
    // AGY§19
    if (state.agentState === 'reviewing' && before?.agentState !== 'reviewing')
      void this.readPlan(run)
    else if (state.agentState !== 'reviewing' && run.waiting?.plan) run.waiting = undefined
  }

  private reconcileTitleSubagents(
    run: AgyRun,
    subagents: NonNullable<AgyTitleState['subagents']>,
    replaying = false,
    activeMainId = run.info?.nativeSessionId
  ): void {
    let changed = false
    if (subagents.length === 0) {
      for (const [id, ch] of [...(run.children ?? [])]) {
        if (ch.fromTitle) {
          this.removeChild(run, id)
          changed = true
        }
      }
      if (changed && !replaying) this.publishBackground(run)
      return
    }
    const hadRealChildren = [...(run.children?.values() ?? [])].some((ch) => !ch.fromTitle)
    const hadPendingSpawns = (run.pendingSpawns?.length ?? 0) > 0
    const seenIds = new Set<string>()
    subagents.forEach((sub, idx) => {
      const st = (sub.state ?? '').toLowerCase()
      const label = titleSubagentLabel(sub)
      if (FINISHED_TITLE_STATES.has(st)) {
        if (sub.id && run.children?.has(sub.id)) {
          this.removeChild(run, sub.id)
          changed = true
        }
        return
      }
      const nextState: 'working' | 'waiting' = IDLE_TITLE_STATES.has(st) ? 'waiting' : 'working'
      if (sub.id) {
        seenIds.add(sub.id)
        const existing = run.children?.get(sub.id)
        if (existing) {
          if (existing.state !== nextState) {
            existing.state = nextState
            changed = true
          }
          if (label !== 'Subagent' && existing.label === 'Subagent') {
            existing.label = label
            changed = true
          }
          if (nextState === 'working' && run.unattributedBackground) {
            run.unattributedBackground = false
            changed = true
          }
        } else {
          const spawn = this.claimSpawn(run, activeMainId ?? '', true, false)
          ;(run.children ??= new Map()).set(sub.id, {
            id: sub.id,
            parentId: spawn?.parentId ?? activeMainId ?? '',
            label: spawn?.label ?? label,
            state: nextState,
            isSwarm: spawn?.isSwarm,
            swarmGroup: spawn?.swarmGroup,
            fromTitle: true,
            needsRecentClaim: !spawn && !!run.recentSpawns?.length
          })
          if (nextState === 'working') run.unattributedBackground = false
          changed = true
        }
      } else if (!hadRealChildren && !hadPendingSpawns) {
        const id = `title-subagent:${idx}`
        seenIds.add(id)
        const existing = run.children?.get(id)
        if (existing) {
          if (existing.label !== label || existing.state !== nextState) {
            existing.label = label
            existing.state = nextState
            changed = true
          }
          if (nextState === 'working' && run.unattributedBackground) {
            run.unattributedBackground = false
            changed = true
          }
        } else {
          ;(run.children ??= new Map()).set(id, {
            id,
            parentId: activeMainId ?? '',
            label,
            state: nextState,
            fromTitle: true
          })
          if (nextState === 'working') run.unattributedBackground = false
          changed = true
        }
      }
    })
    for (const [id, ch] of [...(run.children ?? [])]) {
      if (ch.fromTitle && !seenIds.has(id)) {
        this.removeChild(run, id)
        changed = true
      }
    }
    if (changed && !replaying) this.publishBackground(run)
  }

  private bindTo(run: AgyRun, conversationId: string): void {
    const key = agySessionKey(conversationId, run.remote?.host)
    const known = this.history.get(key)
    const switched = !!run.info && !!known
    const earlyHooks = run.pendingForeignHooks?.get(conversationId)
    if (run.info) run.givenTitle = undefined
    this.stopTitleChase(run)
    run.workingTitleChasedFor = undefined
    run.touched.clear()
    run.liveWrites = 0
    this.resetTransientForSwitch(run, conversationId)
    this.clearForeignTimers(run)
    run.foreignChecked = undefined
    run.foreignTries = undefined
    run.foreignResolving = undefined
    run.pendingForeignHooks = undefined
    run.waiting = undefined
    run.shown = undefined
    run.lastTitleState = undefined
    this.endCompaction(run)
    run.stream?.close()
    run.stream = undefined
    if (run.remote) run.remote.tmuxName = tmuxSessionName(conversationId)
    const resumed = !!known || (!!run.resumeKey && this.nativeId(run.resumeKey) === conversationId)
    const historyReadable = !resumed
      ? undefined
      : run.remote
        ? this.deps.remote.nextPull(run.remote.host)
        : Promise.resolve()
    run.transcript = new TranscriptFollower(
      agyTranscript(this.geminiOf(run.cwd), conversationId),
      historyReadable
    )
    this.bind(run, known ?? { id: conversationId, cwd: run.cwd }, switched ? 'switch' : 'replace')
    this.watchApiState(run)
    if (earlyHooks?.length) {
      for (const hook of earlyHooks) {
        if (hook.event !== 'PostToolUse') this.trackTasks(run, hook)
        this.onHook(run, hook)
      }
    }
    if (run.commands?.size || run.schedules?.size || run.children?.size) this.publishBackground(run)
    this.syncWakeupPending(run)
    void this.refreshHistory().catch(() => undefined)
    // AGY§10
    const before = run.statesBeforeBind ?? []
    run.statesBeforeBind = undefined
    if (run.stopping) return
    const replayed = before.length > 1 && before[0].state === 'idle' ? before.slice(1) : before
    for (const status of replayed) this.emitState(run, status)
  }

  private isAttributedChild(
    run: AgyRun,
    hook: AgyHook,
    mainId = run.info?.nativeSessionId
  ): boolean {
    if (!mainId || hook.conversationId === mainId) return false
    if (run.children?.has(hook.conversationId) || run.knownChildren?.has(hook.conversationId))
      return true
    if (
      hook.parentConversationId &&
      (hook.parentConversationId === mainId ||
        run.children?.has(hook.parentConversationId) ||
        run.knownChildren?.has(hook.parentConversationId))
    )
      return true
    if (hook.rootConversationId === mainId) return true
    return (
      hook.event === 'SessionStart' &&
      ((run.pendingSpawns?.length ?? 0) > 0 ||
        (run.recentSpawns?.length ?? 0) > 0 ||
        !!run.mainTurnActive)
    )
  }

  private claimSpawn(
    run: AgyRun,
    parentId: string,
    allowAnyParent = false,
    includeRecent = true
  ): PendingSpawn | undefined {
    const take = (
      list: PendingSpawn[] | undefined,
      idx: number,
      clear: () => void
    ): PendingSpawn | undefined => {
      if (!list || idx < 0 || idx >= list.length) return undefined
      const picked = list.splice(idx, 1)[0]
      if (!list.length) clear()
      return picked
    }
    const pending = run.pendingSpawns
    const recent = includeRecent ? run.recentSpawns : undefined
    const pIdx = pending?.findIndex((s) => s.parentId === parentId) ?? -1
    if (pIdx >= 0) return take(pending, pIdx, () => (run.pendingSpawns = undefined))
    const rIdx = recent?.findIndex((s) => s.parentId === parentId) ?? -1
    if (rIdx >= 0) return take(recent, rIdx, () => (run.recentSpawns = undefined))
    if (allowAnyParent) {
      if (!run.mainTurnActive && pending?.length)
        return take(pending, 0, () => (run.pendingSpawns = undefined))
      if (recent?.length) return take(recent, 0, () => (run.recentSpawns = undefined))
    }
    return undefined
  }

  private rememberChild(run: AgyRun, child: AgyChild): void {
    ;(run.knownChildren ??= new Map()).set(child.id, {
      parentId: child.parentId,
      label: child.label,
      isSwarm: child.isSwarm,
      swarmGroup: child.swarmGroup
    })
  }

  private ensureChild(
    run: AgyRun,
    hook: AgyHook,
    activeMainId = run.info?.nativeSessionId
  ): AgyChild {
    run.unattributedBackground = false
    const existing = run.children?.get(hook.conversationId)
    if (existing) {
      existing.fromTitle = false
      if (existing.needsRecentClaim) {
        existing.needsRecentClaim = false
        if (run.recentSpawns?.length) {
          const parentId = hook.parentConversationId ?? existing.parentId ?? activeMainId ?? ''
          let idx = run.recentSpawns.findIndex((s) => s.parentId === parentId)
          if (idx < 0 && !hook.parentConversationId) idx = 0
          if (idx >= 0) {
            const [spawn] = run.recentSpawns.splice(idx, 1)
            if (!run.recentSpawns.length) run.recentSpawns = undefined
            existing.parentId = spawn.parentId
            existing.label = spawn.label
            existing.isSwarm ||= spawn.isSwarm
            existing.swarmGroup ??= spawn.swarmGroup
          }
        }
      }
      if (
        hook.agentName &&
        hook.agentName !== 'self' &&
        (existing.label === 'Subagent' || existing.label.startsWith('Subagent ('))
      ) {
        existing.label = hook.agentName
      }
      this.rememberChild(run, existing)
      return existing
    }
    const remembered = run.knownChildren?.get(hook.conversationId)
    const fallbackParentId = hook.parentConversationId ?? remembered?.parentId ?? activeMainId ?? ''
    const spawn = remembered
      ? undefined
      : this.claimSpawn(run, fallbackParentId, !hook.parentConversationId)
    const parentId = spawn?.parentId ?? fallbackParentId
    const label =
      remembered?.label ??
      spawn?.label ??
      (hook.agentName && hook.agentName !== 'self' ? hook.agentName : undefined) ??
      'Subagent'
    const child: AgyChild = {
      id: hook.conversationId,
      parentId,
      label,
      state: 'working',
      isSwarm: remembered?.isSwarm || spawn?.isSwarm,
      swarmGroup: remembered?.swarmGroup ?? spawn?.swarmGroup
    }
    ;(run.children ??= new Map()).set(hook.conversationId, child)
    this.rememberChild(run, child)
    return child
  }

  private removeChild(run: AgyRun, childId: string, killed = false): boolean {
    let removed = false
    if (run.children?.delete(childId)) removed = true
    if (killed) run.knownChildren?.delete(childId)
    for (const [id, ch] of [...(run.children ?? [])]) {
      if (ch.parentId === childId && this.removeChild(run, id, killed)) removed = true
    }
    if (killed && run.knownChildren?.size) {
      for (const [id, kn] of [...run.knownChildren]) {
        if (kn.parentId === childId) run.knownChildren.delete(id)
      }
    }
    this.dropSpawnsOf(run, (s) => s.parentId === childId)
    return removed
  }

  private confirmSpawnsForStep(
    run: AgyRun,
    parentId: string,
    step: string,
    failed: boolean
  ): boolean {
    if (!run.pendingSpawns?.length) return false
    const matched: PendingSpawn[] = []
    const next: PendingSpawn[] = []
    for (const s of run.pendingSpawns) {
      if (s.parentId === parentId && s.stepIdx === step) matched.push(s)
      else next.push(s)
    }
    if (!matched.length) return false
    run.pendingSpawns = next.length ? next : undefined
    if (!failed) run.recentSpawns = [...matched, ...(run.recentSpawns ?? [])]
    return true
  }

  private wakeSwarmByMentions(run: AgyRun, key: string, text: string | undefined): boolean {
    if (!text || !run.children?.size) return false
    const { all, names } = swarmMentions(text)
    if (!all && !names.size) return false
    const woken: { id: string; prev: 'working' | 'waiting' }[] = []
    for (const ch of run.children.values()) {
      if (!ch.isSwarm || ch.state === 'working') continue
      const label = ch.label.toLowerCase()
      const group = ch.swarmGroup?.toLowerCase()
      if (all || names.has(label) || (group ? names.has(group) : false)) {
        woken.push({ id: ch.id, prev: ch.state })
        ch.state = 'working'
      }
    }
    if (woken.length) (run.wokenBySend ??= new Map()).set(key, woken)
    return woken.length > 0
  }

  private rollbackWoken(run: AgyRun, key: string, failed: boolean): boolean {
    const woken = run.wokenBySend?.get(key)
    run.wokenBySend?.delete(key)
    if (!failed || !woken?.length) return false
    let changed = false
    for (const w of woken) {
      const ch = run.children?.get(w.id)
      if (ch && ch.state === 'working') {
        ch.state = w.prev
        changed = true
      }
    }
    return changed
  }

  private killSwarmMember(run: AgyRun, name: string): boolean {
    const target = name.toLowerCase()
    let changed = false
    for (const [id, ch] of [...(run.children ?? [])]) {
      if (!ch.isSwarm) continue
      if (ch.label.toLowerCase() === target || ch.swarmGroup?.toLowerCase() === target) {
        if (this.removeChild(run, id, true)) changed = true
      }
    }
    for (const [id, kn] of [...(run.knownChildren ?? [])]) {
      if (!kn.isSwarm) continue
      if (kn.label.toLowerCase() === target || kn.swarmGroup?.toLowerCase() === target)
        run.knownChildren?.delete(id)
    }
    if (
      this.dropSpawnsOf(
        run,
        (s) =>
          !!s.isSwarm &&
          (s.label.toLowerCase() === target || s.swarmGroup?.toLowerCase() === target)
      )
    )
      changed = true
    return changed
  }

  private wakeChildrenByRecipient(
    run: AgyRun,
    key: string,
    recipient: string | undefined
  ): boolean {
    const woken: { id: string; prev: 'working' | 'waiting' }[] = []
    if (recipient === '@children') {
      for (const ch of run.children?.values() ?? []) {
        if (ch.state !== 'working') {
          woken.push({ id: ch.id, prev: ch.state })
          ch.state = 'working'
        }
      }
    } else if (recipient) {
      const ch = run.children?.get(recipient)
      if (ch && ch.state !== 'working') {
        woken.push({ id: ch.id, prev: ch.state })
        ch.state = 'working'
      }
    }
    if (woken.length) (run.wokenBySend ??= new Map()).set(key, woken)
    return woken.length > 0
  }

  private applySubagentPostToolUse(run: AgyRun, hook: AgyHook, isMain: boolean): boolean {
    const { input } = hook
    const call = record(input.toolCall)
    const name = String(call.name ?? '')
    const args = record(call.args)
    const step = String(input.stepIdx)
    if (name === 'invoke_subagent')
      return this.confirmSpawnsForStep(run, hook.conversationId, step, !!input.error)
    if (name === 'swarm') {
      const action = argOf(args, 'action') ?? argOf(args, 'Action')
      const teammate = argOf(args, 'name') ?? argOf(args, 'Name') ?? argOf(args, 'agentName')
      if (action === 'add')
        return this.confirmSpawnsForStep(run, hook.conversationId, step, !!input.error)
      if ((action === 'kill' || action === 'remove') && teammate && !input.error)
        return this.killSwarmMember(run, teammate)
      return false
    }
    if (name === 'manage_subagents' && !input.error) {
      const action = argOf(args, 'Action')
      if (action === 'kill') {
        let changed = false
        for (const cid of listFromStrings(args.ConversationIds))
          if (this.removeChild(run, cid, true)) changed = true
        return changed
      }
      if (action === 'kill_all') {
        if (isMain) {
          if (!run.children?.size && !run.pendingSpawns?.length && !run.recentSpawns?.length)
            return false
          run.children?.clear()
          run.knownChildren?.clear()
          run.pendingSpawns = undefined
          run.recentSpawns = undefined
          return true
        }
        let changed = false
        for (const [id, ch] of [...(run.children ?? [])])
          if (ch.parentId === hook.conversationId && this.removeChild(run, id, true)) changed = true
        if (this.dropSpawnsOf(run, (s) => s.parentId === hook.conversationId)) changed = true
        return changed
      }
      return false
    }
    if (name === 'send_message' || name === 'post_message')
      return this.rollbackWoken(run, `${hook.conversationId}:${step}`, !!input.error)
    return false
  }

  private settleConversationTasksOnStop(
    run: AgyRun,
    conversationId: string,
    fullyIdle: unknown
  ): void {
    for (const [id, command] of commandsOf(run, conversationId)) {
      if (fullyIdle === false || command.ran) {
        command.ran = true
        command.shown = true
      } else if (!command.shown) {
        run.commands?.delete(id)
      }
    }
    for (const [id, schedule] of schedulesOf(run, conversationId)) {
      if (fullyIdle === false || schedule.ran) {
        schedule.ran = true
        schedule.shown = true
      } else if (!schedule.shown) {
        run.schedules?.delete(id)
      }
    }
  }

  private onChildHook(
    run: AgyRun,
    hook: AgyHook,
    replaying = false,
    activeMainId = run.info?.nativeSessionId
  ): void {
    if (run.explicitStop || run.stopping) return
    const { input, event } = hook
    switch (event) {
      case 'SessionStart':
      case 'PreInvocation':
        this.ensureChild(run, hook, activeMainId).state = 'working'
        break
      case 'PreToolUse': {
        const child = this.ensureChild(run, hook, activeMainId)
        child.state = 'working'
        const call = record(input.toolCall)
        const name = String(call.name ?? '')
        const args = record(call.args)
        const key = `${hook.conversationId}:${String(input.stepIdx)}`
        if (name === 'swarm_wait') {
          child.isSwarm = true
          this.rememberChild(run, child)
        } else if (name === 'send_message') {
          this.wakeChildrenByRecipient(run, key, argOf(args, 'Recipient'))
        } else if (name === 'post_message') {
          this.wakeSwarmByMentions(run, key, argOf(args, 'text'))
        }
        break
      }
      case 'PostToolUse':
        if (run.children?.has(hook.conversationId)) this.ensureChild(run, hook, activeMainId)
        this.applySubagentPostToolUse(run, hook, false)
        break
      case 'Stop':
        this.settleConversationTasksOnStop(run, hook.conversationId, input.fullyIdle)
        if (input.fullyIdle === false) {
          this.ensureChild(run, hook, activeMainId).state = 'working'
        } else {
          const existing = run.children?.get(hook.conversationId)
          if (existing?.isSwarm) existing.state = 'waiting'
          else this.removeChild(run, hook.conversationId)
        }
        this.syncWakeupPending(run)
        break
    }
    if (!replaying) this.publishBackground(run)
  }

  private applyMainLifecycleHook(run: AgyRun, hook: AgyHook, replaying = false): boolean {
    const { input } = hook
    let changed = false
    switch (hook.event) {
      case 'PreInvocation':
        run.mainTurnActive = true
        run.exitedAskToIdle = false
        break
      case 'PreToolUse': {
        run.mainTurnActive = true
        const call = record(input.toolCall)
        const name = String(call.name ?? '')
        const args = record(call.args)
        const key = `${hook.conversationId}:${String(input.stepIdx)}`
        run.lastTool = { name, args }
        if (name === 'send_message') {
          if (this.wakeChildrenByRecipient(run, key, argOf(args, 'Recipient'))) changed = true
        } else if (name === 'post_message') {
          if (this.wakeSwarmByMentions(run, key, argOf(args, 'text'))) changed = true
        }
        break
      }
      case 'PostToolUse':
        if (this.applySubagentPostToolUse(run, hook, true)) changed = true
        break
      case 'Stop':
        run.mainTurnActive = false
        run.exitedAskToIdle = false
        this.onStop(run, input, replaying, hook.conversationId)
        break
    }
    return changed
  }

  // AGY§12
  private onHook(run: AgyRun, hook: AgyHook): void {
    if (run.explicitStop || run.stopping) return
    if (hook.conversationId !== run.info?.nativeSessionId) return
    const changed = this.applyMainLifecycleHook(run, hook, false)
    if (changed) this.publishBackground(run)
    if (hook.event === 'PostToolUse') {
      const call = record(hook.input.toolCall)
      const name = String(call.name ?? '')
      const args = record(call.args)
      const did = agyToolDid(name, (key) => argOf(args, key), args)
      if (did) this.deps.events(run.tabId, { type: 'did', what: did })
      void this.afterTool(run, hook.input)
    }
  }

  // AGY§13
  private trackTasks(
    run: AgyRun,
    hook: AgyHook,
    replaying = false,
    activeMainId = run.info?.nativeSessionId
  ): void {
    if (run.explicitStop || run.stopping) return
    const { event, input, conversationId } = hook
    if (event === 'PreInvocation') return this.sortAnswered(run, conversationId, input, replaying)
    const call = record(input.toolCall)
    const name = String(call.name ?? '')
    const args = record(call.args)
    const taskId = `${conversationId}/task-${String(input.stepIdx)}`
    const belongs =
      !run.info ||
      conversationId === activeMainId ||
      this.isAttributedChild(run, hook, activeMainId)
    if (name === 'run_command') {
      if (event === 'PreToolUse' && belongs) {
        const label =
          argOf(args, 'CommandLine')?.slice(0, BACKGROUND_LABEL_CHARS) ?? 'Background command'
        const existing = run.commands?.get(taskId)
        if (existing) {
          existing.item.label = label
        } else {
          const item: BackgroundItem = {
            id: taskId,
            label,
            ...(args.IsDaemon === true
              ? { kind: 'server', state: 'waiting' }
              : { kind: 'command', state: 'working' })
          }
          ;(run.commands ??= new Map()).set(taskId, { item, shown: false })
        }
      } else if (event === 'PostToolUse' && run.commands?.has(taskId)) {
        this.dropTasks(run, [taskId], [], replaying)
      }
      return
    }
    if (name === 'invoke_subagent' && event === 'PreToolUse' && belongs) {
      const specs = subagentSpecs(args, input.stepIdx)
      const stepIdx = String(input.stepIdx)
      const spawns = (run.pendingSpawns ??= [])
      specs.forEach((spec, i) => {
        spawns.push({
          id: `${conversationId}/subagent-${stepIdx}-${i}`,
          parentId: conversationId,
          stepIdx,
          label: spec.label
        })
      })
      if (!replaying) this.publishBackground(run)
      return
    }
    if (name === 'swarm' && event === 'PreToolUse' && belongs) {
      const action = argOf(args, 'action') ?? argOf(args, 'Action')
      const teammate = argOf(args, 'name') ?? argOf(args, 'Name') ?? argOf(args, 'agentName')
      if (action === 'add' && teammate) {
        const stepIdx = String(input.stepIdx)
        const spawns = (run.pendingSpawns ??= [])
        swarmMemberNames(teammate, args).forEach((member, i) => {
          spawns.push({
            id: `${conversationId}/swarm-${stepIdx}-${i}`,
            parentId: conversationId,
            stepIdx,
            label: member.slice(0, BACKGROUND_LABEL_CHARS),
            isSwarm: true,
            swarmGroup: teammate
          })
        })
        if (!replaying) this.publishBackground(run)
      }
      return
    }
    if (name !== 'schedule' && name !== 'manage_task') return
    const schedules = (run.schedules ??= new Map())
    const before = schedules.size
    let changed = false
    if (name === 'schedule') {
      if (event === 'PreToolUse' && belongs) {
        const isDaemon = args.IsDaemon === true
        const label = agyScheduleLabel(args)
        const existing = schedules.get(taskId)
        if (existing) {
          existing.item.label = label
          existing.isDaemon = isDaemon
        } else {
          const item: BackgroundItem = {
            id: taskId,
            kind: 'monitor',
            label,
            state: 'waiting'
          }
          schedules.set(taskId, { item, shown: false, isDaemon })
        }
      } else if (event === 'PostToolUse' && schedules.delete(taskId)) {
        changed = true
      }
    } else if (event === 'PostToolUse' && argOf(args, 'Action') === 'kill' && !input.error) {
      const killed = argOf(args, 'TaskId') ?? ''
      const id = killed.includes('/') ? killed : `${conversationId}/${killed}`
      if (schedules.delete(id)) changed = true
      if (run.commands?.delete(id)) changed = true
    }
    if (schedules.size !== before) this.syncWakeupPending(run)
    if (changed && !replaying) this.publishBackground(run)
  }

  // AGY§8 AGY§12
  private async afterTool(run: AgyRun, input: Record<string, unknown>): Promise<void> {
    const call = record(input.toolCall)
    const name = String(call.name ?? '')
    const args = record(call.args)
    const target = argOf(args, 'TargetFile') ?? argOf(args, 'Path')
    const where = parseRemoteKey(run.cwd)
    const shellWrote = shellWrittenFiles(input[SHELL_WROTE_FIELD]).map((f) =>
      where ? formatRemoteKey(where.host, f) : f
    )
    if (shellWrote.length) {
      for (const file of shellWrote) noteWrite(run.touched, file, 0, 0, Date.now())
      this.publishWrite(run, shellWrote[shellWrote.length - 1])
    }
    if (!WRITING_TOOLS.has(name) || !target || input.error) return
    const written = where ? path.posix.resolve(where.path, target) : path.resolve(run.cwd, target)
    const file = where ? formatRemoteKey(where.host, written) : written
    let counts = { added: 0, removed: 0 }
    if (name === 'write_to_file')
      counts = { added: lineCount(argOf(args, 'CodeContent') ?? ''), removed: 0 }
    else if (name === 'write_file')
      counts = { added: lineCount(argOf(args, 'Content') ?? ''), removed: 0 }
    else if (name === 'edit_file')
      counts = replacementCounts(argOf(args, 'Target') ?? '', argOf(args, 'Replacement') ?? '')
    else if (run.info) {
      if (run.remote) await this.deps.remote.nextPull(run.remote.host)
      const transcript = agyTranscript(this.geminiOf(run.cwd), run.info.nativeSessionId!)
      const diff = await lastDiffFor(transcript, written)
      if (diff) counts = diffCounts(diff)
    }
    noteWrite(run.touched, file, counts.added, counts.removed, Date.now())
    this.publishWrite(run, file)
  }

  private publishWrite(run: AgyRun, last: string): void {
    this.deps.events(run.tabId, wroteEvent(run.touched, last, ++run.liveWrites))
  }

  // AGY§12 AGY§17
  private onStop(
    run: AgyRun,
    input: Record<string, unknown>,
    replaying = false,
    conversationId = run.info?.nativeSessionId
  ): void {
    if (!replaying && input.terminationReason === 'TERMINAL_CUSTOM_HOOK') {
      if (run.api) this.endCompaction(run)
      else this.deps.events(run.tabId, { type: 'compacted' })
    }
    if (conversationId) this.settleConversationTasksOnStop(run, conversationId, input.fullyIdle)
    if (input.fullyIdle !== false) {
      run.unattributedBackground = false
      run.pendingSpawns = undefined
      run.recentSpawns = undefined
      for (const [id, ch] of [...(run.children ?? [])])
        if (ch.state === 'working') this.removeChild(run, id)
    } else {
      run.unattributedBackground = !this.hasActiveAttributed(run)
    }
    this.syncWakeupPending(run)
    if (!replaying) this.publishBackground(run)
  }

  // AGY§10
  private onData(tabId: string, data: string): void {
    const parser = this.parsers.get(tabId)
    if (!parser) return
    const { asked, states } = parser.push(data)
    if (asked) this.deps.pty.write(tabId, PROGRAM_STATUS_REPLY)
    const run = this.runs.get(tabId)
    if (!run || run.explicitStop || states.length === 0) return
    run.log.read()
    if (!run.info) {
      run.statesBeforeBind = sinceThePrompt(run.statesBeforeBind ?? [], states)
      this.deps.pty.wakeReady(tabId)
      return
    }
    for (const status of states) this.emitState(run, status)
  }

  // AGY§8 AGY§10
  showsPromptBeforeBind(tabId: string): boolean {
    const run = this.runs.get(tabId)
    return (
      !!run &&
      !run.info &&
      !run.explicitStop &&
      !run.firstLine &&
      run.statesBeforeBind?.at(-1)?.state === 'idle'
    )
  }

  private pruneUnconfirmedTasksFor(run: AgyRun, conversationId: string): boolean {
    let changed = false
    for (const [id, c] of commandsOf(run, conversationId))
      if (!c.ran && !c.shown && run.commands?.delete(id)) changed = true
    let schedulePruned = false
    for (const [id, s] of schedulesOf(run, conversationId))
      if (!s.ran && !s.shown && run.schedules?.delete(id)) {
        changed = true
        schedulePruned = true
      }
    if (schedulePruned) this.syncWakeupPending(run)
    return changed
  }

  private pruneUnconfirmedFor(run: AgyRun, conversationId: string): boolean {
    let changed = this.pruneUnconfirmedTasksFor(run, conversationId)
    if (this.dropSpawnsOf(run, (s) => s.parentId === conversationId)) changed = true
    return changed
  }

  private emitState(run: AgyRun, status: ProgramStatus): void {
    // AGY§10 AGY§16
    const declinedAsk = status.state === 'idle' && run.terminalState === 'blocked'
    if (status.state === 'done' || status.state === 'error' || declinedAsk) {
      run.turnEndedOnTerminal = true
    } else if (status.state === 'working') {
      if (run.turnEndedOnTerminal)
        run.terminalTurnStarts = Math.min(
          (run.terminalTurnStarts ?? 0) + 1,
          (run.streamRunStarts ?? 0) + 1
        )
      run.turnEndedOnTerminal = false
    }
    run.terminalState = status.state
    if (status.state === 'idle' || status.state === 'error') run.mainTurnActive = false
    if (status.state === 'working') run.exitedAskToIdle = false
    const turn = this.deps.runtime.turn(run.tabId)
    if (
      (status.state === 'idle' || status.state === 'error') &&
      (turn === 'approval' || turn === 'input') &&
      !run.waiting?.plan
    ) {
      run.exitedAskToIdle = true
      const id = run.info?.nativeSessionId
      if (id && this.pruneUnconfirmedFor(run, id)) {
        run.unattributedBackground &&= !this.hasActiveAttributed(run)
        this.publishBackground(run)
      }
    }
    if (status.state === 'blocked' && status.kind !== 'auth') void this.readAsk(run, status)
    else if (!run.waiting?.plan) run.waiting = undefined
    if (status.state === 'working') this.turnStarted(run)
    if (status.state === 'done') void this.turnDone(run)
    const event = statusEvent(status)
    if (event) this.deps.events(run.tabId, event)
  }

  // AGY§8 AGY§10
  private async turnDone(run: AgyRun): Promise<void> {
    this.endCompaction(run)
    const id = run.info?.nativeSessionId
    if (!id) return
    this.chaseListedTitle(run, id, false)
    if (run.remote) await this.deps.remote.nextPull(run.remote.host)
    if (!run.transcript || run.info?.nativeSessionId !== id) return
    const read = await run.transcript.catchUp().catch(() => undefined)
    if (!read) return
    const { turns, tokens: t } = read
    for (const turn of turns)
      if (turn.reply) this.deps.events(run.tabId, { type: 'turn-ended', turn })
    const tokens = {
      inTok: t.input,
      outTok: t.output,
      cacheReadTok: t.cacheRead,
      cacheWriteTok: 0,
      cacheWrite1hTok: 0
    }
    const model = run.title?.model
    const pricing = model ? resolvePricing(model) : undefined
    const used = run.title?.contextUsed
    const costUsd = pricing ? costUsdOf(pricing, tokens) : undefined
    if (costUsd !== undefined && run.dir)
      fs.writeFile(path.join(run.dir, 'agy-cost'), String(costUsd), () => {})
    this.deps.events(run.tabId, {
      type: 'usage',
      usage: {
        ...tokens,
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(used !== undefined ? { ctxPct: used / 100 } : {}),
        model
      }
    })
  }

  // AGY§8 AGY§17
  private turnStarted(run: AgyRun): void {
    this.watchApiState(run)
    const id = run.info?.nativeSessionId
    if (
      id &&
      !run.givenTitle &&
      run.workingTitleChasedFor !== id &&
      !this.history.get(agySessionKey(id, run.remote?.host))?.name
    ) {
      run.workingTitleChasedFor = id
      this.chaseListedTitle(run, id, true)
    }
  }

  private stopTitleChase(run: AgyRun): void {
    if (run.titleChase?.timer) clearTimeout(run.titleChase.timer)
    run.titleChase = undefined
  }

  // AGY§8
  private chaseListedTitle(run: AgyRun, id: string, delayFirst: boolean): void {
    const existing = run.titleChase?.id === id ? run.titleChase : undefined
    if (run.titleChase && !existing) this.stopTitleChase(run)
    if (existing) {
      if (delayFirst) return
      existing.readsLeft = LISTED_TITLE_REREADS_AFTER_A_TURN
      if (!existing.timer) return
      clearTimeout(existing.timer)
      existing.timer = undefined
      void this.takeListedTitle(run, id, existing)
      return
    }
    const chase: NonNullable<AgyRun['titleChase']> = {
      id,
      readsLeft: LISTED_TITLE_REREADS_AFTER_A_TURN
    }
    run.titleChase = chase
    if (delayFirst) this.takeListedTitleSoon(run, id, chase)
    else void this.takeListedTitle(run, id, chase)
  }

  private readRemoteTitle(host: string, id: string): Promise<string | undefined> {
    return agyConversationTitle(this.deps.remote.machine(host), id)
  }

  // AGY§8 AGY§11
  private async takeListedTitle(
    run: AgyRun,
    id: string,
    chase: NonNullable<AgyRun['titleChase']>
  ): Promise<void> {
    if (run.titleChase !== chase) return
    chase.timer = undefined
    const given = run.givenTitle
    const listed = run.remote
      ? this.readRemoteTitle(run.remote.host, id)
      : readAgyConversationTitle(this.gemini, id)
    const name = await listed.catch(() => undefined)
    if (run.titleChase !== chase) return
    const current =
      this.runs.get(run.tabId) === run &&
      !run.explicitStop &&
      !run.stopping &&
      run.info?.nativeSessionId === id
    if (current && !name && chase.readsLeft-- > 0) return this.takeListedTitleSoon(run, id, chase)
    this.stopTitleChase(run)
    if (!current || !name || !run.info) return
    if (!given) {
      if (name !== run.info.title) this.retitle(run.info, name)
      return
    }
    run.givenTitle = undefined
    // AGY§16
    if (name !== given) void run.api?.rename(id, given).catch(() => undefined)
  }

  // AGY§8
  private takeListedTitleSoon(
    run: AgyRun,
    id: string,
    chase: NonNullable<AgyRun['titleChase']>
  ): void {
    if (run.titleChase !== chase) return
    const timer = setTimeout(
      () => void this.takeListedTitle(run, id, chase),
      LISTED_TITLE_AFTER_PROMPT_MS
    )
    timer.unref?.()
    chase.timer = timer
  }

  // AGY§16 AGY§17
  private watchApiState(run: AgyRun): void {
    const id = run.info?.nativeSessionId
    if (!run.api || !id || run.stream?.conversationId === id) return
    run.stream?.close()
    run.streamShowsRunning = undefined
    run.streamRunStarts = 0
    run.terminalTurnStarts = 0
    run.turnEndedOnTerminal = false
    const stream = run.api.streamState(id, (message) => {
      if (
        this.runs.get(run.tabId) !== run ||
        run.info?.nativeSessionId !== id ||
        run.explicitStop ||
        run.stopping
      )
        return
      const update = agentStateUpdate(message)
      if (update.activeHook === CONTEXT_SUMMARY && !run.compacting) {
        const compacting: AgyRun['compacting'] = { shown: false }
        compacting.timer = setTimeout(() => {
          if (
            this.runs.get(run.tabId) !== run ||
            run.info?.nativeSessionId !== id ||
            run.compacting !== compacting ||
            run.explicitStop ||
            run.stopping
          )
            return
          compacting.shown = true
          this.deps.events(run.tabId, { type: 'compacting' })
        }, COMPACTION_SHOWS_AFTER_MS)
        run.compacting = compacting
      } else if (update.activeHook !== CONTEXT_SUMMARY && run.compacting) this.endCompaction(run)
      const st = update.status ?? update.executorLoopStatus
      const idleNow = st === 'CASCADE_RUN_STATUS_IDLE'
      // AGY§16
      const endsAnEarlierTurn =
        idleNow &&
        run.streamShowsRunning !== undefined &&
        (run.terminalState === 'working' || run.terminalState === 'blocked') &&
        (run.terminalTurnStarts ?? 0) > (run.streamRunStarts ?? 0)
      if (st && !idleNow && run.streamShowsRunning === false)
        run.streamRunStarts = (run.streamRunStarts ?? 0) + 1
      if (st) run.streamShowsRunning = !idleNow
      if (idleNow && !run.remote) {
        run.log.read()
        if (this.runs.get(run.tabId) !== run || run.info?.nativeSessionId !== id) return
      }
      if (update.backgroundTasksTotal === 0) {
        this.applyApiTasks(run, id, [], true, idleNow && !endsAnEarlierTurn)
      } else if (update.backgroundTasks !== undefined) {
        if (
          update.backgroundTasksTotal === undefined ||
          update.backgroundTasks.length === update.backgroundTasksTotal
        ) {
          this.applyApiTasks(
            run,
            id,
            update.backgroundTasks.map((t) => ({
              ...t,
              conversationId: t.conversationId || id
            })),
            true,
            idleNow && !endsAnEarlierTurn
          )
        } else if (run.commands?.size || run.schedules?.size) {
          this.askCommands(run)
        }
      } else if (
        update.backgroundTasksTotal !== undefined &&
        (run.commands?.size || run.schedules?.size)
      ) {
        this.askCommands(run)
      }
      if (endsAnEarlierTurn) return
      const explicitBusy = update.fullyIdle === false || (update.backgroundTasksTotal ?? 0) > 0
      const streamBusy = explicitBusy || (update.fullyIdle === undefined && idleNow)
      if (update.fullyIdle === true && idleNow) {
        this.endCompaction(run)
        run.mainTurnActive = false
        run.exitedAskToIdle = false
        run.unattributedBackground = false
        run.pendingSpawns = undefined
        run.recentSpawns = undefined
        if (!run.waiting?.plan) run.waiting = undefined
        for (const [cid, ch] of [...(run.children ?? [])])
          if (ch.state === 'working') this.removeChild(run, cid)
        for (const [tid, c] of [...(run.commands ?? [])])
          if (
            update.backgroundTasksTotal === 0 ||
            (!c.ran && !c.shown) ||
            (c.item.kind !== 'server' && c.item.state === 'working')
          )
            run.commands?.delete(tid)
        for (const [tid, s] of [...(run.schedules ?? [])])
          if (update.backgroundTasksTotal === 0 || (!s.ran && !s.shown) || !s.isDaemon)
            run.schedules?.delete(tid)
        this.syncWakeupPending(run)
        this.publishBackground(run)
        if (!run.waiting?.plan) {
          const turn = this.deps.runtime.turn(run.tabId)
          if (turn === 'working' || turn === 'approval' || turn === 'input')
            this.deps.events(run.tabId, { type: 'stop' })
        }
      } else if (streamBusy && idleNow) {
        run.mainTurnActive = false
        const turn = this.deps.runtime.turn(run.tabId)
        if (
          ((turn === 'approval' || turn === 'input') && !run.waiting?.plan) ||
          !!run.exitedAskToIdle
        ) {
          run.exitedAskToIdle = false
          run.waiting = undefined
          this.pruneUnconfirmedFor(run, id)
          run.unattributedBackground = explicitBusy && !this.hasActiveAttributed(run)
          this.publishBackground(run)
        } else if (explicitBusy && !this.hasActiveAttributed(run)) {
          run.unattributedBackground = true
          this.publishBackground(run)
        }
        if (!run.waiting?.plan && (turn === 'working' || turn === 'approval' || turn === 'input'))
          this.deps.events(run.tabId, { type: 'stop' })
      }
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
    const fromHook = this.askFromHook(run, status)
    run.waiting = fromHook
    const pending = await run.api?.pending(id).catch(() => undefined)
    if (!pending || run.waiting !== fromHook) return
    const askId = `${pending.trajectoryId}:${pending.stepIndex}`
    const questions = pending.questions ?? []
    run.waiting = {
      pending,
      noKey: fromHook.noKey,
      ...(pending.kind !== 'question'
        ? {
            approval: {
              id: askId,
              command: pending.target,
              reason: pending.kind === 'file' && !pending.read ? 'Write this file' : undefined,
              ...(pending.kind === 'file' && pending.target ? { file: pending.target } : {}),
              ...(pending.read && { read: true as const })
            }
          }
        : questions.length
          ? {
              question: {
                id: askId,
                questions: questions.map((q) =>
                  agyQuestion(
                    q.question,
                    q.options.map((o) => o.text),
                    !!q.multiSelect
                  )
                )
              }
            }
          : {})
    }
    this.changedSoon()
  }

  // AGY§12 AGY§13 AGY§26
  private askFromHook(run: AgyRun, status: ProgramStatus): AgyAsk {
    const id = `hook:${Date.now()}`
    const tool = run.lastTool
    if (status.kind === 'question' && tool?.name === 'ask_question') {
      const raw = record(tool.args).questions
      const asked = (Array.isArray(raw) && raw.length ? raw : [undefined]).map(record)
      return {
        question: {
          id,
          questions: asked.map((q) =>
            agyQuestion(
              typeof q.question === 'string' ? q.question : (status.msg ?? ''),
              q.options,
              q.is_multi_select === true
            )
          )
        }
      }
    }
    const commandLine = tool && argOf(tool.args, 'CommandLine')
    const file =
      tool && !commandLine
        ? (argOf(tool.args, 'TargetFile') ??
          argOf(tool.args, 'Path') ??
          argOf(tool.args, 'AbsolutePath'))
        : undefined
    return {
      noKey: noKeyFor(status.msg, tool?.name),
      approval: {
        id,
        command: commandLine ?? file ?? status.msg,
        ...(file ? { file, ...(READING_TOOLS.has(tool!.name) && { read: true as const }) } : {})
      }
    }
  }

  // AGY§19
  private async readPlan(run: AgyRun): Promise<void> {
    const id = run.info?.nativeSessionId
    if (!id) return
    if (run.remote) await this.deps.remote.nextPull(run.remote.host)
    const stillThere = this.runs.get(run.tabId) === run && !run.explicitStop && !run.stopping
    if (!stillThere || run.info?.nativeSessionId !== id) return
    if (run.remote && run.lastTitleState !== 'reviewing') return
    const brain = path.join(agyBrain(this.geminiOf(run.cwd)), id)
    let names: string[] = []
    try {
      names = fs.readdirSync(brain).filter((n) => n.endsWith(AGY_ARTIFACT_SIDECAR))
    } catch {}
    const waiting = names
      .map((n) => ({ n, meta: readJson(path.join(brain, n)) }))
      .find((x) => x.meta.requestFeedback === true)
    if (!waiting) return
    const plan = waiting.n.replace(/\.metadata\.json$/, '')
    const askId = `plan:${id}:${plan}:${String(waiting.meta.updatedAt ?? '')}`
    if (run.waiting?.approval?.id === askId) return
    const text = readText(path.join(brain, plan))?.trim()
    run.waiting = {
      plan,
      approval: { id: askId, command: plan, ...(text && { reason: text }), plan: true }
    }
    if (run.remote) run.shown = 'blocked'
    this.deps.events(run.tabId, { type: 'notify', need: 'approval' })
    this.changedSoon()
  }

  openApproval(tabId: string): CodexApproval | undefined {
    return this.runs.get(tabId)?.waiting?.approval
  }

  openQuestion(tabId: string): CodexQuestion | undefined {
    return this.runs.get(tabId)?.waiting?.question
  }

  // AGY§14 AGY§16 AGY§19
  async answer(tabId: string, reply: string): Promise<SentAnswer | false> {
    const run = this.runs.get(tabId)
    const ask = run?.waiting
    const id = run?.info?.nativeSessionId
    if (!run || !ask || !id) return false
    if (ask.question) {
      const answers = questionAnswers(ask.question, reply)
      const viaApi =
        answers && ask.pending
          ? await run.api?.answer(id, ask.pending, answers).then(
              () => true,
              () => false
            )
          : false
      if (!viaApi) return false
      run.waiting = undefined
      return {}
    }
    if (!ask.approval) return false
    const key = codexKeyFor(reply)
    if (!key) return { error: 'an Antigravity approval takes yes or no.' }
    const yes = key === 'y'
    run.waiting = undefined
    if (ask.plan) {
      await this.deliverText(run, `[${yes ? 'Approved' : 'Rejected'}] ${ask.plan}`)
      return {}
    }
    const viaApi = ask.pending
      ? await run.api?.allow(id, ask.pending, yes).then(
          () => true,
          () => false
        )
      : false
    if (viaApi) return {}
    this.deps.pty.write(tabId, yes ? KEYS.yes : (ask.noKey ?? KEYS.noCommand))
    return { watch: true }
  }

  // AGY§15 AGY§16
  private async deliverText(run: AgyRun, text: string): Promise<void> {
    if (!(await this.deliver(run.tabId, text)))
      this.deps.pty.write(run.tabId, bracketedPaste(text) + '\r')
  }

  // AGY§16 AGY§29
  async deliver(tabId: string, text: string): Promise<boolean> {
    const run = this.runs.get(tabId)
    const id = run?.info?.nativeSessionId
    if (!run || !id) return false
    const sent = run.remote
      ? agySend(this.deps.remote.machine(run.remote.host), run.remote.tmuxName, id, text)
      : run.api?.send(id, text)
    return (await sent?.catch(() => false)) ?? false
  }
}
