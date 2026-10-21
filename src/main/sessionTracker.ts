import fs from 'fs'
import path from 'path'
import os from 'os'
import type {
  ClaudeSessionInfo as SessionInfo,
  PreviewItem,
  SessionStatus,
  BackgroundItem
} from '@shared/types'
import type { ReportedTask, SessionEvent } from '@shared/sessionEvent'
import { PLACEHOLDER_SESSION_TITLE } from '@shared/types'
import { TurnLog, type SaidLine, type Turn as TalkTurn } from '@shared/turns'
import { encodeCwd } from '@shared/cwdKey'
import { projectInfoFor, realpathSafe } from './projectInfo'
import { worktreeHomeRoot } from './resumePlan'
import { inspectTaskProcs, type TaskProcs } from './taskProcs'
import { sharedProcessTable } from './processTable'
import { SessionRuntime, envMs, turnOf, type Turn } from './sessionRuntime'
import { capTouched, touchedItem } from './touchedFiles'
import { ClaudeTouchedFiles, toolFilePath } from './claudeTouchedFiles'
import { TitleSources } from './titleSources'
import { UsageMeter } from './usageMeter'
import { BackgroundLedger, isBackgroundSpawnAck } from './backgroundLedger'
import type { LaunchedSession } from './accountPicker'
import type { MachineTmp } from './remote/install'
import { claudeWroteIt, commandOutputOf } from './claudeCommandOutput'
import { withoutHandover } from './handover'
import { messageText } from './messageText'
import { parseRecord, type TextBlock, type TranscriptRecord } from './transcriptRecord'

export const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects')
const TMP_ROOT = ((): string => {
  try {
    return fs.realpathSync('/tmp')
  } catch {
    return '/tmp'
  }
})()
const SUBAGENT_SCAN_MS = envMs('KOLOFT_SUBAGENT_SCAN_MS', 5000)
const EMIT_THROTTLE_MS = 500
const RESUME_AFTER_STOP_MS = envMs('KOLOFT_RESUME_AFTER_STOP_MS', 2000)
const STOP_HOLD_MS = envMs('KOLOFT_STOP_HOLD_MS', 10_000)
const BG_SILENCE_MAX_MS = envMs('KOLOFT_BG_SILENCE_MS', 10 * 60_000)
// CC§8
const SERVER_QUIET_WINDOW_MS = envMs('KOLOFT_SERVER_QUIET_MS', 2 * 60_000)
const IDLE_SERVER_CPU_MS_PER_MINUTE = 3000
// CC§8
const TEAMMATE_QUIET_MS = envMs('KOLOFT_TEAMMATE_QUIET_MS', 60_000)
const PROCS_SCAN_MS = envMs('KOLOFT_PROCS_SCAN_MS', 5000)
// CC§2
const RELOCATE_SETTLE_MS = envMs('KOLOFT_RELOCATE_SETTLE_MS', 1200)
// CC§2
const TURN_TEXT_WAIT_MS = envMs('KOLOFT_TURN_TEXT_WAIT_MS', 5000)

export { encodeCwd }

const UNLISTED_BACKGROUND_WORK: BackgroundItem = {
  id: 'unlisted',
  kind: 'command',
  label: 'background work',
  state: 'working'
}

// CC§8
export function parseReportedTasks(bgl: unknown): ReportedTask[] | undefined {
  if (typeof bgl !== 'string') return undefined
  const out: ReportedTask[] = []
  for (const pair of bgl.split(',')) {
    const i = pair.indexOf(':')
    if (i <= 0) continue
    out.push({ id: pair.slice(0, i), type: pair.slice(i + 1) })
  }
  return out
}

export function sessionEventFromHook(
  event?: string,
  message?: string,
  bgl?: unknown,
  ask?: unknown,
  trigger?: unknown
): SessionEvent | null {
  switch (event) {
    case 'ask':
      return ask && typeof ask === 'object' ? { type: 'asked', ask } : null
    case 'prompt':
      return { type: 'prompt' }
    case 'compacting':
      return trigger === 'auto' || trigger === 'manual'
        ? { type: 'compacting', trigger }
        : { type: 'compacting' }
    case 'compacted':
      return { type: 'compacted' }
    case 'stop':
      return { type: 'stop', reported: parseReportedTasks(bgl) }
    case 'notify': {
      const m = (message || '').toLowerCase()
      // CC§8
      const approval = m.includes('permission') || m.includes('approval')
      return { type: 'notify', need: approval ? 'approval' : 'input' }
    }
    default:
      return null
  }
}

// CC§8
const AGENT_TYPES = new Set(['subagent', 'workflow', 'mcp-task', 'cloud-session'])

// CC§8
function taskNotificationText(obj: TranscriptRecord): string | null {
  if (obj.type === 'attachment') {
    const a = obj.attachment
    return a?.commandMode === 'task-notification' && typeof a.prompt === 'string' ? a.prompt : null
  }
  if (obj.type === 'queue-operation') {
    const c = obj.content
    return typeof c === 'string' && c.startsWith('<task-notification>') ? c : null
  }
  if (obj.origin?.kind === 'task-notification') {
    return messageText(obj.message?.content) ?? ''
  }
  return null
}

// CC§8
async function readTeammateFlag(jsonl: string): Promise<boolean | undefined> {
  try {
    const meta = JSON.parse(
      await fs.promises.readFile(jsonl.replace(/\.jsonl$/, '.meta.json'), 'utf8')
    )
    return meta?.taskKind === 'in_process_teammate'
  } catch {
    return undefined
  }
}

// CC§8
async function listSubagentJsonls(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 6 || out.length >= 500) return
    let ents: fs.Dirent[]
    try {
      ents = await fs.promises.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) await walk(full, depth + 1)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
      if (out.length >= 500) return
    }
  }
  await walk(dir, 0)
  return out
}

// CC§2
const BASH_WRITES = /(^|[^0-9&])>>?\s*(?!\/dev\/null)\S|\btee\s|\bsed\s+-i\b|\btouch\s/
const TASK_LABEL_FIELD: Record<string, string> = {
  Bash: 'command',
  Monitor: 'command',
  Agent: 'description'
}
const UNACKED_TOOL_CAP = 64

export interface ToolCall {
  name: string
  input: Record<string, unknown>
}

const THIS_MAC_TMP: MachineTmp = { tmpRoot: TMP_ROOT, uid: process.getuid?.() ?? 0 }

function sessionTmpDir(
  jsonlPath: string | null,
  launchCwd?: string,
  machine: MachineTmp | null = THIS_MAC_TMP
): string | null {
  if (!jsonlPath || !jsonlPath.endsWith('.jsonl')) return null
  const sessionId = path.basename(jsonlPath, '.jsonl')
  const transcriptSlug = path.basename(path.dirname(jsonlPath))
  if (!sessionId || !transcriptSlug) return null
  const launchSlug = launchCwd ? encodeCwd(launchCwd) : ''
  const slug =
    launchSlug && transcriptSlug.startsWith(launchSlug + '-') ? launchSlug : transcriptSlug
  const base =
    process.env.KOLOFT_SCRATCHPAD_BASE ||
    (machine && path.join(machine.tmpRoot, `claude-${machine.uid}`))
  return base ? path.join(base, slug, sessionId) : null
}

