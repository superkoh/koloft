import type { BackgroundItem } from '@shared/types'
import type { SessionEvent } from '@shared/sessionEvent'
import type { Turn } from './sessionRuntime'
import path from 'path'
import { schemeOf } from '@shared/browserRoute'
import { costUsdOf, resolvePricing } from '@shared/pricing'
import { capTouched, noteRead, noteWrite, touchedItem, type FileAcc } from './touchedFiles'

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export interface CodexThread {
  id: string
  cwd: string
  name?: string | null
  preview?: string
  createdAt?: number
  updatedAt?: number
  path?: string | null
  cliVersion?: string
  ephemeral?: boolean
  parentThreadId?: string | null
  threadSource?: string
  canAcceptDirectInput?: boolean
  source?: unknown
  model?: string | null
  status?: { type: string; activeFlags?: string[] }
}

export function userThread(value: unknown): CodexThread | null {
  const t = record(value)
  if (
    typeof t.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t.id) ||
    typeof t.cwd !== 'string' ||
    !path.isAbsolute(t.cwd)
  )
    return null
  if (
    t.ephemeral === true ||
    t.threadSource === 'system' ||
    t.parentThreadId ||
    t.canAcceptDirectInput === false ||
    Object.hasOwn(record(t.source), 'subAgent')
  )
    return null
  for (const key of ['name', 'preview', 'path', 'cliVersion', 'model']) {
    if (t[key] !== undefined && t[key] !== null && typeof t[key] !== 'string') return null
  }
  return t as unknown as CodexThread
}

export type CodexEvent =
  | Exclude<SessionEvent, { type: 'bound' }>
  | { type: 'bound'; thread: CodexThread; change: 'replace' | 'switch' }

const TURN_EVENT: Record<Turn, CodexEvent> = {
  working: { type: 'prompt' },
  approval: { type: 'notify', need: 'approval' },
  input: { type: 'notify', need: 'input' },
  ended: { type: 'stop' }
}

function patchDelta(kind: unknown, diff: string): { added: number; removed: number } {
  const lines = diff.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  if (kind === 'add') return { added: lines.length, removed: 0 }
  return {
    added: lines.filter((l) => l.startsWith('+')).length,
    removed: lines.filter((l) => l.startsWith('-')).length
  }
}

const OPEN_ONE_TARGET = /^open\s+(?:'([^']+)'|"([^"]+)"|([^\s'"-]\S*))$/
const OPEN_RAN = ['completed', 'failed']

function openTarget(command: string, cwd: unknown): string | null {
  const m = OPEN_ONE_TARGET.exec(command.trim())
  const arg = m && (m[1] ?? m[2] ?? m[3])
  if (!arg) return null
  if (schemeOf(arg)) return arg
  return typeof cwd === 'string' && path.isAbsolute(cwd) ? path.resolve(cwd, arg) : null
}

interface Activity extends BackgroundItem {
  root: string
  owner: string
  visible: boolean
}

export class CodexObservation {
  private requests = new Map<
    string | number,
    { method: string; generation: number; threadId?: string; cwd?: string }
  >()
  private approvals = new Map<string | number, string>()
  private approvalThreads = new Map<string | number, string>()
  private generation = 0
  private threadId?: string
  private liveTurns = new Set<string>()
  private model?: string
  private mainTurn: Turn = 'ended'
  private publishedTurn?: Turn
  private waitingForInput = false
  private roots = new Set<string>()
  private childRoots = new Map<string, string>()
  private childTurns = new Map<string, string>()
  private activities = new Map<string, Activity>()
  private touched = new Map<string, FileAcc>()
  private lastTouched?: string
  private lastWritten?: string
  private liveWrites = 0
  unsubscribed = false

  constructor(private emit: (event: CodexEvent) => void) {}

