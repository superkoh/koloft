import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type {
  ClaudeSessionInfo as SessionInfo,
  PreviewItem,
  SessionStatus,
  FileAccess,
  SessionUsage,
  ParkedItem
} from '@shared/types'
import { PLACEHOLDER_SESSION_TITLE } from '@shared/types'
import { basename } from '@shared/preview'
import { resolvePricing } from '@shared/pricing'
import { localDayKey } from '@shared/usageFormat'
import { encodeCwd } from '@shared/cwdKey'
import { projectInfoFor } from './projectInfo'
import { inspectTaskProcs, type TaskProcs } from './taskProcs'

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects')
const TMP_ROOT = ((): string => {
  try {
    return fs.realpathSync('/tmp')
  } catch {
    return '/tmp'
  }
})()
const MAX_FILES = 300
const SUBAGENT_SCAN_MS = envMs('KOLOFT_SUBAGENT_SCAN_MS', 5000)
const EMIT_THROTTLE_MS = 500
const IDLE_MS = envMs('KOLOFT_IDLE_MS', 4 * 60_000)
// CC§12
const AUTO_CLOSE_MS = envMs('KOLOFT_IDLE_CLOSE_MS', 30 * 60_000)
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

export { encodeCwd }

function num(x: unknown): number {
  return typeof x === 'number' && isFinite(x) && x > 0 ? x : 0
}

function envMs(name: string, dflt: number): number {
  const v = process.env[name]
  const n = v && v.trim() ? Number(v) : NaN
  return isFinite(n) && n >= 0 ? n : dflt
}

const BG_PROMOTED = '\x00promoted'

