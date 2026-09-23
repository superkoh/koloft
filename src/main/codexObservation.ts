import type { SessionInfo, SessionStatus, SessionUsage } from '@shared/types'
import path from 'path'

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

interface ObservationEvents {
  bind(thread: CodexThread, change: 'replace' | 'switch'): void
  status(status: SessionStatus): void
  title(title: string): void
  usage(usage: SessionUsage): void
  attention(kind: 'approval' | 'turn-done' | 'clear'): void
  degraded(message: string): void
  background?(items: NonNullable<SessionInfo['background']>): void
}

type BackgroundItem = NonNullable<SessionInfo['background']>[number]
interface Activity extends BackgroundItem {
  root: string
  owner: string
  visible: boolean
}

/** Observes the sole TUI connection. It never answers a request on the user's behalf. */
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
  private mainStatus: SessionStatus = 'idle'
  private waitingForInput = false
  private pendingCompletion = false
  private roots = new Set<string>()
  private childRoots = new Map<string, string>()
  private childTurns = new Map<string, string>()
  private activities = new Map<string, Activity>()
  unsubscribed = false

  constructor(private events: ObservationEvents) {}

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
          this.events.attention('clear')
          this.waitingForInput = false
          this.mainStatus = this.liveTurns.size ? 'working' : 'idle'
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
        this.events.degraded(String(record(f.error).message ?? 'Codex could not open the session.'))
        return
      }
      const result = record(f.result)
      const thread = userThread(result.thread)
      if (!thread) {
        this.events.degraded('Codex returned an unsupported session response.')
        return
      }
      this.threadId = thread.id
      this.roots.add(thread.id)
      this.unsubscribed = false
      this.pendingCompletion = false
      this.liveTurns.clear()
      this.approvals.clear()
      this.approvalThreads.clear()
      this.waitingForInput = false
      this.model = typeof result.model === 'string' ? result.model : (thread.model ?? undefined)
      this.events.attention('clear')
      const cwd =
        typeof result.cwd === 'string' && path.isAbsolute(result.cwd)
          ? result.cwd
          : (req.cwd ?? thread.cwd)
      this.events.bind(
        { ...thread, cwd, model: this.model },
        req.method === 'thread/start' ? 'replace' : 'switch'
      )
      this.status(thread.status)
      return
    }
    this.observeActivity(method, p)
    const ownedChild =
      typeof p.threadId === 'string' && this.childRoots.get(p.threadId) === this.threadId
    if (!this.threadId || (p.threadId !== this.threadId && !ownedChild)) return
    if (
      id !== undefined &&
      method &&
      (method.endsWith('/requestApproval') ||
        method === 'item/tool/requestUserInput' ||
        method === 'mcpServer/elicitation/request')
    ) {
      this.approvals.set(id, method)
      this.approvalThreads.set(id, p.threadId as string)
      this.mainStatus = method.endsWith('/requestApproval') ? 'approval' : 'waiting'
      this.publishActivity()
      this.events.attention('approval')
    } else if (ownedChild) {
      return
    } else if (method === 'thread/status/changed') {
      this.status(p.status)
    } else if (method === 'turn/started') {
      const turn = record(p.turn)
      if (typeof turn.id === 'string') this.liveTurns.add(turn.id)
      this.waitingForInput = false
      this.pendingCompletion = false
      this.events.attention('clear')
      this.mainStatus = 'working'
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
      if (!this.approvals.size) this.events.attention('clear')
      this.markBackgroundCommands(this.threadId)
      this.mainStatus = this.liveTurns.size ? 'working' : 'waiting'
      this.pendingCompletion = !this.liveTurns.size && turn.status === 'completed'
      this.publishActivity()
    } else if (method === 'thread/name/updated' && typeof p.threadName === 'string') {
      this.events.title(p.threadName)
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
      this.events.usage({
        inTok: total.inputTokens,
        outTok: total.outputTokens,
        cacheReadTok: total.cachedInputTokens,
        cacheWriteTok: (total.cacheWriteInputTokens as number) ?? 0,
        ctxTokens: ctx,
        ...(window && ctx !== undefined ? { ctxPct: ctx / window } : {}),
        model: this.model
      })
    } else if (method === 'error') {
      this.events.degraded(String(record(p.error).message ?? 'Codex reported an error.'))
    }
  }

  private status(raw: unknown): void {
    const s = record(raw),
      flags = Array.isArray(s.activeFlags) ? s.activeFlags : []
    this.waitingForInput = flags.includes('waitingOnUserInput')
    if (
      [...this.approvals.values()].some((method) => method.endsWith('/requestApproval')) ||
      flags.includes('waitingOnApproval')
    )
      this.mainStatus = 'approval'
    else if (this.approvals.size || flags.includes('waitingOnUserInput'))
      this.mainStatus = 'waiting'
    else if (s.type === 'active') this.mainStatus = 'working'
    else if (s.type === 'idle' || s.type === 'notLoaded') this.mainStatus = 'idle'
    else if (s.type === 'systemError') {
      this.events.degraded('Codex session state is unavailable.')
      return
    }
    this.publishActivity()
  }

  private markBackgroundCommands(owner: string): void {
    for (const activity of this.activities.values()) {
      if (activity.owner === owner && activity.kind === 'command') {
        activity.visible = true
        // A still-open command may be work or a resident service; the protocol does not distinguish them.
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
    const activities = [...this.activities.values()].filter(
      (item) => item.root === this.threadId && item.visible
    )
    this.events.background?.(
      activities.map(({ id, kind, label, state }) => ({ id, kind, label, state }))
    )
    const active = activities.some((item) => item.state === 'working')
    const uncertain = activities.some((item) => item.state === 'unknown')
    const status = [...this.approvals.values()].some((method) =>
      method.endsWith('/requestApproval')
    )
      ? 'approval'
      : this.approvals.size || this.waitingForInput
        ? 'waiting'
        : this.mainStatus === 'approval'
          ? 'approval'
          : this.liveTurns.size || active
            ? 'working'
            : this.mainStatus
    this.events.status(status)
    if (
      this.pendingCompletion &&
      !this.liveTurns.size &&
      !active &&
      !uncertain &&
      !this.approvals.size &&
      !this.waitingForInput
    ) {
      this.pendingCompletion = false
      this.events.attention('turn-done')
    }
  }
}