  receive(direction: 'client' | 'server', value: unknown): void {
    const f = record(value),
      p = record(f.params)
    const id = typeof f.id === 'string' || typeof f.id === 'number' ? f.id : undefined
    const method = typeof f.method === 'string' ? f.method : undefined
    if (direction === 'client') {
      if (
        id !== undefined &&
        method &&
        ['thread/start', 'thread/resume', 'thread/fork'].includes(method)
      ) {
        if (p.ephemeral === true || p.threadSource === 'system') return
        this.unsubscribed = false
        this.requests.set(id, {
          method,
          generation: ++this.generation,
          cwd: typeof p.cwd === 'string' && path.isAbsolute(p.cwd) ? p.cwd : undefined
        })
      }
      if (id !== undefined && method === 'thread/unsubscribe' && p.threadId === this.threadId) {
        this.unsubscribed = false
        this.requests.set(id, { method, generation: this.generation, threadId: this.threadId })
      }
      if (method === 'turn/start' && p.threadId === this.threadId) this.unsubscribed = false
      if (id !== undefined && !method && this.approvals.delete(id)) {
        this.approvalThreads.delete(id)
        if (!this.approvals.size) {
          this.waitingForInput = false
          this.mainTurn = this.liveTurns.size ? 'working' : 'ended'
        }
        this.publishActivity()
      }
      return
    }
    if (id !== undefined && !method) {
      const req = this.requests.get(id)
      if (!req) return
      this.requests.delete(id)
      if (req.generation !== this.generation) return
      if (req.method === 'thread/unsubscribe') {
        this.unsubscribed =
          !f.error && req.threadId === this.threadId && record(f.result).status === 'unsubscribed'
        return
      }
      if (f.error) {
        this.degraded(String(record(f.error).message ?? 'Codex could not open the session.'))
        return
      }
      const result = record(f.result)
      const thread = userThread(result.thread)
      if (!thread) {
        this.degraded('Codex returned an unsupported session response.')
        return
      }
      this.threadId = thread.id
      this.roots.add(thread.id)
      this.unsubscribed = false
      this.liveTurns.clear()
      this.approvals.clear()
      this.approvalThreads.clear()
      this.waitingForInput = false
      this.mainTurn = 'ended'
      this.publishedTurn = undefined
      this.touched.clear()
      this.lastTouched = this.lastWritten = undefined
      this.liveWrites = 0
      this.model = typeof result.model === 'string' ? result.model : (thread.model ?? undefined)
      const cwd =
        typeof result.cwd === 'string' && path.isAbsolute(result.cwd)
          ? result.cwd
          : (req.cwd ?? thread.cwd)
      this.emit({
        type: 'bound',
        thread: { ...thread, cwd, model: this.model },
        change: req.method === 'thread/start' ? 'replace' : 'switch'
      })
      this.status(thread.status)
      return
    }
    this.observeActivity(method, p)
    const ownedChild =
      typeof p.threadId === 'string' && this.childRoots.get(p.threadId) === this.threadId
    if (!this.threadId || (p.threadId !== this.threadId && !ownedChild)) return
    if (method === 'item/completed') {
      this.observeFiles(record(p.item))
      this.observeOpen(record(p.item))
    }
    if (
      id !== undefined &&
      method &&
      (method.endsWith('/requestApproval') ||
        method === 'item/tool/requestUserInput' ||
        method === 'mcpServer/elicitation/request')
    ) {
      this.approvals.set(id, method)
      this.approvalThreads.set(id, p.threadId as string)
      this.mainTurn = method.endsWith('/requestApproval') ? 'approval' : 'input'
      this.publishActivity()
    } else if (ownedChild) {
      return
    } else if (method === 'thread/status/changed') {
      this.status(p.status)
    } else if (method === 'turn/started') {
      const turn = record(p.turn)
      if (typeof turn.id === 'string') this.liveTurns.add(turn.id)
      this.waitingForInput = false
      this.mainTurn = 'working'
      this.publishActivity()
    } else if (method === 'turn/completed') {
      const turn = record(p.turn)
      const fresh = typeof turn.id === 'string' && this.liveTurns.delete(turn.id)
      if (!fresh) return
      for (const [id, owner] of this.approvalThreads) {
        if (owner === this.threadId) {
          this.approvals.delete(id)
          this.approvalThreads.delete(id)
        }
      }
      this.waitingForInput = false
      this.markBackgroundCommands(this.threadId)
      this.mainTurn = this.liveTurns.size ? 'working' : 'ended'
      this.publishActivity()
    } else if (method === 'thread/name/updated' && typeof p.threadName === 'string') {
      this.emit({ type: 'title', title: p.threadName })
    } else if (method === 'thread/tokenUsage/updated') {
      const u = record(p.tokenUsage),
        total = record(u.total),
        last = record(u.last)
      const n = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
      if (
        !n(total.inputTokens) ||
        !n(total.outputTokens) ||
        !n(total.cachedInputTokens) ||
        (total.cacheWriteInputTokens !== undefined && !n(total.cacheWriteInputTokens))
      )
        return
      const ctx = n(last.totalTokens) ? last.totalTokens : undefined
      const window = n(u.modelContextWindow) ? u.modelContextWindow : undefined
      // CODEX§13
      const tokens = {
        inTok: Math.max(0, total.inputTokens - total.cachedInputTokens),
        outTok: total.outputTokens,
        cacheReadTok: total.cachedInputTokens,
        cacheWriteTok: (total.cacheWriteInputTokens as number) ?? 0
      }
      const pricing = this.model ? resolvePricing(this.model) : undefined
      this.emit({
        type: 'usage',
        usage: {
          ...tokens,
          ...(pricing ? { costUsd: costUsdOf(pricing, tokens) } : {}),
          ctxTokens: ctx,
          ...(window && ctx !== undefined ? { ctxPct: ctx / window } : {}),
          model: this.model
        }
      })
    } else if (method === 'error') {
      this.degraded(String(record(p.error).message ?? 'Codex reported an error.'))
    }
  }