// CC§8
export interface ReportedTask {
  id: string
  type: string
  since?: number
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

// CC§8
const AGENT_TYPES = new Set(['subagent', 'workflow', 'mcp-task', 'cloud-session'])

// CC§8
const BG_SPAWN_STATUSES = new Set(['async_launched', 'teammate_spawned', 'remote_launched'])

// CC§8
const TERMINAL_TASK_STATUSES = new Set([
  'completed',
  'failed',
  'killed',
  'stopped',
  'cancelled',
  'canceled'
])

// CC§8
function isBackgroundSpawnAck(tur: unknown): boolean {
  if (!tur || typeof tur !== 'object') return false
  const r = tur as Record<string, unknown>
  if (typeof r.status === 'string' && BG_SPAWN_STATUSES.has(r.status)) return true
  if (r.status === 'forked' && r.background === true) return true
  if (typeof r.backgroundTaskId === 'string' && r.backgroundTaskId) return true
  return typeof r.taskId === 'string' && r.taskId !== '' && typeof r.timeoutMs === 'number'
}

// CC§8
function taskNotificationText(obj: any): string | null {
  if (obj?.type === 'attachment') {
    const a = obj.attachment
    return a?.commandMode === 'task-notification' && typeof a.prompt === 'string' ? a.prompt : null
  }
  if (obj?.type === 'queue-operation') {
    const c = obj.content
    return typeof c === 'string' && c.startsWith('<task-notification>') ? c : null
  }
  if (obj?.origin?.kind === 'task-notification') {
    const c = obj.message?.content
    if (typeof c === 'string') return c
    if (Array.isArray(c))
      return c.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
    return ''
  }
  return null
}

// CC§8
function readTeammateFlag(jsonl: string): boolean | undefined {
  try {
    const meta = JSON.parse(fs.readFileSync(jsonl.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
    return meta?.taskKind === 'in_process_teammate'
  } catch {
    return undefined
  }
}

// CC§8
function listSubagentJsonls(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, depth: number): void => {
    if (depth > 6 || out.length >= 500) return
    let ents: fs.Dirent[]
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
      if (out.length >= 500) return
    }
  }
  walk(dir, 0)
  return out
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
// CC§2
const BASH_WRITES = /(^|[^0-9&])>>?\s*(?!\/dev\/null)\S|\btee\s|\bsed\s+-i\b|\btouch\s/
const READ_TOOLS = new Set(['Read'])
const UNACKED_TOOL_CMD_CAP = 64

// CC§2
export function scratchpadDirFor(jsonlPath: string | null): string | null {
  if (!jsonlPath || !jsonlPath.endsWith('.jsonl')) return null
  const sessionId = path.basename(jsonlPath, '.jsonl')
  const slug = path.basename(path.dirname(jsonlPath))
  if (!sessionId || !slug) return null
  const base =
    process.env.KOLOFT_SCRATCHPAD_BASE || path.join(TMP_ROOT, `claude-${process.getuid?.() ?? 0}`)
  return path.join(base, slug, sessionId, 'scratchpad')
}

export function tasksDirOf(scratchpadDir: string): string {
  return path.join(path.dirname(scratchpadDir), 'tasks')
}

interface SubagentFile {
  offset: number
  tail: Buffer
  activeMs: number
  teammate?: boolean
}

interface FileAcc {
  access: FileAccess
  added: number
  removed: number
}

function toolFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const i = input as Record<string, unknown>
  const p = i.file_path ?? i.notebook_path ?? i.path
  return typeof p === 'string' && p.length ? p : null
}

function countLines(s: unknown): number {
  if (typeof s !== 'string' || s.length === 0) return 0
  let n = 1
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  if (s.charCodeAt(s.length - 1) === 10) n--
  return n
}

function editDelta(tool: string, input: unknown): { added: number; removed: number } {
  if (!input || typeof input !== 'object') return { added: 0, removed: 0 }
  const i = input as Record<string, unknown>
  if (tool === 'Edit') return { added: countLines(i.new_string), removed: countLines(i.old_string) }
  if (tool === 'MultiEdit') {
    let added = 0
    let removed = 0
    if (Array.isArray(i.edits)) {
      for (const e of i.edits as Array<Record<string, unknown>>) {
        added += countLines(e?.new_string)
        removed += countLines(e?.old_string)
      }
    }
    return { added, removed }
  }
  if (tool === 'Write') return { added: countLines(i.content), removed: 0 }
  return { added: 0, removed: 0 }
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
    candidate = text
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

export interface RemoteTab {
  host: string
  projectsRoot: string
  tmuxName: string
}

interface Tracked {
  info: SessionInfo
  readOffset: number
  tailBuf: Buffer
  title: string | null
  firstPrompt: string | null
  commandArgsTitle: string | null
  commandTitle: string | null
  candidates: Map<string, FileAcc>
  fileCache: Map<string, string>
  lastTouchedAbs: string | null
  lastWrittenAbs: string | null
  parsePromise?: Promise<void>
  parseAgain: boolean
  statusSeq: number
  caughtUp: boolean
  statusSince: number
  idleTimer?: ReturnType<typeof setTimeout>
  autoCloseTimer?: ReturnType<typeof setTimeout>
  jsonlListener?: () => void
  titleListener?: () => void
  usageSeen: Set<string>
  usageAny: boolean
  usageInTok: number
  usageOutTok: number
  usageCacheWriteTok: number
  usageCacheReadTok: number
  usageCostUsd: number
  usageUnknownModel: boolean
  usageModel?: string
  usageCcVersion?: string
  usageCtxTokens?: number
  usageToday: { dayKey: string; cost: number }
  subagentFiles: Map<string, SubagentFile>
  subagentScanMs: number
  bgTasks: Set<string>
  lastBgActivityTs: number
  lastMainActivityTs: number
  bindMs: number
  resetMs: number
  stopPending: boolean
  reported: ReportedTask[] | null
  reportedAt: number
  taskCmds: Map<string, string>
  monitorIds: Set<string>
  toolCmds: Map<string, string>
  procs: TaskProcs | null
  shellCpu: Map<string, { cpuMs: number; at: number; quiet: boolean }>
  procsAt: number
  procsPromise?: Promise<void>
  teammateActiveMs: number
  lastInterruptTs: number
  rootPinAwaitingCatchup: boolean
  inode?: number
  swept?: boolean
  relocatedCwd?: string
  landTimer?: ReturnType<typeof setTimeout>
  remote?: RemoteTab
  subagentTimer?: ReturnType<typeof setInterval>
}

export async function readAppendedLines(
  file: string,
  size: number,
  cur: { offset: number; tail: Buffer }
): Promise<string[] | null> {
  let newBytes: Buffer
  let fh: fs.promises.FileHandle | undefined
  try {
    fh = await fs.promises.open(file, 'r')
    const len = size - cur.offset
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
    cur.tail = Buffer.from(buf)
    return []
  }
  cur.tail = Buffer.from(buf.subarray(lastNl + 1))
  return buf.toString('utf8', 0, lastNl).split('\n')
}

export class SessionTracker extends EventEmitter {
  private tracked = new Map<string, Tracked>()
  private pendingPicked = new Map<string, string>()
  private emitTimer?: ReturnType<typeof setTimeout>
  private lastEmitMs = 0
  pidOf?: (tabId: string) => number | undefined
  inspect: typeof inspectTaskProcs = inspectTaskProcs
  activeTabId?: () => string | null
  heldTabs?: () => ReadonlySet<string>
  needsUser?: (tabId: string) => boolean

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
      readOffset: 0,
      tailBuf: Buffer.alloc(0),
      title: null,
      firstPrompt: null,
      commandArgsTitle: null,
      commandTitle: null,
      candidates: new Map(),
      fileCache: new Map(),
      lastTouchedAbs: null,
      lastWrittenAbs: null,
      parseAgain: false,
      statusSeq: 0,
      caughtUp: false,
      statusSince: 0,
      usageSeen: new Set(),
      usageAny: false,
      usageInTok: 0,
      usageOutTok: 0,
      usageCacheWriteTok: 0,
      usageCacheReadTok: 0,
      usageCostUsd: 0,
      usageUnknownModel: false,
      usageToday: { dayKey: '', cost: 0 },
      subagentFiles: new Map(),
      subagentScanMs: 0,
      bgTasks: new Set(),
      lastBgActivityTs: 0,
      lastMainActivityTs: 0,
      bindMs: Date.now(),
      resetMs: Date.now(),
      stopPending: false,
      reported: null,
      reportedAt: 0,
      taskCmds: new Map(),
      monitorIds: new Set(),
      toolCmds: new Map(),
      procs: null,
      shellCpu: new Map(),
      procsAt: 0,
      teammateActiveMs: 0,
      lastInterruptTs: 0,
      rootPinAwaitingCatchup: false,
      remote
    }
    this.tracked.set(tabId, t)
    this.emitUpdate()
    // ADR-0025
    if (!remote) this.resolveWorktree(t)
  }

