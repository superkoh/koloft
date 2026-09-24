import type {
  BackendId,
  CreateTabOptions,
  CreateTabResult,
  SessionInfo,
  SessionResumeRequest,
  SessionResumeResult
} from '@shared/types'
import { identityOf, SUPPORTED_PAIRS, unsupportedPairMessage } from '@shared/sessionBackend'
import { hostOf } from '@shared/remoteKey'

export interface SessionBackend {
  id: BackendId
  list(): SessionInfo[]
  create(options: CreateTabOptions): Promise<CreateTabResult>
  resume(request: SessionResumeRequest): Promise<SessionResumeResult>
  archive(key: string): boolean
  transcriptExists(key: string): boolean | Promise<boolean>
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

  list(): SessionInfo[] {
    return [...this.adapters.values()].flatMap((backend) =>
      backend.list().map((s) => ({
        ...s,
        nativeSessionId: s.nativeSessionId ?? s.sessionId
      }))
    )
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