  // CODEX§12
  private observeFiles(item: Record<string, unknown>): void {
    if (item.status !== 'completed') return
    let changed = false
    if (item.type === 'fileChange' && Array.isArray(item.changes)) {
      for (const change of item.changes.map(record)) {
        const kind = record(change.kind)
        const target = typeof kind.move_path === 'string' ? kind.move_path : change.path
        if (kind.type === 'delete' || typeof target !== 'string' || !path.isAbsolute(target))
          continue
        const { added, removed } = patchDelta(
          kind.type,
          typeof change.diff === 'string' ? change.diff : ''
        )
        noteWrite(this.touched, target, added, removed)
        this.lastTouched = this.lastWritten = target
        changed = true
      }
      if (changed) this.liveWrites++
    } else if (item.type === 'commandExecution' && Array.isArray(item.commandActions)) {
      for (const action of item.commandActions.map(record)) {
        if (action.type !== 'read' || typeof action.path !== 'string') continue
        if (!path.isAbsolute(action.path)) continue
        noteRead(this.touched, action.path)
        this.lastTouched = action.path
        changed = true
      }
    }
    if (!changed) return
    this.emit({
      type: 'files-changed',
      files: capTouched([...this.touched].map(([src, acc]) => touchedItem(src, acc))),
      lastTouched: this.lastTouched,
      lastWritten: this.lastWritten,
      liveWrites: this.liveWrites
    })
  }

  // CODEX§12
  private observeOpen(item: Record<string, unknown>): void {
    if (item.type !== 'commandExecution' || !OPEN_RAN.includes(String(item.status))) return
    if (!Array.isArray(item.commandActions)) return
    for (const action of item.commandActions.map(record)) {
      const target =
        typeof action.command === 'string' ? openTarget(action.command, item.cwd) : null
      if (target) this.emit({ type: 'open', target })
    }
  }

  private degraded(message: string): void {
    this.emit({ type: 'degraded', message })
  }

  private status(raw: unknown): void {
    const s = record(raw),
      flags = Array.isArray(s.activeFlags) ? s.activeFlags : []
    this.waitingForInput = flags.includes('waitingOnUserInput')
    if (
      [...this.approvals.values()].some((method) => method.endsWith('/requestApproval')) ||
      flags.includes('waitingOnApproval')
    )
      this.mainTurn = 'approval'
    else if (this.approvals.size || flags.includes('waitingOnUserInput')) this.mainTurn = 'input'
    else if (s.type === 'active') this.mainTurn = 'working'
    else if (s.type === 'idle' || s.type === 'notLoaded') this.mainTurn = 'ended'
    else if (s.type === 'systemError') {
      this.degraded('Codex session state is unavailable.')
      return
    }
    this.publishActivity()
  }