  setAlive(tabId: string, alive: boolean): void {
    const t = this.tracked.get(tabId)
    if (t) {
      t.info.alive = alive
      t.info.updatedAt = Date.now()
      this.emitUpdate()
    }
  }

  setStatus(tabId: string, status: SessionStatus): void {
    const t = this.tracked.get(tabId)
    if (!t) return
    t.statusSeq++
    this.applyStatus(t, status)
  }

  private applyStatus(t: Tracked, status: SessionStatus): void {
    const tabId = t.info.tabId
    if (this.tracked.get(tabId) !== t) return
    t.stopPending = false
    if (t.idleTimer) {
      clearTimeout(t.idleTimer)
      t.idleTimer = undefined
    }
    if (t.autoCloseTimer) {
      clearTimeout(t.autoCloseTimer)
      t.autoCloseTimer = undefined
    }
    if (t.info.status !== status) {
      const prev = t.info.status
      t.info.status = status
      t.info.updatedAt = Date.now()
      t.statusSince = t.info.updatedAt
      this.emit('status', { tabId, prev, next: status })
      this.emitUpdate()
    }
    if (status === 'waiting') {
      t.idleTimer = setTimeout(() => {
        t.idleTimer = undefined
        if (t.info.status === 'waiting') {
          t.info.status = 'idle'
          t.info.updatedAt = Date.now()
          this.emit('status', { tabId, prev: 'waiting', next: 'idle' })
          this.emitUpdate()
          this.armAutoClose(t)
        }
      }, IDLE_MS)
    }
  }

  private armAutoClose(t: Tracked): void {
    if (t.autoCloseTimer) clearTimeout(t.autoCloseTimer)
    t.autoCloseTimer = t.remote
      ? undefined
      : setTimeout(() => void this.tryAutoClose(t), AUTO_CLOSE_MS)
  }

  private async tryAutoClose(t: Tracked): Promise<void> {
    t.autoCloseTimer = undefined
    const tabId = t.info.tabId
    const held =
      tabId === this.activeTabId?.() ||
      !!t.info.parked?.length ||
      !!this.heldTabs?.().has(tabId) ||
      !!this.needsUser?.(tabId)
    const root = this.pidOf?.(tabId)
    const scratch = t.info.scratchpadDir
    if (held || !root || !scratch) {
      this.armAutoClose(t)
      return
    }
    const procs = await this.inspect(root, tasksDirOf(scratch))
    if (this.tracked.get(tabId) !== t || t.info.status !== 'idle' || t.autoCloseTimer) return
    if (!procs || procs.shells.size > 0) {
      this.armAutoClose(t)
      return
    }
    this.emit('auto-close', { tabId })
  }

  noteActivity(tabId: string): void {
    const t = this.tracked.get(tabId)
    if (!t || t.info.status !== 'idle') return
    this.armAutoClose(t)
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
    const busy = t.reported ? this.judgeReported(t) : this.bgBusy(t)
    if (busy) {
      t.stopPending = true
    } else {
      t.bgTasks.clear()
      this.applyStatus(t, 'waiting')
    }
  }

