import type {
  BackendId,
  CreateTabOptions,
  CreateTabResult,
  SessionInfo,
  SessionResumeRequest,
  SessionResumeResult
} from '@shared/types'
import { identityOf, SESSION_CAPABILITIES } from '@shared/sessionBackend'

export interface SessionBackend {
  id: BackendId
  list(): SessionInfo[]
  create(options: CreateTabOptions): Promise<CreateTabResult>
  resume(request: SessionResumeRequest): Promise<SessionResumeResult>
  archive(key: string): boolean
  transcriptExists(key: string): boolean | Promise<boolean>
}

/** The Claude adapter keeps its hook/tracker internals; shared callers use the same contract as Codex. */
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

  list(): SessionInfo[] {
    return [...this.adapters.values()].flatMap((backend) =>
      backend.list().map((s) => ({
        ...s,
        cliVersion: s.cliVersion ?? s.ccVersion,
        backendId: backend.id,
        nativeSessionId: s.nativeSessionId ?? s.sessionId
      }))
    )
  }

  create(options: CreateTabOptions): Promise<CreateTabResult> {
    if (options.kind === 'shell') throw new Error('A utility terminal is not a session.')
    const capabilities = SESSION_CAPABILITIES[options.kind]
    if (
      !capabilities ||
      (options.cwd?.startsWith('ssh://') && !capabilities.remote) ||
      options.util ||
      (options.worktreeResourceId && options.kind !== 'codex')
    ) {
      return Promise.resolve({ ok: false, code: 'invalid-args' })
    }
    return this.get(options.kind).create(options)
  }
}
