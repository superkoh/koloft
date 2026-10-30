import type {
  AttentionSubject,
  BackendAvailability,
  BackendId,
  BackendSessionInfo,
  BackendSessionRow,
  CreateTabOptions,
  CreateTabResult,
  DocVerdict,
  ResumePlan,
  SessionInfo,
  SessionResumeRequest,
  SessionResumeResult,
  SessionRow
} from '@shared/types'
import type { AskPayload, SessionEvent } from '@shared/sessionEvent'
import type { Turn } from '@shared/turns'
import { identityOf, sourceOf, SESSION_BACKENDS } from '@shared/sessionBackend'
import { hostOf } from '@shared/remoteKey'
import { NO_USABLE_ACCOUNT } from '@shared/accountUsage'
import type { ModeClass } from './crossSessionMessage'

export interface SessionBackend {
  id: BackendId
  recoversWorktrees?: true
  availability(): Promise<BackendAvailability>
  forgetAvailability(): void
  list(): BackendSessionInfo[]
  historyRows(workspacePath: string): Promise<BackendSessionRow[]>
  create(spec: CreateTabOptions): Promise<CreateTabResult>
  resume(request: SessionResumeRequest): Promise<SessionResumeResult>
  resumePlan(key: string): Promise<ResumePlan>
  hasTab(tabId: string): boolean
  workspaceOfTab(tabId: string): string | undefined
  aliveTabFor(key: string): string | undefined
  stop(tabId: string, restarting?: boolean): void | Promise<void>
  archive(key: string): boolean
  transcriptExists(key: string): boolean | Promise<boolean>
  observe(tabId: string, event: SessionEvent): void
  occupantOf(dir: string): string | null
  accountUsable(): boolean
  trustsFolder(dir: string): boolean | Promise<boolean>
  turns(key: string, n: number): Promise<Turn[]>
  permissionClass(tabId: string): ModeClass
  peerNames(): (key: string) => Promise<string | null>
  runningElsewhere(key: string): boolean | Promise<boolean>
}

export interface SessionLifecycle {
  prompted(tabId: string): void
  bound(tabId: string, key: string, idleCompaction: boolean): void
  exited(tabId: string, subject: AttentionSubject): void
  clearAttention(tabId: string): void
  open(tabId: string, target: string): void
  turnEnded(tabId: string, turn: Turn): void
  asked(tabId: string, ask: AskPayload): void
}

const CLEAN_EXIT_HIDES_A_LATER_EXIT_MS = 30_000

export class SessionBackends {
  private adapters = new Map<BackendId, SessionBackend>()
  private cleanExitAt = new Map<string, number>()
  isButlerSession: (tabOrSessionId: string) => boolean = () => false
  turnOver: (tabId: string) => boolean = () => false
  askingOf: (tabId: string) => string | undefined = () => undefined
  docVerdictsOf: (sessionId: string) => Record<string, DocVerdict> | undefined = () => undefined

  constructor(private lifecycle: SessionLifecycle) {}

  observe(tabId: string, event: SessionEvent): void {
    switch (event.type) {
      case 'bound':
        this.cleanExitAt.delete(tabId)
        if (!event.idleCompaction) this.lifecycle.clearAttention(tabId)
        return this.lifecycle.bound(tabId, event.key, !!event.idleCompaction)
      case 'exited':
        return this.exited(tabId, event.clean, { title: event.title, sessionId: event.sessionId })
      case 'open':
        return this.lifecycle.open(tabId, event.target)
      case 'turn-ended':
        return this.lifecycle.turnEnded(tabId, event.turn)
      case 'asked':
        return this.lifecycle.asked(tabId, event.ask)
      case 'prompt':
        this.lifecycle.prompted(tabId)
    }
    this.ownerOfTab(tabId)?.observe(tabId, event)
  }

  private exited(tabId: string, clean: boolean, subject: AttentionSubject): void {
    const now = Date.now()
    for (const [id, at] of this.cleanExitAt) {
      if (now - at > CLEAN_EXIT_HIDES_A_LATER_EXIT_MS) this.cleanExitAt.delete(id)
    }
    if (clean) {
      this.cleanExitAt.set(tabId, now)
      this.lifecycle.clearAttention(tabId)
    } else if (!this.cleanExitAt.has(tabId)) this.lifecycle.exited(tabId, subject)
  }

  register(adapter: SessionBackend): void {
    if (this.adapters.has(adapter.id))
      throw new Error(`Session backend already registered: ${adapter.id}`)
    this.adapters.set(adapter.id, adapter)
  }