  private judgeReported(t: Tracked): boolean {
    const now = Date.now()
    const list = t.reported ?? []
    const procs = t.procs
    const parked: ParkedItem[] = []
    let observed = false
    let trusted = false
    const reportedIds = new Set(list.map((x) => x.id))
    const toolCallInFlight = !!procs && [...procs.shells.keys()].some((id) => !reportedIds.has(id))
    const agentsFresh = now - Math.max(t.lastBgActivityTs, t.reportedAt) < BG_SILENCE_MAX_MS
    const teammatesFresh = now - t.teammateActiveMs < TEAMMATE_QUIET_MS
    let idleTeammates = 0
    for (const task of list) {
      if (task.type === 'shell') {
        const label = t.taskCmds.get(task.id) ?? task.id
        if (t.monitorIds.has(task.id)) {
          parked.push({ kind: 'monitor', label })
        } else if (!procs) {
          trusted = true
        } else {
          const sh = procs.shells.get(task.id)
          if (!sh) {
            if ((task.since ?? 0) > t.procsAt) observed = true
            continue
          }
          if (sh.listening && t.shellCpu.get(task.id)?.quiet) {
            parked.push({ kind: 'server', label, ageMs: Math.floor(sh.ageMs / 60_000) * 60_000 })
          } else observed = true
        }
      } else if (AGENT_TYPES.has(task.type)) {
        if (agentsFresh || toolCallInFlight) observed = true
      } else if (task.type === 'teammate') {
        if (teammatesFresh || toolCallInFlight) observed = true
        else idleTeammates++
      }
    }
    if (idleTeammates) parked.push({ kind: 'teammate', label: `${idleTeammates} idle` })
    this.setParked(t, parked)
    if (observed) return true
    if (!trusted) return false
    return this.quietMs(t) < BG_SILENCE_MAX_MS
  }