// CC§2
export function scratchpadDirFor(
  jsonlPath: string | null,
  launchCwd?: string,
  machine?: MachineTmp | null
): string | null {
  const dir = sessionTmpDir(jsonlPath, launchCwd, machine)
  return dir && path.join(dir, 'scratchpad')
}

interface SubagentFile {
  offset: number
  tail: Buffer
  activeMs: number
  teammate?: boolean
}

// CC§2
export const INTERRUPT_TEXTS = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]'
])

// CC§2
const IMAGE_PLACEHOLDER = /\[Image(?: #\d+)?\]/g

export function classifyUserPrompt(text: string): {
  genuine: boolean
  title: string | null
  commandArgs: string | null
  commandName: string | null
} {
  let candidate: string
  let isCommand = false
  let commandName: string | null = null
  // CC§9
  if (/^<command-(name|message|args|contents)>/.test(text)) {
    isCommand = true
    const m = text.match(/<command-args>([\s\S]*?)<\/command-args>/)
    candidate = m ? m[1] : ''
    if (!candidate.trim())
      commandName = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim() || null
  } else if (
    /^<(bash-input|bash-stdout|bash-stderr|local-command)/.test(text) ||
    text.startsWith('Base directory for this skill')
  ) {
    return { genuine: false, title: null, commandArgs: null, commandName: null }
  } else {
    candidate = withoutHandover(text)
  }
  const genuine = candidate.trim().length > 0
  const stripped = candidate.replace(IMAGE_PLACEHOLDER, '')
  if (stripped !== candidate) candidate = stripped.replace(/[ \t]{2,}/g, ' ')
  const usable = candidate.trim() || null
  return {
    genuine,
    title: isCommand ? null : usable,
    commandArgs: isCommand ? usable : null,
    commandName
  }
}

// CC§13
const PEER_MESSAGE = /^Another Claude session sent a message:\n([\s\S]*?)\n\nThis came from another/
// CC§13
const PEER_ENVELOPE = /^<cross-session-message[^>\n]*>\n([\s\S]*)\n<\/cross-session-message>$/

function peerText(raw: string): string {
  const inner = PEER_MESSAGE.exec(raw)?.[1] ?? raw
  return (PEER_ENVELOPE.exec(inner)?.[1] ?? inner).trim()
}

// CC§2
function commandEcho(obj: { origin?: unknown }, raw: string | null): boolean {
  return raw !== null && raw.startsWith('/') && claudeWroteIt(obj)
}

// CC§1
export function compactionSummary(obj: { isCompactSummary?: unknown }): boolean {
  return obj.isCompactSummary === true
}

// CC§2 CC§8
const WRITTEN_BY_CLAUDE_CODE = /^<(task-notification|system-reminder|teammate-message)[\s>]/

export function whoTyped(record: { origin?: unknown }, text: string): 'owner' | 'peer' | null {
  if (WRITTEN_BY_CLAUDE_CODE.test(text)) return null
  const kind = (record.origin as { kind?: unknown } | null | undefined)?.kind
  if (kind === undefined || kind === 'human') return 'owner'
  return kind === 'peer' ? 'peer' : null
}

type TurnPiece = { line: SaidLine; midTurn: boolean } | 'tool'

// CC§2 CC§13
function claudeTurnPieces(obj: TranscriptRecord | null): TurnPiece[] {
  if (!obj || obj.isSidechain === true) return []
  const ts = Date.parse(obj.timestamp ?? '')
  const at = isFinite(ts) ? ts : Date.now()
  if (obj.type === 'user') {
    const raw = messageText(obj.message?.content)
    const who = raw === null ? null : whoTyped(obj, raw)
    if (raw === null || !who) return []
    if (who === 'peer') return [{ line: { who, text: peerText(raw), at }, midTurn: false }]
    if (
      obj.isMeta ||
      compactionSummary(obj) ||
      INTERRUPT_TEXTS.has(raw) ||
      commandEcho(obj, raw) ||
      !classifyUserPrompt(raw).title
    )
      return []
    return [{ line: { who, text: raw.trim(), at }, midTurn: false }]
  }
  if (obj.type === 'attachment') {
    const a = obj.attachment
    if (a?.type !== 'queued_command' || a.commandMode !== 'prompt' || typeof a.prompt !== 'string')
      return []
    const who = whoTyped(a, a.prompt)
    if (!who) return []
    const text = who === 'peer' ? peerText(a.prompt) : a.prompt.trim()
    return [{ line: { who, text, at }, midTurn: true }]
  }
  const content = obj.message?.content
  if (obj.type !== 'assistant' || !Array.isArray(content)) return []
  return content.flatMap((b): TurnPiece[] => {
    if (b?.type === 'tool_use') return ['tool']
    if (b?.type !== 'text' || typeof b.text !== 'string' || !b.text.trim()) return []
    return [{ line: { who: 'assistant', text: b.text.trim(), at }, midTurn: true }]
  })
}

export function lastTurnsOfLines(
  lines: string[],
  n: number
): { turns: TalkTurn[]; started: number } {
  const log = new TurnLog()
  let started = 0
  for (const line of lines) {
    for (const piece of claudeTurnPieces(parseRecord(line))) {
      if (piece === 'tool') continue
      const before = log.open()
      log.add(piece.line, piece.midTurn)
      if (log.open() !== before) started++
    }
  }
  return { turns: log.last(n), started }
}

export const TRANSCRIPT_TAIL_FIRST_READ_BYTES = 64 * 1024

export async function transcriptTurns(file: string, n: number): Promise<TalkTurn[]> {
  const fh = await fs.promises.open(file, 'r')
  try {
    let start = (await fh.stat()).size
    let tail = Buffer.alloc(0)
    for (let chunk = TRANSCRIPT_TAIL_FIRST_READ_BYTES; ; chunk *= 2) {
      const from = Math.max(0, start - chunk)
      const head = Buffer.alloc(start - from)
      await fh.read(head, 0, head.length, from)
      tail = Buffer.concat([head, tail])
      start = from
      const lines = tail.toString('utf8').split('\n')
      const whole = start === 0 ? lines : lines.slice(1)
      const { turns, started } = lastTurnsOfLines(whole, n)
      if (start === 0 || started > n) return turns
    }
  } finally {
    await fh.close()
  }
}

// CC§2
export function findTranscript(projectsRoot: string, sessionId: string): string | null {
  let buckets: string[]
  try {
    buckets = fs.readdirSync(projectsRoot)
  } catch {
    return null
  }
  const hits = buckets
    .map((b) => path.join(projectsRoot, b, sessionId + '.jsonl'))
    .filter((file) => fs.existsSync(file))
  if (hits.length < 2) return hits[0] ?? null
  return hits
    .map((file) => ({ file, size: fs.statSync(file, { throwIfNoEntry: false })?.size ?? -1 }))
    .reduce((a, b) => (b.size > a.size ? b : a)).file
}

export interface RemoteTab {
  host: string
  projectsRoot: string
  tmuxName: string
}

interface Tracked {
  info: SessionInfo
  compactingFrom?: Turn
  launchCwd: string
  readOffset: number
  tailBuf: Buffer
  titles: TitleSources
  touched: ClaudeTouchedFiles
  fileCache: Map<string, string>
  canonPending: Set<string>
  parsePromise?: Promise<void>
  parseAgain: boolean
  statusSeq: number
  caughtUp: boolean
  jsonlListener?: () => void
  sidecarTitle: string | null
  meter: UsageMeter
  subagentFiles: Map<string, SubagentFile>
  subagentScanMs: number
  ledger: BackgroundLedger
  teammateActiveMs: number
  lastBgActivityTs: number
  lastMainActivityTs: number
  bindMs: number
  resetMs: number
  reported: ReportedTask[] | null
  reportedAt: number
  openTools: Map<string, ToolCall>
  procs: TaskProcs | null
  shellCpu: Map<string, { cpuMs: number; at: number; quiet: boolean }>
  procsAt: number
  procsPromise?: Promise<void>
  lastInterruptTs: number
  rootPinAwaitingCatchup: boolean
  turns: TurnLog
  replyDone: boolean
  endingTurn?: { turn: TalkTurn; deadline: ReturnType<typeof setTimeout> }
  inode?: number
  swept?: boolean
  relocatedCwd?: string
  lastWorktreeStateInBatch?: string
  landTimer?: ReturnType<typeof setTimeout>
  remote?: RemoteTab
  subagentTimer?: ReturnType<typeof setInterval>
}

const APPEND_READ_CHUNK_BYTES = envMs('KOLOFT_APPEND_READ_CHUNK_BYTES', 256 * 1024)

export async function readAppendedLines(
  file: string,
  size: number,
  cur: { offset: number; tail: Buffer }
): Promise<string[] | null> {
  let newBytes: Buffer
  let fh: fs.promises.FileHandle | undefined
  try {
    fh = await fs.promises.open(file, 'r')
    const len = Math.min(size - cur.offset, APPEND_READ_CHUNK_BYTES)
    newBytes = Buffer.allocUnsafe(len)
    const { bytesRead } = await fh.read(newBytes, 0, len, cur.offset)
    if (bytesRead < len) newBytes = newBytes.subarray(0, bytesRead)
  } catch {
    return null
  } finally {
    await fh?.close()
  }
  cur.offset += newBytes.length
  const buf = cur.tail.length ? Buffer.concat([cur.tail, newBytes]) : newBytes
  const lastNl = buf.lastIndexOf(0x0a)
  if (lastNl === -1) {
    cur.tail = buf
    return []
  }
  cur.tail = Buffer.from(buf.subarray(lastNl + 1))
  return buf.toString('utf8', 0, lastNl).split('\n')
}

export class SessionTracker extends SessionRuntime {
  private tracked = new Map<string, Tracked>()
  private pendingPicked = new Map<string, string>()
  private emitTimer?: ReturnType<typeof setTimeout>
  private lastEmitMs = 0
  pidOf?: (tabId: string) => number | undefined
  inspect = async (
    rootPid: number,
    sessionId: string,
    roundMs?: number
  ): Promise<TaskProcs | null> =>
    inspectTaskProcs(
      await (roundMs ? sharedProcessTable.eachRound(roundMs) : sharedProcessTable.fresh()),
      rootPid,
      sessionId
    )
  leftBehind?: (sessionId: string) => boolean
  machineTmp?: (host: string) => MachineTmp | undefined

  track(tabId: string, cwd: string, remote?: RemoteTab): void {
    const prev = this.tracked.get(tabId)
    if (prev) this.cleanup(prev)

    const info: SessionInfo = {
      tabId,
      sessionId: '',
      title: PLACEHOLDER_SESSION_TITLE,
      cwd,
      treeRoot: cwd,
      jsonlPath: null,
      files: [],
      alive: true,
      updatedAt: Date.now()
    }
    if (remote) info.remote = { host: remote.host }
    const pendingPick = this.pendingPicked.get(tabId)
    if (pendingPick) {
      info.pickedAccount = pendingPick
      this.pendingPicked.delete(tabId)
    }
    const t: Tracked = {
      info,
      launchCwd: remote ? cwd : realpathSafe(cwd),
      readOffset: 0,
      tailBuf: Buffer.alloc(0),
      titles: new TitleSources(),
      touched: new ClaudeTouchedFiles(),
      fileCache: new Map(),
      canonPending: new Set(),
      sidecarTitle: null,
      parseAgain: false,
      statusSeq: 0,
      caughtUp: false,
      meter: new UsageMeter(),
      subagentFiles: new Map(),
      subagentScanMs: 0,
      ledger: new BackgroundLedger(),
      teammateActiveMs: 0,
      lastBgActivityTs: 0,
      lastMainActivityTs: 0,
      bindMs: Date.now(),
      resetMs: Date.now(),
      reported: null,
      reportedAt: 0,
      openTools: new Map(),
      procs: null,
      shellCpu: new Map(),
      procsAt: 0,
      lastInterruptTs: 0,
      rootPinAwaitingCatchup: false,
      turns: new TurnLog(),
      replyDone: false,
      remote
    }
    this.tracked.set(tabId, t)
    this.emitUpdate()
    // ADR-0025
    if (!remote) this.resolveWorktree(t)
  }

  setAlive(tabId: string, alive: boolean): void {
    if (!alive) this.pendingPicked.delete(tabId)
    const t = this.tracked.get(tabId)
    if (t) {
      if (!alive) this.stopFollowing(t)
      t.info.alive = alive
      t.info.updatedAt = Date.now()
      this.emitUpdate()
    }
  }

  receive(tabId: string, event: SessionEvent): void {
    const t = this.tracked.get(tabId)
    if (event.type === 'compacting' || event.type === 'compacted') {
      if (t) this.compaction(t, event)
      return
    }
    if (t && turnOf(event)) t.compactingFrom = undefined
    if (event.type === 'stop') void this.endTurn(tabId)
    const turn = turnOf(event)
    if (turn === 'working' || turn === 'approval') this.recordHookTurn(tabId, turn)
    // CC§8
    else if (turn)
      void this.reportTurnEnd(tabId, event.type === 'stop' ? event.reported : undefined)
  }

  // CC§1
  private compaction(
    t: Tracked,
    event: Extract<SessionEvent, { type: 'compacting' | 'compacted' }>
  ): void {
    const tabId = t.info.tabId
    if (event.type === 'compacting') {
      const claudeCompactsAFinishedTurnOnItsOwn = event.trigger === 'auto' && this.turnOver(tabId)
      if (claudeCompactsAFinishedTurnOnItsOwn) return
      t.compactingFrom = this.turnNow(tabId) ?? 'ended'
      this.recordHookTurn(tabId, 'working')
      return
    }
    const from = t.compactingFrom
    t.compactingFrom = undefined
    if (from && this.turnNow(tabId) === 'working') this.recordHookTurn(tabId, from)
  }

  setStatus(tabId: string, status: SessionStatus): void {
    this.recordHookTurn(tabId, status === 'working' || status === 'approval' ? status : 'ended')
  }

  private recordHookTurn(tabId: string, turn: Turn): void {
    const t = this.tracked.get(tabId)
    if (!t) return
    t.statusSeq++
    this.applyStatus(t, turn)
  }

  private applyStatus(t: Tracked, turn: Turn, heldByBackground = false): void {
    if (this.tracked.get(t.info.tabId) !== t) return
    this.recordTurn(t.info.tabId, turn, heldByBackground)
  }

  protected override statusChanged(tabId: string, status: SessionStatus): void {
    const t = this.tracked.get(tabId)
    if (!t) return
    t.info.status = status
    t.info.updatedAt = Date.now()
    this.emitUpdate()
  }

  protected override turnOverChanged(): void {
    this.emitUpdate()
  }

  protected override async workStillRunning(tabId: string): Promise<boolean> {
    const t = this.tracked.get(tabId)
    if (!t) return false
    if (this.leftBehind?.(t.info.sessionId)) return true
    if (t.remote) return false
    const root = this.pidOf?.(tabId)
    const sessionId = t.info.sessionId
    if (!root || !sessionId) return true
    const procs = await this.inspect(root, sessionId)
    return !procs || procs.shells.size > 0
  }

  async reportTurnEnd(tabId: string, list?: ReportedTask[]): Promise<void> {
    const t = this.tracked.get(tabId)
    if (!t) return
    const seq = t.statusSeq
    try {
      await this.parse(t)
    } catch {}
    if (this.tracked.get(tabId) !== t || t.statusSeq !== seq) return
    if (list !== undefined) {
      t.reportedAt = Date.now()
      t.reported = list
      await this.refreshProcs(t, true)
      if (this.tracked.get(tabId) !== t || t.statusSeq !== seq) return
    }
    this.endTurnHeldByWhatRuns(t)
  }

  private endTurnHeldByWhatRuns(t: Tracked): void {
    const busy = this.judgeHold(t)
    if (!busy) t.ledger.clear()
    this.applyStatus(t, 'ended', busy)
  }

  // CC§2
  private async endTurn(tabId: string): Promise<void> {
    const t = this.tracked.get(tabId)
    if (!t) return
    await this.parse(t).catch(() => {})
    const turn = t.turns.open()
    if (this.tracked.get(tabId) !== t || !turn) return
    if (t.replyDone) return this.finishTurn(t, turn)
    clearTimeout(t.endingTurn?.deadline)
    t.endingTurn = {
      turn,
      deadline: setTimeout(() => this.finishTurn(t, turn), TURN_TEXT_WAIT_MS)
    }
  }

  private finishTurn(t: Tracked, turn: TalkTurn): void {
    if (t.endingTurn?.turn === turn) {
      clearTimeout(t.endingTurn.deadline)
      t.endingTurn = undefined
    }
    if (this.tracked.get(t.info.tabId) === t && t.turns.end(turn))
      this.emit('turn-ended', { tabId: t.info.tabId, turn: { ...turn, said: [...turn.said] } })
  }

  private judgeHold(t: Tracked): boolean {
    if (t.reported) return this.judgeReported(t)
    const busy = this.bgBusy(t)
    this.setBackgroundItems(t, busy ? [UNLISTED_BACKGROUND_WORK] : [])
    return busy
  }

  private judgeReported(t: Tracked, holding = true): boolean {
    const now = Date.now()
    const list = t.reported ?? []
    const procs = t.procs
    const parked: BackgroundItem[] = []
    const running: BackgroundItem[] = []
    const run = (task: ReportedTask, kind: BackgroundItem['kind'], label: string): void => {
      running.push({ id: task.id, kind, label, state: 'working' })
    }
    let observed = false
    let trusted = false
    const reportedIds = new Set(list.map((x) => x.id))
    const toolCallInFlight = !!procs && [...procs.shells.keys()].some((id) => !reportedIds.has(id))
    const agentsFresh = now - Math.max(t.lastBgActivityTs, t.reportedAt) < BG_SILENCE_MAX_MS
    const teammatesFresh = now - t.teammateActiveMs < TEAMMATE_QUIET_MS
    let idleTeammates = 0
    for (const task of list) {
      if (t.ledger.isMonitor(task.id)) {
        const label = t.ledger.labelOf(task.id) ?? task.id
        parked.push({ id: task.id, kind: 'monitor', label, state: 'waiting' })
      } else if (task.type === 'shell') {
        const label = t.ledger.labelOf(task.id) ?? task.id
        if (!procs) {
          trusted = true
          run(task, 'command', label)
        } else {
          const sh = procs.shells.get(task.id)
          if (!sh) {
            if ((task.since ?? 0) > t.procsAt) {
              observed = true
              run(task, 'command', label)
            }
            continue
          }
          if (sh.listening && t.shellCpu.get(task.id)?.quiet) {
            parked.push({
              id: task.id,
              kind: 'server',
              label,
              state: 'waiting',
              ageMs: Math.floor(sh.ageMs / 60_000) * 60_000
            })
          } else {
            observed = true
            run(task, 'command', label)
          }
        }
      } else if (AGENT_TYPES.has(task.type)) {
        if (agentsFresh || toolCallInFlight) {
          observed = true
          run(task, 'agent', t.ledger.labelOf(task.id) ?? task.type)
        }
      } else if (task.type === 'teammate') {
        if (teammatesFresh || toolCallInFlight) {
          observed = true
          run(task, 'agent', 'teammate')
        } else idleTeammates++
      }
    }
    if (idleTeammates)
      parked.push({
        id: 'teammates',
        kind: 'teammate',
        label: `${idleTeammates} idle`,
        state: 'waiting'
      })
    const busy = observed || (trusted && this.quietMs(t) < BG_SILENCE_MAX_MS)
    this.setBackgroundItems(t, busy && holding ? [...running, ...parked] : parked)
    return busy
  }

  private setBackgroundItems(t: Tracked, items: BackgroundItem[]): void {
    if (this.tracked.get(t.info.tabId) !== t || !this.setBackground(t.info.tabId, items)) return
    t.info.background = items.length ? items : undefined
    t.info.updatedAt = Date.now()
    this.emitUpdate()
  }

  private async refreshProcs(t: Tracked, force = false): Promise<void> {
    if (t.remote) return
    const list = t.reported
    const observable = (x: ReportedTask): boolean =>
      x.type === 'teammate' || AGENT_TYPES.has(x.type) || x.type === 'shell'
    if (!list?.some(observable)) return
    if (t.procsPromise) await t.procsPromise
    if (!force && Date.now() - t.procsAt < PROCS_SCAN_MS) return
    const root = this.pidOf?.(t.info.tabId)
    const sessionId = t.info.sessionId
    if (!root || !sessionId) return
    t.procsPromise = (async () => {
      try {
        const procs = await this.inspect(root, sessionId, force ? undefined : PROCS_SCAN_MS)
        if (this.tracked.get(t.info.tabId) !== t) return
        t.procs = procs
        t.procsAt = procs?.at ?? Date.now()
        if (procs) this.sampleShellCpu(t, procs, t.procsAt)
      } finally {
        t.procsPromise = undefined
      }
    })()
    await t.procsPromise
  }

  private sampleShellCpu(t: Tracked, procs: TaskProcs, now: number): void {
    for (const id of t.shellCpu.keys()) if (!procs.shells.has(id)) t.shellCpu.delete(id)
    for (const [id, sh] of procs.shells) {
      const prev = t.shellCpu.get(id)
      if (!prev) t.shellCpu.set(id, { cpuMs: sh.cpuMs, at: now, quiet: false })
      else if (now - prev.at >= SERVER_QUIET_WINDOW_MS) {
        const perMinute = ((sh.cpuMs - prev.cpuMs) * 60_000) / (now - prev.at)
        t.shellCpu.set(id, {
          cpuMs: sh.cpuMs,
          at: now,
          quiet: perMinute < IDLE_SERVER_CPU_MS_PER_MINUTE
        })
      }
    }
  }

  private quietMs(t: Tracked): number {
    return (
      Date.now() -
      Math.max(t.lastMainActivityTs, t.lastBgActivityTs, this.statusSince(t.info.tabId))
    )
  }

  private bgBusy(t: Tracked): boolean {
    const quietMs = Date.now() - t.lastBgActivityTs
    if (t.ledger.held) return quietMs < BG_SILENCE_MAX_MS
    return t.lastBgActivityTs > t.lastMainActivityTs && quietMs < STOP_HOLD_MS
  }

  // CC§1
  bindSession(
    tabId: string,
    transcriptPath: string,
    sessionId: string,
    cwd = '',
    account = '',
    ccVersion = '',
    source = ''
  ): void {
    const t = this.tracked.get(tabId)
    if (!t) return
    if (account && t.info.account !== account) {
      t.info.account = account
      t.info.updatedAt = Date.now()
      this.emitUpdate()
    }
    if (ccVersion && t.info.cliVersion !== ccVersion) {
      t.info.cliVersion = ccVersion
      t.info.updatedAt = Date.now()
      this.emitUpdate()
    }
    if (cwd) {
      if (source !== 'compact') this.setTreeRoot(t, cwd)
      if (cwd !== t.info.cwd) {
        t.info.cwd = cwd
        t.info.updatedAt = Date.now()
        this.emitUpdate()
      }
    } else if (source !== 'compact') {
      t.rootPinAwaitingCatchup = true
    }
    let file = transcriptPath
    if (t.remote) {
      const slug = transcriptPath
        ? path.basename(path.dirname(transcriptPath))
        : encodeCwd(cwd || t.info.cwd)
      file = sessionId ? path.join(t.remote.projectsRoot, slug, sessionId + '.jsonl') : ''
    } else if (!file && sessionId) {
      file = path.join(PROJECTS_ROOT, encodeCwd(t.info.cwd), sessionId + '.jsonl')
    }
    if (file && file !== t.info.jsonlPath) this.bind(t, file)
    if (source !== 'compact') {
      t.reported = null
      this.setBackgroundItems(t, [])
      this.setStatus(tabId, 'waiting')
    }
  }

  setPickedAccount(tabId: string, account: string): void {
    const t = this.tracked.get(tabId)
    if (!t) {
      this.pendingPicked.set(tabId, account)
      return
    }
    if (t.info.pickedAccount !== account) {
      t.info.pickedAccount = account
      t.info.updatedAt = Date.now()
      this.emitUpdate()
    }
  }

  movePick(from: string, to: string): void {
    const account = this.pendingPicked.get(from)
    if (!account) return
    this.pendingPicked.delete(from)
    this.setPickedAccount(to, account)
  }

  launchedSessions(): LaunchedSession[] {
    const tracked = [...this.tracked.values()]
      .filter((t) => t.info.alive)
      .map(({ info }) => ({
        tabId: info.tabId,
        account: info.pickedAccount ?? info.account,
        status: info.status
      }))
    const awaiting = [...this.pendingPicked].map(([tabId, account]) => ({ tabId, account }))
    return [...tracked, ...awaiting]
  }

  untrack(tabId: string): void {
    const t = this.tracked.get(tabId)
    if (t) this.cleanup(t)
    this.tracked.delete(tabId)
    this.emitUpdate()
  }

  remoteOf(tabId: string): RemoteTab | undefined {
    return this.tracked.get(tabId)?.remote
  }

  infoOf(tabId: string): SessionInfo | undefined {
    return this.tracked.get(tabId)?.info
  }

  setRemoteTmuxName(tabId: string, tmuxName: string): void {
    const t = this.tracked.get(tabId)
    if (t?.remote) t.remote.tmuxName = tmuxName
  }

  list(): SessionInfo[] {
    return [...this.tracked.values()].map((t) => t.info)
  }

  // CC§2
  transcriptExists(sessionId: string): boolean {
    if (!sessionId) return false
    for (const t of this.tracked.values()) {
      if (t.info.sessionId !== sessionId) continue
      return !!t.info.jsonlPath && fs.existsSync(t.info.jsonlPath)
    }
    return !!findTranscript(PROJECTS_ROOT, sessionId)
  }

  turnsOf(sessionId: string, n: number): TalkTurn[] | undefined {
    for (const t of this.tracked.values())
      if (t.info.alive && t.info.sessionId === sessionId) return t.turns.last(n)
    return undefined
  }

  aliveTabFor(sessionId: string): string | null {
    if (!sessionId) return null
    for (const t of this.tracked.values()) {
      if (t.info.alive && t.info.sessionId === sessionId) return t.info.tabId
    }
    return null
  }

  private cleanup(t: Tracked): void {
    this.forget(t.info.tabId)
    this.stopFollowing(t)
  }

  private stopFollowing(t: Tracked): void {
    if (t.subagentTimer) clearInterval(t.subagentTimer)
    if (t.landTimer) clearTimeout(t.landTimer)
    this.unwatchTranscript(t)
  }

  // CC§2 PLATFORM§1
  private resolveWorktree(t: Tracked): void {
    if (t.remote) return
    this.applyWorktree(
      t,
      t.info.treeRoot ? projectInfoFor(t.info.treeRoot).worktreeName : undefined
    )
  }

  // CC§1 CC§2 CC§3 ADR-0025
  private followWorktreeState(t: Tracked): void {
    const bound = t.lastWorktreeStateInBatch
    t.lastWorktreeStateInBatch = undefined
    if (!bound || t.remote || t.landTimer || bound === t.info.treeRoot || !fs.existsSync(bound))
      return
    this.setTreeRoot(t, bound)
  }

  private setTreeRoot(t: Tracked, root: string): void {
    t.rootPinAwaitingCatchup = false
    if (!root || t.info.treeRoot === root) return
    t.info.treeRoot = root
    t.info.updatedAt = Date.now()
    this.resolveWorktree(t)
    this.emitUpdate()
  }

  private applyWorktree(t: Tracked, name: string | undefined): void {
    if (t.info.worktree === name) return
    t.info.worktree = name
    t.info.updatedAt = Date.now()
    this.emitUpdate()
  }

  private emitUpdate(): void {
    if (this.emitTimer) return
    const wait = Math.max(0, EMIT_THROTTLE_MS - (Date.now() - this.lastEmitMs))
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined
      this.lastEmitMs = Date.now()
      this.emit('update', this.list())
    }, wait)
  }

  private resetParseState(t: Tracked, keepBindMs = false): void {
    t.readOffset = 0
    t.tailBuf = Buffer.alloc(0)
    t.titles = new TitleSources()
    t.touched = new ClaudeTouchedFiles()
    t.fileCache = new Map()
    t.relocatedCwd = undefined
    t.lastWorktreeStateInBatch = undefined
    t.info.lastTouched = undefined
    t.info.lastWritten = undefined
    t.caughtUp = false
    t.meter = new UsageMeter()
    t.subagentFiles = new Map()
    t.subagentScanMs = 0
    t.info.usage = undefined
    t.ledger = new BackgroundLedger()
    t.teammateActiveMs = 0
    t.openTools = new Map()
    t.lastBgActivityTs = 0
    t.lastMainActivityTs = 0
    t.lastInterruptTs = 0
    t.turns = new TurnLog()
    t.replyDone = false
    clearTimeout(t.endingTurn?.deadline)
    t.endingTurn = undefined
    if (!keepBindMs) t.bindMs = Date.now()
    t.resetMs = Date.now()
  }

  // PLATFORM§28
  private watchTranscript(t: Tracked, file: string): void {
    this.unwatchTranscript(t)
    t.info.jsonlPath = file
    t.sidecarTitle = null
    t.jsonlListener ??= (): void => void this.parse(t)
    fs.watchFile(file, { interval: 500 }, t.jsonlListener)
    void this.readSidecarTitle(t)
  }

  // PLATFORM§28
  private unwatchTranscript(t: Tracked): void {
    if (t.info.jsonlPath && t.jsonlListener) fs.unwatchFile(t.info.jsonlPath, t.jsonlListener)
  }

  private async readSidecarTitle(t: Tracked): Promise<void> {
    const file = t.info.jsonlPath
    if (!file) return
    let title: string | null = null
    try {
      title = (await fs.promises.readFile(this.sidecarOf(file), 'utf8')).trim() || null
    } catch {}
    if (t.info.jsonlPath !== file || this.tracked.get(t.info.tabId) !== t) return
    if (title === t.sidecarTitle) return
    t.sidecarTitle = title
    this.recompute(t)
  }

  private bind(t: Tracked, file: string): void {
    this.watchTranscript(t, file)
    t.info.sessionId = path.basename(file, '.jsonl')
    if (t.landTimer) clearTimeout(t.landTimer)
    t.landTimer = undefined
    t.info.relocated = undefined
    t.info.scratchpadDir = this.scratchpadOf(t, file)
    this.resetParseState(t)
    t.swept = false
    try {
      const st = fs.statSync(file)
      t.caughtUp = st.size === 0
      // PLATFORM§34
      t.inode = t.remote ? undefined : st.ino
    } catch {
      t.caughtUp = true
      t.inode = undefined
    }
    if (t.subagentTimer) clearInterval(t.subagentTimer)
    t.subagentTimer = setInterval(() => {
      void this.readSidecarTitle(t)
      void this.parse(t)
    }, SUBAGENT_SCAN_MS)
    this.recompute(t)
    void this.parse(t)
  }

  private scratchpadOf(t: Tracked, file: string): string | undefined {
    const machine = t.remote ? (this.machineTmp?.(t.remote.host) ?? null) : undefined
    return scratchpadDirFor(file, t.launchCwd, machine) ?? undefined
  }

  fillMachineScratchpads(host: string): void {
    for (const t of this.tracked.values()) {
      if (t.remote?.host !== host || t.info.scratchpadDir || !t.info.jsonlPath) continue
      t.info.scratchpadDir = this.scratchpadOf(t, t.info.jsonlPath)
      if (t.info.scratchpadDir) this.recompute(t)
    }
  }

  private resolvePath(t: Tracked, raw: string): string | null {
    let p = raw
    if (p === '~' || p === '~/') return null
    if (p.startsWith('~/')) {
      // ADR-0025
      if (t.remote) return null
      p = path.join(os.homedir(), p.slice(2))
    } else if (!path.isAbsolute(p)) p = path.resolve(t.info.cwd, p)
    return p
  }

  private parse(t: Tracked): Promise<void> {
    if (t.parsePromise) {
      t.parseAgain = true
      return t.parsePromise
    }
    t.parsePromise = (async () => {
      try {
        do {
          t.parseAgain = false
          await this.parseOnce(t)
        } while (t.parseAgain)
      } finally {
        t.parsePromise = undefined
      }
    })()
    return t.parsePromise
  }

  // CC§2
  private async followRelocation(t: Tracked): Promise<fs.Stats | undefined> {
    const p = t.info.jsonlPath
    if (!p) return undefined
    const st = await this.statSafe(p)
    if (st) {
      if (t.inode === undefined || st.ino === t.inode) return st
    } else if (t.swept) {
      return undefined
    }
    const moved = this.findRelocated(t)
    if (!moved) {
      t.swept = true
      return st
    }
    this.adoptRelocated(t, moved)
    return await this.statSafe(moved)
  }

  private async statSafe(p: string): Promise<fs.Stats | undefined> {
    try {
      return await fs.promises.stat(p)
    } catch {
      return undefined
    }
  }

  // CC§2 PLATFORM§34
  private findRelocated(t: Tracked): string | null {
    const id = t.info.sessionId
    if (!id) return null
    if (t.remote ? !t.readOffset : t.inode === undefined) return null
    const root = t.remote ? t.remote.projectsRoot : PROJECTS_ROOT
    let buckets: string[]
    try {
      buckets = fs.readdirSync(root)
    } catch {
      return null
    }
    let newest: { file: string; mtimeMs: number } | null = null
    for (const b of buckets) {
      const file = path.join(root, b, id + '.jsonl')
      if (file === t.info.jsonlPath) continue
      let st: fs.Stats
      try {
        st = fs.statSync(file)
      } catch {
        continue
      }
      if (!t.remote) {
        if (st.ino === t.inode) return file
      } else if (!newest || st.mtimeMs > newest.mtimeMs) {
        newest = { file, mtimeMs: st.mtimeMs }
      }
    }
    return newest?.file ?? null
  }

  private adoptRelocated(t: Tracked, file: string): void {
    this.watchTranscript(t, file)
    t.info.updatedAt = Date.now()
    this.emitUpdate()
    if (t.landTimer) clearTimeout(t.landTimer)
    t.landTimer = setTimeout(() => {
      t.landTimer = undefined
      this.land(t)
    }, RELOCATE_SETTLE_MS)
  }

  // CC§2 CC§4
  private land(t: Tracked): void {
    const dir = t.relocatedCwd
    t.relocatedCwd = undefined
    if (!dir || dir === t.info.treeRoot) return
    const leftItsWorktreeForItsCheckout = worktreeHomeRoot(t.info.treeRoot) === dir
    t.info.relocated = true
    this.setTreeRoot(t, dir)
    if (!leftItsWorktreeForItsCheckout) this.emit('relocated', { tabId: t.info.tabId, dir })
  }

  private async parseOnce(t: Tracked): Promise<void> {
    if (!t.info.jsonlPath) return
    let mainChanged = false
    const st = await this.followRelocation(t)
    const p = t.info.jsonlPath
    if (st) {
      t.swept = false
      if (!t.remote) t.inode = st.ino
      if (st.size < t.readOffset) this.resetParseState(t, true)
      if (st.size > t.readOffset) mainChanged = await this.ingestMainAppend(t, p, st)
    }
    const subChanged = await this.tailSubagents(t)
    const s = t.info.status
    if (this.isHeldByBackground(t.info.tabId) || (s !== 'working' && s !== 'approval'))
      await this.refreshProcs(t)
    if (mainChanged || subChanged) this.recompute(t)
    this.reconcileBackground(t)
  }

  private reconcileBackground(t: Tracked): void {
    const s = t.info.status
    if (
      (s === 'waiting' || s === 'idle') &&
      t.caughtUp &&
      t.lastBgActivityTs > this.statusSince(t.info.tabId) + RESUME_AFTER_STOP_MS
    ) {
      this.applyStatus(t, 'ended', true)
      t.ledger.promote()
      return
    }
    if (!this.isHeldByBackground(t.info.tabId)) {
      if (t.reported && s !== 'working' && s !== 'approval') this.judgeReported(t, false)
      return
    }
    const busy = this.judgeHold(t)
    if (!busy) {
      if (Date.now() - t.lastMainActivityTs < STOP_HOLD_MS) return
      t.ledger.clear()
      this.applyStatus(t, 'ended')
    }
  }

  private async ingestMainAppend(t: Tracked, p: string, st: fs.Stats): Promise<boolean> {
    let sawLines = false
    let sawUserPrompt = false
    let sawAssistant = false
    let sawInterrupt = false
    while (t.readOffset < st.size) {
      const cur = { offset: t.readOffset, tail: t.tailBuf }
      const lines = await readAppendedLines(p, st.size, cur)
      if (this.tracked.get(t.info.tabId) !== t || t.info.jsonlPath !== p) return false
      if (lines === null || cur.offset === t.readOffset) break
      t.readOffset = cur.offset
      t.tailBuf = cur.tail
      if (lines.length) sawLines = true
      for (const line of lines) {
        if (!line) continue
        const activity = this.ingestLine(t, line)
        if (activity === 'user') {
          sawUserPrompt = true
          sawInterrupt = false
        } else if (activity === 'assistant') sawAssistant = true
        else if (activity === 'interrupt') sawInterrupt = true
      }
    }
    if (!sawLines) return false
    if (t.rootPinAwaitingCatchup) this.setTreeRoot(t, t.info.cwd)
    this.followWorktreeState(t)
    if (sawInterrupt) await this.interruptTurn(t)
    else if (t.caughtUp) this.resumeWorkingIfStale(t, sawUserPrompt, sawAssistant)
    if (!t.caughtUp) {
      const history = t.turns.open()
      if (history && history.at < t.bindMs) t.turns.end(history)
      t.caughtUp = true
    }
    return true
  }

  private async interruptTurn(t: Tracked): Promise<void> {
    const s = t.info.status
    if (s !== 'working' && s !== 'approval') return
    const tabId = t.info.tabId
    if (this.statusSince(tabId) > t.lastInterruptTs) return
    if (t.reported) {
      await this.refreshProcs(t, true)
      if (this.tracked.get(tabId) !== t || this.statusSince(tabId) > t.lastInterruptTs) return
    }
    this.endTurnHeldByWhatRuns(t)
  }

  private async tailSubagents(t: Tracked): Promise<boolean> {
    const p = t.info.jsonlPath
    if (!p || !t.info.sessionId) return false
    const now = Date.now()
    const rescan = now - t.subagentScanMs >= SUBAGENT_SCAN_MS
    if (rescan) {
      t.subagentScanMs = now
      const files = t.subagentFiles
      const found = await listSubagentJsonls(
        path.join(path.dirname(p), t.info.sessionId, 'subagents')
      )
      if (this.tracked.get(t.info.tabId) !== t || t.subagentFiles !== files) return false
      for (const f of found) {
        if (!files.has(f)) files.set(f, { offset: 0, tail: Buffer.alloc(0), activeMs: now })
      }
    }
    const due = [...t.subagentFiles].filter(
      ([, sst]) => rescan || now - sst.activeMs < SUBAGENT_SCAN_MS
    )
    const folded = await Promise.all(due.map(([file, sst]) => this.tailSubagentFile(t, file, sst)))
    return folded.some(Boolean)
  }

  private async tailSubagentFile(t: Tracked, file: string, sst: SubagentFile): Promise<boolean> {
    const stale = (): boolean =>
      this.tracked.get(t.info.tabId) !== t || t.subagentFiles.get(file) !== sst
    let st: fs.Stats
    try {
      st = await fs.promises.stat(file)
    } catch {
      return false
    }
    if (st.size < sst.offset) {
      sst.offset = 0
      sst.tail = Buffer.alloc(0)
    }
    if (st.size === sst.offset) return false
    sst.activeMs = Date.now()
    if (sst.teammate === undefined) {
      sst.teammate = await readTeammateFlag(file)
      if (stale()) return false
    }
    if (sst.teammate) t.teammateActiveMs = sst.activeMs
    let folded = false
    while (sst.offset < st.size) {
      const from = sst.offset
      const lines = await readAppendedLines(file, st.size, sst)
      if (stale()) return false
      if (lines === null || sst.offset === from) break
      for (const line of lines) {
        const obj = parseRecord(line)
        if (!obj) continue
        const ts = Math.min(Date.parse(obj.timestamp ?? ''), Date.now())
        if (isFinite(ts) && ts > t.lastBgActivityTs) t.lastBgActivityTs = ts
        if (obj.type === 'assistant' && obj.message?.usage) {
          t.meter.add(obj, false)
          folded = true
        }
      }
    }
    return folded
  }

  // PLATFORM§28
  private resumeWorkingIfStale(t: Tracked, sawUserPrompt: boolean, sawAssistant: boolean): void {
    const s = t.info.status
    if (!s || s === 'working') return
    if (sawUserPrompt) {
      this.applyStatus(t, 'working')
      return
    }
    if (!sawAssistant) return
    if (s === 'approval' || s === 'idle') {
      this.applyStatus(t, 'working')
    } else if (
      s === 'waiting' &&
      Date.now() - this.statusSince(t.info.tabId) > RESUME_AFTER_STOP_MS
    ) {
      // CC§2
      this.applyStatus(t, 'working')
    }
  }

  private ingestSpawnAck(t: Tracked, obj: TranscriptRecord): void {
    const tur = obj.toolUseResult
    const content = obj.message?.content
    if (!isBackgroundSpawnAck(tur) || !Array.isArray(content)) return
    const ts = Date.parse(obj.timestamp ?? '')
    const live = t.caughtUp || (isFinite(ts) && ts >= t.bindMs && ts <= Date.now())
    if (!live) return
    const toolUseIds: string[] = []
    for (const b of content) {
      if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string')
        toolUseIds.push(b.tool_use_id)
    }
    const task = t.ledger.noteSpawnAck(tur, toolUseIds)
    // CC§8
    if (tur.status === 'teammate_spawned') t.teammateActiveMs = Date.now()
    if (task && t.reported && !t.reported.some((x) => x.id === task.id)) {
      t.reported.push({ ...task, since: Date.now() })
    }
    const at = Math.min(isFinite(ts) ? ts : Date.now(), Date.now())
    if (at > t.lastBgActivityTs) t.lastBgActivityTs = at
  }

  // CC§14
  private ingestToolDone(t: Tracked, obj: TranscriptRecord): void {
    const content = obj.message?.content
    if (!Array.isArray(content)) return
    for (const b of content) {
      if (b?.type !== 'tool_result') continue
      const call = t.openTools.get(b.tool_use_id)
      if (!call) continue
      t.openTools.delete(b.tool_use_id)
      if (t.caughtUp) this.emit('tool-done', { tabId: t.info.tabId, ...call })
    }
  }

  // CC§8
  private ingestTaskNotification(t: Tracked, obj: TranscriptRecord): void {
    const text = taskNotificationText(obj)
    if (text === null) return
    const gone = t.ledger.noteNotification(text)
    if (t.reported && gone.size) t.reported = t.reported.filter((x) => !gone.has(x.id))
  }

  private ingestLine(t: Tracked, line: string): 'user' | 'assistant' | 'interrupt' | null {
    const obj = parseRecord(line)
    if (!obj) return null
    let activity: 'user' | 'assistant' | 'interrupt' | null = null
    if (typeof obj.cwd === 'string' && obj.cwd && obj.cwd !== t.info.cwd) {
      t.info.cwd = obj.cwd
      // ADR-0025
      if (!t.remote && !fs.existsSync(t.info.treeRoot)) this.setTreeRoot(t, obj.cwd)
    }
    t.titles.noteRecord(obj)
    // CC§2
    if (obj.type === 'relocated' && typeof obj.relocatedCwd === 'string' && obj.relocatedCwd) {
      t.relocatedCwd = obj.relocatedCwd
    }
    if (obj.type === 'worktree-state') {
      const bound = obj.worktreeSession?.worktreePath
      t.lastWorktreeStateInBatch = typeof bound === 'string' && bound ? bound : undefined
    }
    // CC§2
    const recTs = Math.min(Date.parse(obj.timestamp ?? ''), Date.now())
    const mainThread = obj.isSidechain !== true
    if (isFinite(recTs)) {
      if (!mainThread) {
        if (recTs > t.lastBgActivityTs) t.lastBgActivityTs = recTs
      } else if (recTs > t.lastMainActivityTs) {
        t.lastMainActivityTs = recTs
      }
    }
    for (const piece of claudeTurnPieces(obj)) {
      if (piece === 'tool') t.replyDone = false
      else {
        t.turns.add(piece.line, piece.midTurn)
        t.replyDone = piece.line.who === 'assistant'
      }
    }
    const ending = t.endingTurn?.turn
    if (ending && (t.replyDone || ending !== t.turns.open())) this.finishTurn(t, ending)
    if (obj.type === 'user') {
      this.ingestSpawnAck(t, obj)
      this.ingestToolDone(t, obj)
    }
    this.ingestTaskNotification(t, obj)
    const output = t.caughtUp ? commandOutputOf(obj) : null
    if (output) this.emit('command-output', { tabId: t.info.tabId, ...output })
    if (obj.type === 'user' && !obj.isMeta && !compactionSummary(obj)) {
      const c = obj.message?.content
      let raw: string | null = null
      let hasImage = false
      if (typeof c === 'string') raw = c
      else if (Array.isArray(c)) {
        const text = c.find((x): x is TextBlock => x?.type === 'text')
        if (text?.text) raw = text.text
        hasImage = c.some((x) => x?.type === 'image')
      }
      if (raw !== null && INTERRUPT_TEXTS.has(raw) && mainThread) {
        if (t.caughtUp || (isFinite(recTs) && recTs >= t.resetMs)) {
          const at = isFinite(recTs) ? recTs : Date.now()
          if (at > t.lastInterruptTs) t.lastInterruptTs = at
          return 'interrupt'
        }
        return null
      }
      const cls = raw !== null ? classifyUserPrompt(raw) : null
      const named = raw !== null && whoTyped(obj, raw) ? cls : null
      if (named) t.titles.notePrompt(named)
      if ((cls?.genuine || hasImage) && mainThread && !commandEcho(obj, raw)) {
        activity = 'user'
        if (
          (t.caughtUp || (isFinite(recTs) && recTs >= t.resetMs)) &&
          this.isHeldByBackground(t.info.tabId)
        ) {
          this.applyStatus(t, 'working')
        }
      }
    }
    if (obj.type === 'assistant' && obj.message?.usage) {
      t.meter.add(obj, mainThread)
    }
    const content = obj.message?.content
    if (obj.type === 'assistant' && Array.isArray(content)) {
      if (mainThread) activity = 'assistant'
      const liveNow = t.caughtUp || (isFinite(recTs) && recTs >= t.bindMs)
      for (const b of content) {
        if (!b || b.type !== 'tool_use') continue
        if (liveNow && typeof b.id === 'string') {
          if (t.openTools.size >= UNACKED_TOOL_CAP)
            t.openTools.delete(t.openTools.keys().next().value as string)
          t.openTools.set(b.id, { name: b.name, input: b.input ?? {} })
        }
        const labelField = TASK_LABEL_FIELD[b.name]
        const label = labelField ? b.input?.[labelField] : undefined
        if (typeof label === 'string') {
          t.ledger.noteToolLabel(b.id, label)
          if (b.name === 'Bash' && liveNow && BASH_WRITES.test(label)) {
            t.info.liveWrites = (t.info.liveWrites ?? 0) + 1
          }
        }
        // CC§2
        const raw = toolFilePath(b.input)
        const fp = raw ? this.resolvePath(t, raw) : null
        if (!fp) continue
        const at = isFinite(recTs) ? recTs : Date.now()
        if (t.touched.noteToolCall(b.name, b.input, fp, at) && liveNow)
          t.info.liveWrites = (t.info.liveWrites ?? 0) + 1
      }
    }
    return activity
  }

  private sidecarOf(jsonlPath: string): string {
    return jsonlPath.replace(/\.jsonl$/, '.title')
  }

  private recompute(t: Tracked): void {
    const byCanon = new Map<string, PreviewItem>()
    for (const [abs, acc] of t.touched.files) {
      const canon = this.canonFile(t, abs)
      if (!canon) continue
      const ex = byCanon.get(canon)
      if (ex) {
        ex.added = (ex.added ?? 0) + acc.added
        ex.removed = (ex.removed ?? 0) + acc.removed
        if (acc.access === 'wrote') {
          ex.access = 'wrote'
          ex.wroteAt = Math.max(ex.wroteAt ?? 0, acc.wroteAt)
        }
      } else {
        byCanon.set(canon, touchedItem(canon, acc))
      }
    }
    const files = capTouched([...byCanon.values()])

    t.info.title = t.titles.title(t.sidecarTitle)
    t.info.files = files
    const { lastTouched, lastWritten } = t.touched
    t.info.lastTouched = lastTouched ? (this.canonFile(t, lastTouched) ?? undefined) : undefined
    t.info.lastWritten = lastWritten ? (this.canonFile(t, lastWritten) ?? undefined) : undefined
    t.info.usage = t.meter.usage()
    t.info.updatedAt = Date.now()
    this.emitUpdate()
  }

  private canonFile(t: Tracked, abs: string): string | null {
    const cached = t.fileCache.get(abs)
    if (cached !== undefined) return cached
    // ADR-0025
    if (t.remote) return abs
    if (!t.canonPending.has(abs)) {
      t.canonPending.add(abs)
      void this.resolveCanon(t, abs)
    }
    return null
  }

  private async resolveCanon(t: Tracked, abs: string): Promise<void> {
    let real: string | undefined
    try {
      if ((await fs.promises.stat(abs)).isFile()) real = await fs.promises.realpath(abs)
    } catch {}
    t.canonPending.delete(abs)
    if (real === undefined || this.tracked.get(t.info.tabId) !== t) return
    t.fileCache.set(abs, real)
    this.recompute(t)
  }
}