  get(id: BackendId): SessionBackend {
    const backend = this.adapters.get(id)
    if (!backend) throw new Error(`Session backend is unavailable: ${id}`)
    return backend
  }

  forSession(key: string): SessionBackend {
    return this.get(identityOf(key).backendId)
  }

  occupantOf(dir: string): string | null {
    for (const backend of this.adapters.values()) {
      const occupant = backend.occupantOf(dir)
      if (occupant) return occupant
    }
    return null
  }

  ownerOfTab(tabId: string): SessionBackend | undefined {
    return [...this.adapters.values()].find((backend) => backend.hasTab(tabId))
  }

  workspaceOfTab(tabId: string): string | undefined {
    return this.ownerOfTab(tabId)?.workspaceOfTab(tabId)
  }

  availability(
    unregistered: (id: BackendId) => BackendAvailability
  ): Promise<BackendAvailability[]> {
    return Promise.all(
      SESSION_BACKENDS.map((id) => {
        const backend = this.adapters.get(id)
        return backend ? backend.availability() : unregistered(id)
      })
    )
  }

  forgetAvailability(): void {
    for (const backend of this.adapters.values()) backend.forgetAvailability()
  }

  list(): SessionInfo[] {
    return [...this.adapters.values()].flatMap((backend) =>
      backend.list().map((s): SessionInfo => ({
        ...s,
        backendId: backend.id,
        host: s.remote ? 'ssh' : hostOf(s.cwd),
        nativeSessionId: s.nativeSessionId ?? s.sessionId,
        butler: this.isButlerSession(s.tabId) || this.isButlerSession(s.sessionId),
        turnOver: this.turnOver(s.tabId),
        asking: this.askingOf(s.tabId),
        docVerdicts: s.sessionId ? this.docVerdictsOf(s.sessionId) : undefined
      }))
    )
  }

  turns(key: string, n: number): Promise<Turn[]> {
    return this.forSession(key).turns(key, n)
  }

  permissionClass(tabId: string): ModeClass {
    return this.ownerOfTab(tabId)?.permissionClass(tabId) ?? 'prompting'
  }

  peerNames(): (s: { backendId: BackendId; sessionId: string }) => Promise<string | null> {
    const lookups = new Map<BackendId, (key: string) => Promise<string | null>>()
    return async ({ backendId, sessionId }) => {
      const backend = this.adapters.get(backendId)
      if (!backend) return null
      const lookup = lookups.get(backendId) ?? backend.peerNames()
      lookups.set(backendId, lookup)
      return lookup(sessionId)
    }
  }

  async runningElsewhere(backendId: BackendId, key: string): Promise<boolean> {
    return (await this.adapters.get(backendId)?.runningElsewhere(key)) ?? false
  }

  async historyRows(
    workspacePath: string,
    partlyUnread: (backend: BackendId, error: unknown) => void
  ): Promise<SessionRow[]> {
    const backends = [...this.adapters.values()]
    const answers = await Promise.allSettled(backends.map((b) => b.historyRows(workspacePath)))
    const rows: SessionRow[] = []
    const failures: { id: BackendId; error: unknown }[] = []
    answers.forEach((answer, i) => {
      if (answer.status === 'fulfilled')
        rows.push(
          ...answer.value.map((r) => ({ ...r, ...sourceOf(backends[i].id, workspacePath) }))
        )
      else failures.push({ id: backends[i].id, error: answer.reason })
    })
    if (failures.length && !rows.length) throw failures[0].error
    for (const f of failures) partlyUnread(f.id, f.error)
    return rows.filter((r) => !this.isButlerSession(r.id)).sort((a, b) => b.mtime - a.mtime)
  }

  create(options: CreateTabOptions): Promise<CreateTabResult> {
    if (options.kind === 'shell') throw new Error('A utility terminal is not a session.')
    if (
      !SESSION_BACKENDS.includes(options.kind) ||
      options.util ||
      (options.worktreeResourceId && !this.adapters.get(options.kind)?.recoversWorktrees)
    ) {
      return Promise.resolve({ ok: false, code: 'invalid-args' })
    }
    const refused = this.noUsableAccount(options.kind)
    if (refused) return Promise.reject(new Error(refused))
    return this.get(options.kind).create(options)
  }

  // ADR-0030
  noUsableAccount(kind: BackendId): string | null {
    return this.get(kind).accountUsable() ? null : NO_USABLE_ACCOUNT[kind]
  }
}