  private setParked(t: Tracked, items: ParkedItem[]): void {
    const next = items.length ? items : undefined
    if (JSON.stringify(next) === JSON.stringify(t.info.parked)) return
    t.info.parked = next
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
    const scratch = t.info.scratchpadDir
    if (!root || !scratch) return
    t.procsPromise = (async () => {
      try {
        const procs = await this.inspect(root, tasksDirOf(scratch))
        if (this.tracked.get(t.info.tabId) !== t) return
        t.procs = procs
        t.procsAt = Date.now()
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
    return Date.now() - Math.max(t.lastMainActivityTs, t.lastBgActivityTs, t.statusSince)
  }

  private bgBusy(t: Tracked): boolean {
    const quietMs = Date.now() - t.lastBgActivityTs
    if (t.bgTasks.size > 0) return quietMs < BG_SILENCE_MAX_MS
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
    if (ccVersion && t.info.ccVersion !== ccVersion) {
      t.info.ccVersion = ccVersion
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
      this.setParked(t, [])
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

  untrack(tabId: string): void {
    const t = this.tracked.get(tabId)
    if (t) this.cleanup(t)
    this.tracked.delete(tabId)
    this.emitUpdate()
  }

  remoteOf(tabId: string): RemoteTab | undefined {
    return this.tracked.get(tabId)?.remote
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
    let buckets: string[]
    try {
      buckets = fs.readdirSync(PROJECTS_ROOT)
    } catch {
      return false
    }
    return buckets.some((d) => fs.existsSync(path.join(PROJECTS_ROOT, d, sessionId + '.jsonl')))
  }

  aliveTabFor(sessionId: string): string | null {
    if (!sessionId) return null
    for (const t of this.tracked.values()) {
      if (t.info.alive && t.info.sessionId === sessionId) return t.info.tabId
    }
    return null
  }

  // PLATFORM§28
  private cleanup(t: Tracked): void {
    if (t.idleTimer) clearTimeout(t.idleTimer)
    if (t.autoCloseTimer) clearTimeout(t.autoCloseTimer)
    if (t.subagentTimer) clearInterval(t.subagentTimer)
    if (t.landTimer) clearTimeout(t.landTimer)
    if (t.info.jsonlPath) {
      if (t.jsonlListener) fs.unwatchFile(t.info.jsonlPath, t.jsonlListener)
      if (t.titleListener) fs.unwatchFile(this.sidecarOf(t.info.jsonlPath), t.titleListener)
    }
  }

  // CC§2 PLATFORM§1
  private resolveWorktree(t: Tracked): void {
    if (t.remote) return
    this.applyWorktree(
      t,
      t.info.treeRoot ? projectInfoFor(t.info.treeRoot).worktreeName : undefined
    )
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
    t.title = null
    t.firstPrompt = null
    t.commandArgsTitle = null
    t.commandTitle = null
    t.candidates = new Map()
    t.fileCache = new Map()
    t.lastTouchedAbs = null
    t.lastWrittenAbs = null
    t.relocatedCwd = undefined
    t.info.lastTouched = undefined
    t.info.lastWritten = undefined
    t.caughtUp = false
    t.usageSeen = new Set()
    t.usageAny = false
    t.usageInTok = 0
    t.usageOutTok = 0
    t.usageCacheWriteTok = 0
    t.usageCacheReadTok = 0
    t.usageCostUsd = 0
    t.usageUnknownModel = false
    t.usageModel = undefined
    t.usageCtxTokens = undefined
    t.usageCcVersion = undefined
    t.usageToday = { dayKey: '', cost: 0 }
    t.subagentFiles = new Map()
    t.subagentScanMs = 0
    t.info.usage = undefined
    t.bgTasks = new Set()
    t.monitorIds = new Set()
    t.taskCmds = new Map()
    t.toolCmds = new Map()
    t.teammateActiveMs = 0
    t.lastBgActivityTs = 0
    t.lastMainActivityTs = 0
    t.lastInterruptTs = 0
    if (!keepBindMs) t.bindMs = Date.now()
    t.resetMs = Date.now()
  }

  // PLATFORM§28
  private watchTranscript(t: Tracked, file: string): void {
    if (t.info.jsonlPath) {
      if (t.jsonlListener) fs.unwatchFile(t.info.jsonlPath, t.jsonlListener)
      if (t.titleListener) fs.unwatchFile(this.sidecarOf(t.info.jsonlPath), t.titleListener)
    }
    t.info.jsonlPath = file
    t.jsonlListener ??= (): void => void this.parse(t)
    t.titleListener ??= (): void => this.recompute(t)
    fs.watchFile(file, { interval: 500 }, t.jsonlListener)
    fs.watchFile(this.sidecarOf(file), { interval: 500 }, t.titleListener)
  }

  private bind(t: Tracked, file: string): void {
    this.watchTranscript(t, file)
    t.info.sessionId = path.basename(file, '.jsonl')
    if (t.landTimer) clearTimeout(t.landTimer)
    t.landTimer = undefined
    t.info.relocated = undefined
    t.info.scratchpadDir = scratchpadDirFor(file) ?? undefined
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
    t.subagentTimer = setInterval(() => void this.parse(t), SUBAGENT_SCAN_MS)
    void this.parse(t)
  }

  private resolvePath(raw: string, cwd: string): string | null {
    let p = raw
    if (p === '~' || p === '~/') return null
    if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2))
    else if (!path.isAbsolute(p)) p = path.resolve(cwd, p)
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
    t.info.relocated = true
    this.setTreeRoot(t, dir)
    this.emit('relocated', { tabId: t.info.tabId, dir })
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
    if (t.stopPending || (s !== 'working' && s !== 'approval')) await this.refreshProcs(t)
    if (mainChanged || subChanged) this.recompute(t)
    this.reconcileBackground(t)
  }

  private reconcileBackground(t: Tracked): void {
    const s = t.info.status
    if (
      (s === 'waiting' || s === 'idle') &&
      t.caughtUp &&
      t.lastBgActivityTs > t.statusSince + RESUME_AFTER_STOP_MS
    ) {
      this.applyStatus(t, 'working')
      t.stopPending = true
      t.bgTasks.add(BG_PROMOTED)
      return
    }
    if (!t.stopPending) {
      if (t.reported && s !== 'working' && s !== 'approval') this.judgeReported(t)
      return
    }
    const busy = t.reported ? this.judgeReported(t) : this.bgBusy(t)
    if (!busy) {
      if (Date.now() - t.lastMainActivityTs < STOP_HOLD_MS) return
      t.bgTasks.clear()
      this.applyStatus(t, 'waiting')
    }
  }

  private async ingestMainAppend(t: Tracked, p: string, st: fs.Stats): Promise<boolean> {
    const cur = { offset: t.readOffset, tail: t.tailBuf }
    const lines = await readAppendedLines(p, st.size, cur)
    if (lines !== null) {
      t.readOffset = cur.offset
      t.tailBuf = cur.tail
    }
    if (!lines || !lines.length) return false

    let sawUserPrompt = false
    let sawAssistant = false
    let sawInterrupt = false
    for (const line of lines) {
      if (!line) continue
      const activity = this.ingestLine(t, line)
      if (activity === 'user') {
        sawUserPrompt = true
        sawInterrupt = false
      } else if (activity === 'assistant') sawAssistant = true
      else if (activity === 'interrupt') sawInterrupt = true
    }
    if (t.rootPinAwaitingCatchup) this.setTreeRoot(t, t.info.cwd)
    if (sawInterrupt) await this.interruptTurn(t)
    else if (t.caughtUp) this.resumeWorkingIfStale(t, sawUserPrompt, sawAssistant)
    if (!t.caughtUp) t.caughtUp = true
    return true
  }

  private async interruptTurn(t: Tracked): Promise<void> {
    const s = t.info.status
    if (s !== 'working' && s !== 'approval') return
    if (t.statusSince > t.lastInterruptTs) return
    if (t.reported) {
      await this.refreshProcs(t, true)
      if (this.tracked.get(t.info.tabId) !== t || t.statusSince > t.lastInterruptTs) return
    }
    const busy = t.reported ? this.judgeReported(t) : this.bgBusy(t)
    if (busy) {
      t.stopPending = true
      return
    }
    t.bgTasks.clear()
    this.applyStatus(t, 'waiting')
  }

  private async tailSubagents(t: Tracked): Promise<boolean> {
    const p = t.info.jsonlPath
    if (!p || !t.info.sessionId) return false
    const now = Date.now()
    const rescan = now - t.subagentScanMs >= SUBAGENT_SCAN_MS
    if (rescan) {
      t.subagentScanMs = now
      const dir = path.join(path.dirname(p), t.info.sessionId, 'subagents')
      for (const f of listSubagentJsonls(dir)) {
        let sst = t.subagentFiles.get(f)
        if (!sst) {
          sst = { offset: 0, tail: Buffer.alloc(0), activeMs: now }
          t.subagentFiles.set(f, sst)
        }
        if (sst.teammate === undefined) sst.teammate = readTeammateFlag(f)
      }
    }
    const due = [...t.subagentFiles].filter(
      ([, sst]) => rescan || now - sst.activeMs < SUBAGENT_SCAN_MS
    )
    const folded = await Promise.all(due.map(([file, sst]) => this.tailSubagentFile(t, file, sst)))
    return folded.some(Boolean)
  }

  private async tailSubagentFile(t: Tracked, file: string, sst: SubagentFile): Promise<boolean> {
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
    if (sst.teammate === undefined) sst.teammate = readTeammateFlag(file)
    if (sst.teammate) t.teammateActiveMs = sst.activeMs
    const lines = await readAppendedLines(file, st.size, sst)
    if (!lines) return false
    let folded = false
    for (const line of lines) {
      if (!line) continue
      let obj: any
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      const ts = Math.min(Date.parse(obj?.timestamp), Date.now())
      if (isFinite(ts) && ts > t.lastBgActivityTs) t.lastBgActivityTs = ts
      if (obj && obj.type === 'assistant' && obj.message && obj.message.usage) {
        this.accumulateUsage(t, obj, false)
        folded = true
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
    } else if (s === 'waiting' && Date.now() - t.statusSince > RESUME_AFTER_STOP_MS) {
      // CC§2
      this.applyStatus(t, 'working')
    }
  }

  private ingestSpawnAck(t: Tracked, obj: any): void {
    const tur = obj.toolUseResult
    if (!isBackgroundSpawnAck(tur) || !Array.isArray(obj.message?.content)) return
    const ts = Date.parse(obj.timestamp)
    const live = t.caughtUp || (isFinite(ts) && ts >= t.bindMs && ts <= Date.now())
    if (!live) return
    const toolUseIds: string[] = []
    for (const b of obj.message.content) {
      if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        t.bgTasks.add(b.tool_use_id)
        toolUseIds.push(b.tool_use_id)
      }
    }
    const r = tur as Record<string, unknown>
    let task: ReportedTask | null = null
    if (typeof r.backgroundTaskId === 'string') task = { id: r.backgroundTaskId, type: 'shell' }
    else if (typeof r.taskId === 'string' && typeof r.timeoutMs === 'number') {
      task = { id: r.taskId, type: 'shell' }
      t.monitorIds.add(r.taskId)
    } else if (r.status === 'teammate_spawned') {
      // CC§8
      if (toolUseIds[0]) task = { id: toolUseIds[0], type: 'teammate' }
      t.teammateActiveMs = Date.now()
    } else if (typeof r.agentId === 'string') {
      task = { id: r.agentId, type: r.status === 'remote_launched' ? 'cloud-session' : 'subagent' }
    }
    if (task) {
      const cmd = toolUseIds.map((id) => t.toolCmds.get(id)).find((c) => c)
      if (cmd) t.taskCmds.set(task.id, cmd)
      if (t.reported && !t.reported.some((x) => x.id === task.id)) {
        t.reported.push({ ...task, since: Date.now() })
      }
    }
    for (const id of toolUseIds) t.toolCmds.delete(id)
    const at = Math.min(isFinite(ts) ? ts : Date.now(), Date.now())
    if (at > t.lastBgActivityTs) t.lastBgActivityTs = at
  }

  // CC§8
  private ingestTaskNotification(t: Tracked, obj: any): void {
    const text = taskNotificationText(obj)
    if (text === null) return
    const st = text
      .match(/<status>([^<]*)<\/status>/)?.[1]
      ?.trim()
      .toLowerCase()
    if (!st || !TERMINAL_TASK_STATUSES.has(st)) return
    for (const m of text.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)) {
      t.bgTasks.delete(m[1])
    }
    const gone = new Set([...text.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map((m) => m[1]))
    if (t.reported && gone.size) t.reported = t.reported.filter((x) => !gone.has(x.id))
    for (const id of gone) {
      t.monitorIds.delete(id)
      t.taskCmds.delete(id)
    }
    t.bgTasks.delete(BG_PROMOTED)
  }

  private ingestLine(t: Tracked, line: string): 'user' | 'assistant' | 'interrupt' | null {
    let obj: any = null
    try {
      obj = JSON.parse(line)
    } catch {
      return null
    }
    let activity: 'user' | 'assistant' | 'interrupt' | null = null
    if (obj) {
      if (typeof obj.cwd === 'string' && obj.cwd && obj.cwd !== t.info.cwd) {
        t.info.cwd = obj.cwd
        if (!fs.existsSync(t.info.treeRoot)) this.setTreeRoot(t, obj.cwd)
      }
      if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') t.title = obj.aiTitle
      // CC§2
      if (obj.type === 'relocated' && typeof obj.relocatedCwd === 'string' && obj.relocatedCwd) {
        t.relocatedCwd = obj.relocatedCwd
      }
      // CC§2
      const recTs = Math.min(Date.parse(obj.timestamp), Date.now())
      const mainThread = obj.isSidechain !== true
      if (isFinite(recTs)) {
        if (!mainThread) {
          if (recTs > t.lastBgActivityTs) t.lastBgActivityTs = recTs
        } else if (recTs > t.lastMainActivityTs) {
          t.lastMainActivityTs = recTs
        }
      }
      if (obj.type === 'user') this.ingestSpawnAck(t, obj)
      this.ingestTaskNotification(t, obj)
      if (obj.type === 'user' && !obj.isMeta) {
        const c = obj.message?.content
        let raw: string | null = null
        let hasImage = false
        if (typeof c === 'string') raw = c
        else if (Array.isArray(c)) {
          const text = c.find((x: any) => x?.type === 'text')
          if (text?.text) raw = text.text
          hasImage = c.some((x: any) => x?.type === 'image')
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
        if (cls?.title && !t.firstPrompt) t.firstPrompt = cls.title
        if (cls?.commandArgs && !t.commandArgsTitle) t.commandArgsTitle = cls.commandArgs
        if (cls?.commandName && !t.commandTitle) t.commandTitle = cls.commandName
        if ((cls?.genuine || hasImage) && mainThread) {
          activity = 'user'
          if (t.caughtUp || (isFinite(recTs) && recTs >= t.resetMs)) {
            t.stopPending = false
          }
        }
      }
      if (obj.type === 'assistant' && obj.message && obj.message.usage) {
        this.accumulateUsage(t, obj, mainThread)
      }
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        if (mainThread) activity = 'assistant'
        const liveNow = t.caughtUp || (isFinite(recTs) && recTs >= t.bindMs)
        for (const b of obj.message.content) {
          if (!b || b.type !== 'tool_use') continue
          if ((b.name === 'Bash' || b.name === 'Monitor') && typeof b.input?.command === 'string') {
            if (t.toolCmds.size >= UNACKED_TOOL_CMD_CAP)
              t.toolCmds.delete(t.toolCmds.keys().next().value as string)
            t.toolCmds.set(b.id, b.input.command.replace(/\s+/g, ' ').trim().slice(0, 120))
            if (b.name === 'Bash' && liveNow && BASH_WRITES.test(b.input.command)) {
              t.info.liveWrites = (t.info.liveWrites ?? 0) + 1
            }
          }
          // CC§2
          const raw = toolFilePath(b.input)
          const fp = raw ? this.resolvePath(raw, t.info.cwd) : null
          if (!fp) continue
          if (WRITE_TOOLS.has(b.name)) {
            const { added, removed } = editDelta(b.name, b.input)
            const cur = t.candidates.get(fp)
            if (cur && cur.access === 'wrote') {
              cur.added += added
              cur.removed += removed
            } else {
              t.candidates.set(fp, { access: 'wrote', added, removed })
            }
            t.lastTouchedAbs = fp
            t.lastWrittenAbs = fp
            if (liveNow) t.info.liveWrites = (t.info.liveWrites ?? 0) + 1
          } else if (READ_TOOLS.has(b.name)) {
            if (!t.candidates.has(fp))
              t.candidates.set(fp, { access: 'read', added: 0, removed: 0 })
            t.lastTouchedAbs = fp
          }
        }
      }
    }
    return activity
  }

  // CC§2
  private accumulateUsage(t: Tracked, obj: any, updateContext = true): void {
    const msg = obj.message
    const model = typeof msg.model === 'string' ? msg.model : ''
    if (model === '<synthetic>') return
    const id = typeof msg.id === 'string' ? msg.id : ''
    const reqId = typeof obj.requestId === 'string' ? obj.requestId : ''
    if (id || reqId) {
      const key = id + ' ' + reqId
      if (t.usageSeen.has(key)) return
      t.usageSeen.add(key)
    }
    t.usageAny = true

    const u = msg.usage || {}
    const inTok = num(u.input_tokens)
    const outTok = num(u.output_tokens)
    const cacheWrite = num(u.cache_creation_input_tokens)
    const cacheRead = num(u.cache_read_input_tokens)
    t.usageInTok += inTok
    t.usageOutTok += outTok
    t.usageCacheWriteTok += cacheWrite
    t.usageCacheReadTok += cacheRead

    const pricing = model ? resolvePricing(model) : undefined
    if (!pricing) {
      t.usageUnknownModel = true
    } else {
      const cost =
        (inTok * pricing.inPerM +
          outTok * pricing.outPerM +
          cacheWrite * pricing.cacheWritePerM +
          cacheRead * pricing.cacheReadPerM) /
        1_000_000
      t.usageCostUsd += cost
      const recDay = localDayKey(obj.timestamp)
      if (recDay) {
        if (recDay > t.usageToday.dayKey) {
          t.usageToday.dayKey = recDay
          t.usageToday.cost = 0
        }
        if (recDay === t.usageToday.dayKey) t.usageToday.cost += cost
      }
    }
    if (updateContext) {
      if (model) t.usageModel = model
      t.usageCtxTokens = inTok + cacheRead + cacheWrite
      if (typeof obj.version === 'string' && obj.version) t.usageCcVersion = obj.version
    }
  }

  private buildUsage(t: Tracked): SessionUsage | undefined {
    if (!t.usageAny) return undefined
    const pricing = t.usageModel ? resolvePricing(t.usageModel) : undefined
    const ctxPct =
      pricing && t.usageCtxTokens != null ? t.usageCtxTokens / pricing.windowTokens : undefined
    const hasToday = !t.usageUnknownModel && t.usageToday.cost > 0 && !!t.usageToday.dayKey
    return {
      inTok: t.usageInTok,
      outTok: t.usageOutTok,
      cacheWriteTok: t.usageCacheWriteTok,
      cacheReadTok: t.usageCacheReadTok,
      costUsd: t.usageUnknownModel ? undefined : t.usageCostUsd,
      todayCostUsd: hasToday ? t.usageToday.cost : undefined,
      todayDayKey: hasToday ? t.usageToday.dayKey : undefined,
      model: t.usageModel,
      ccVersion: t.usageCcVersion,
      ctxTokens: t.usageCtxTokens,
      ctxPct
    }
  }

  private sidecarOf(jsonlPath: string): string {
    return jsonlPath.replace(/\.jsonl$/, '.title')
  }

  private titleFromSidecar(jsonlPath: string): string | null {
    try {
      const text = fs.readFileSync(this.sidecarOf(jsonlPath), 'utf8').trim()
      return text || null
    } catch {
      return null
    }
  }

  private recompute(t: Tracked): void {
    const byCanon = new Map<string, PreviewItem>()
    for (const [abs, acc] of t.candidates) {
      const canon = this.canonFile(t, abs)
      if (!canon) continue
      const ex = byCanon.get(canon)
      if (ex) {
        ex.added = (ex.added ?? 0) + acc.added
        ex.removed = (ex.removed ?? 0) + acc.removed
        if (acc.access === 'wrote') ex.access = 'wrote'
      } else {
        const item: PreviewItem = { src: canon, label: basename(canon), access: acc.access }
        if (acc.added) item.added = acc.added
        if (acc.removed) item.removed = acc.removed
        byCanon.set(canon, item)
      }
    }
    const all = [...byCanon.values()]
    const files =
      all.length <= MAX_FILES
        ? all
        : [
            ...all.filter((f) => f.access === 'wrote'),
            ...all.filter((f) => f.access !== 'wrote')
          ].slice(0, MAX_FILES)

    const sidecarTitle = t.info.jsonlPath ? this.titleFromSidecar(t.info.jsonlPath) : null
    t.info.title =
      sidecarTitle ||
      t.title ||
      (t.firstPrompt ? t.firstPrompt.slice(0, 60) : null) ||
      (t.commandArgsTitle ? t.commandArgsTitle.slice(0, 60) : null) ||
      t.commandTitle ||
      PLACEHOLDER_SESSION_TITLE
    t.info.files = files
    t.info.lastTouched = t.lastTouchedAbs
      ? (this.canonFile(t, t.lastTouchedAbs) ?? undefined)
      : undefined
    t.info.lastWritten = t.lastWrittenAbs
      ? (this.canonFile(t, t.lastWrittenAbs) ?? undefined)
      : undefined
    t.info.usage = this.buildUsage(t)
    t.info.updatedAt = Date.now()
    this.emitUpdate()
  }

  private canonFile(t: Tracked, abs: string): string | null {
    const cached = t.fileCache.get(abs)
    if (cached !== undefined) return cached
    try {
      if (fs.statSync(abs).isFile()) {
        const real = fs.realpathSync(abs)
        t.fileCache.set(abs, real)
        return real
      }
    } catch {}
    return null
  }
}
