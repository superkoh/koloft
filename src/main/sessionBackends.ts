import type {
  BackendAvailability,
  BackendId,
  BackendSessionInfo,
  BackendSessionRow,
  CreateTabOptions,
  CreateTabResult,
  ResumePlan,
  SessionInfo,
  SessionResumeRequest,
  SessionResumeResult,
  SessionRow
} from '@shared/types'
import type { SessionEvent } from '@shared/sessionEvent'
import {
  identityOf,
  sourceOf,
  SUPPORTED_PAIRS,
  unsupportedPairMessage
} from '@shared/sessionBackend'
import { hostOf } from '@shared/remoteKey'

export interface SessionBackend {
  id: BackendId
  availability(): Promise<BackendAvailability>
  list(): BackendSessionInfo[]
  historyRows(workspacePath: string): Promise<BackendSessionRow[]>
  create(spec: CreateTabOptions): Promise<CreateTabResult>
  resume(request: SessionResumeRequest): Promise<SessionResumeResult>
  resumePlan(key: string): Promise<ResumePlan>
  hasTab(tabId: string): boolean
  aliveTabFor(key: string): string | undefined
  stop(tabId: string, how?: { detach?: boolean }): void | Promise<void>
  archive(key: string): boolean
  transcriptExists(key: string): boolean | Promise<boolean>
  observe(tabId: string, event: SessionEvent): void
  occupantOf(dir: string): string | null
  accountUsable(): boolean
  trustsFolder(dir: string): boolean | Promise<boolean>
}

export class SessionBackends {
  private adapters = new Map<BackendId, SessionBackend>()

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

  availability(
    unregistered: (id: BackendId) => BackendAvailability
  ): Promise<BackendAvailability[]> {
    return Promise.all(
      (Object.keys(SUPPORTED_PAIRS) as BackendId[]).map((id) => {
        const backend = this.adapters.get(id)
        return backend ? backend.availability() : unregistered(id)
      })
    )
  }

  list(): SessionInfo[] {
    return [...this.adapters.values()].flatMap((backend) =>
      backend.list().map((s): SessionInfo => ({
        ...s,
        backendId: backend.id,
        host: s.remote ? 'ssh' : 'local',
        nativeSessionId: s.nativeSessionId ?? s.sessionId
      }))
    )
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
    return rows.sort((a, b) => b.mtime - a.mtime)
  }

  create(options: CreateTabOptions): Promise<CreateTabResult> {
    if (options.kind === 'shell') throw new Error('A utility terminal is not a session.')
    if (
      !SUPPORTED_PAIRS[options.kind] ||
      options.util ||
      (options.worktreeResourceId && options.kind !== 'codex')
    ) {
      return Promise.resolve({ ok: false, code: 'invalid-args' })
    }
    const refusal = unsupportedPairMessage(options.kind, hostOf(options.cwd ?? ''))
    if (refusal) return Promise.reject(new Error(refusal))
    return this.get(options.kind).create(options)
  }
}