  private markBackgroundCommands(owner: string): void {
    for (const activity of this.activities.values()) {
      if (activity.owner === owner && activity.kind === 'command') {
        activity.visible = true
        // CODEX§4
        activity.state = 'unknown'
      }
    }
  }

  private observeActivity(method: string | undefined, params: Record<string, unknown>): void {
    const owner = typeof params.threadId === 'string' ? params.threadId : undefined
    if (!owner) return
    const root = this.roots.has(owner) ? owner : this.childRoots.get(owner)
    if (!root) return
    const item = record(params.item)
    let changed = false
    if (
      (method === 'item/started' || method === 'item/completed') &&
      item.type === 'collabAgentToolCall' &&
      item.senderThreadId === owner
    ) {
      const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
      for (const id of receivers) {
        if (typeof id !== 'string' || id === root) continue
        if (item.tool === 'spawnAgent' && item.status === 'completed') this.childRoots.set(id, root)
        if (this.childRoots.get(id) !== root) continue
        const status = record(record(item.agentsStates)[id]).status
        const key = `agent:${id}`
        if (status === 'shutdown' || status === 'notFound') {
          this.activities.delete(key)
          this.childRoots.delete(id)
          this.childTurns.delete(id)
        } else {
          const state =
            status === 'running' || status === 'pendingInit'
              ? 'working'
              : status === 'completed' || status === 'interrupted' || status === 'errored'
                ? 'waiting'
                : 'unknown'
          this.activities.set(key, {
            id: key,
            kind: 'agent',
            label: `Agent ${id.slice(0, 8)}`,
            state,
            owner: id,
            root,
            visible: true
          })
        }
        changed = true
      }
    } else if (
      (method === 'item/started' || method === 'item/completed') &&
      item.type === 'commandExecution' &&
      typeof item.id === 'string'
    ) {
      const key = `command:${owner}:${item.id}`
      if (
        method === 'item/completed' &&
        ['completed', 'failed', 'declined'].includes(String(item.status))
      ) {
        changed = this.activities.delete(key)
      } else if (item.status === 'inProgress') {
        const previous = this.activities.get(key)
        const visible = previous?.visible ?? (owner === this.threadId && !this.liveTurns.size)
        this.activities.set(key, {
          id: key,
          kind: 'command',
          label:
            typeof item.command === 'string' ? item.command.slice(0, 160) : 'Background command',
          state: visible ? 'unknown' : 'working',
          owner,
          root,
          visible
        })
        changed = true
      }
    } else if (this.childRoots.get(owner) === root) {
      const child = this.activities.get(`agent:${owner}`)
      if (!child) return
      if (method === 'thread/status/changed') {
        const status = record(params.status)
        const flags = Array.isArray(status.activeFlags) ? status.activeFlags : []
        child.state =
          status.type === 'active'
            ? flags.length
              ? 'unknown'
              : 'working'
            : status.type === 'idle' || status.type === 'notLoaded'
              ? 'waiting'
              : 'unknown'
        changed = true
      } else if (method === 'turn/started') {
        const turn = record(params.turn)
        if (typeof turn.id === 'string') this.childTurns.set(owner, turn.id)
        child.state = 'working'
        changed = true
      } else if (method === 'turn/completed') {
        const turn = record(params.turn)
        if (typeof turn.id !== 'string' || this.childTurns.get(owner) !== turn.id) return
        this.childTurns.delete(owner)
        child.state = 'waiting'
        this.markBackgroundCommands(owner)
        changed = true
      }
    }
    if (changed && root === this.threadId) this.publishActivity()
  }

  private publishActivity(): void {
    const items = [...this.activities.values()]
      .filter((item) => item.root === this.threadId && item.visible)
      .map(({ id, kind, label, state }) => ({ id, kind, label, state }))
    this.emit({ type: 'background-changed', items })
    const turn: Turn = [...this.approvals.values()].some((method) =>
      method.endsWith('/requestApproval')
    )
      ? 'approval'
      : this.approvals.size || this.waitingForInput
        ? 'input'
        : this.mainTurn === 'approval'
          ? 'approval'
          : this.liveTurns.size
            ? 'working'
            : this.mainTurn
    if (turn === this.publishedTurn) return
    this.publishedTurn = turn
    this.emit(TURN_EVENT[turn])
  }
}
