import type { BackendId, SessionMethods } from './types'

export const SESSION_BACKENDS: BackendId[] = ['claude', 'codex']

export function normalizeSessionMethods(raw: unknown): SessionMethods {
  const value = raw && typeof raw === 'object' ? (raw as Partial<SessionMethods>) : {}
  const enabled = { claude: true, codex: value.enabled?.codex !== false }
  return {
    enabled,
    defaultBackend: value.defaultBackend === 'codex' && enabled.codex ? 'codex' : 'claude'
  }
}

export interface SessionCapabilities {
  workbench: boolean
  worktree: boolean
  remote: boolean
  accounts: boolean
  scheduledTasks: boolean
}

export const SESSION_CAPABILITIES: Record<BackendId, SessionCapabilities> = {
  claude: { workbench: true, worktree: true, remote: true, accounts: true, scheduledTasks: true },
  codex: { workbench: false, worktree: true, remote: false, accounts: false, scheduledTasks: false }
}

export interface SessionIdentity {
  backendId: BackendId
  sourceId: string
  nativeSessionId: string
}

export function sessionKey(ref: SessionIdentity): string {
  return [ref.backendId, ref.sourceId, ref.nativeSessionId].map(encodeURIComponent).join(':')
}

// Existing Claude keys remain readable at the compatibility boundary.
export function identityOf(key: string): SessionIdentity {
  const parts = key.split(':')
  if (parts.length === 3 && (parts[0] === 'codex' || parts[0] === 'claude')) {
    return {
      backendId: parts[0],
      sourceId: decodeURIComponent(parts[1]),
      nativeSessionId: decodeURIComponent(parts[2])
    }
  }
  return { backendId: 'claude', sourceId: 'local', nativeSessionId: key }
}

/**
 * Which method a direct entrance launches. `available` is what the probes found, so a
 * machine with only Codex installed still starts in one step — `normalizeSessionMethods`
 * reads settings alone and would hand back a `claude` that is not there. A default that
 * is off or missing with no single replacement comes back unchanged: main refuses it and
 * says why, which is better than quietly starting the other one.
 */
export function effectiveBackend(
  methods: SessionMethods,
  available: ReadonlySet<BackendId>
): BackendId {
  const usable = SESSION_BACKENDS.filter((b) => methods.enabled[b] && available.has(b))
  if (usable.includes(methods.defaultBackend)) return methods.defaultBackend
  return usable.length === 1 ? usable[0] : methods.defaultBackend
}
