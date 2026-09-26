import type { BackendAvailability, BackendId, HostId, SessionMethods, SessionSource } from './types'
import { hostOf } from './remoteKey'

export const SESSION_BACKENDS: BackendId[] = ['claude', 'codex']

export function backendIdOf(value: unknown): BackendId | undefined {
  return SESSION_BACKENDS.find((b) => b === value)
}

export function normalizeSessionMethods(raw: unknown): SessionMethods {
  const value = raw && typeof raw === 'object' ? (raw as Partial<SessionMethods>) : {}
  const enabled = { claude: true, codex: value.enabled?.codex !== false }
  return {
    enabled,
    defaultBackend: value.defaultBackend === 'codex' && enabled.codex ? 'codex' : 'claude'
  }
}

export const BACKEND_LABEL: Record<BackendId, string> = { claude: 'Claude', codex: 'Codex' }

export function backendAvailable(list: BackendAvailability[], id: BackendId): boolean {
  return list.some((b) => b.id === id && b.available)
}

export function sourceOf(backendId: BackendId, workspacePath: string): SessionSource {
  return { backendId, host: hostOf(workspacePath) }
}

export type Capability = true | { unsupported: string } | { pending: true }

export interface Capabilities {
  workbench: Capability
  worktree: Capability
  accounts: Capability
  scheduledTasks: Capability
  agentOpen: Capability
  agentTools: Capability
  browserControl: Capability
  filesTouched: Capability
  statusline3: Capability
  rename: Capability
}

const PENDING = { pending: true } as const

const EVERYTHING: Capabilities = {
  workbench: true,
  worktree: true,
  accounts: true,
  scheduledTasks: true,
  agentOpen: true,
  agentTools: true,
  browserControl: true,
  filesTouched: true,
  statusline3: true,
  rename: true
}

const NOTHING_YET: Capabilities = {
  workbench: PENDING,
  worktree: PENDING,
  accounts: PENDING,
  scheduledTasks: PENDING,
  agentOpen: PENDING,
  agentTools: PENDING,
  browserControl: PENDING,
  filesTouched: PENDING,
  statusline3: PENDING,
  rename: PENDING
}

const CAPABILITIES: Record<BackendId, Record<HostId, Capabilities | 'refused'>> = {
  claude: {
    local: EVERYTHING,
    ssh: {
      ...EVERYTHING,
      agentOpen: PENDING,
      agentTools: PENDING,
      browserControl: PENDING,
      rename: PENDING
    }
  },
  codex: {
    local: {
      ...EVERYTHING,
      browserControl: PENDING,
      // CODEX§8
      statusline3: { unsupported: 'CODEX§8' }
    },
    // CODEX§16
    ssh: 'refused'
  }
}

export function capabilitiesFor(backend: BackendId, host: HostId): Capabilities {
  const caps = CAPABILITIES[backend][host]
  return caps === 'refused' ? NOTHING_YET : caps
}

export const SUPPORTED_PAIRS = Object.fromEntries(
  SESSION_BACKENDS.map((b) => [
    b,
    { local: CAPABILITIES[b].local !== 'refused', ssh: CAPABILITIES[b].ssh !== 'refused' }
  ])
) as Record<BackendId, Record<HostId, boolean>>

export function unsupportedPairMessage(backend: BackendId, host: HostId): string | undefined {
  return SUPPORTED_PAIRS[backend][host]
    ? undefined
    : `${BACKEND_LABEL[backend]} sessions cannot run on a remote machine yet.`
}

export interface SessionIdentity {
  backendId: BackendId
  sourceId: string
  nativeSessionId: string
}

export function sessionKey(ref: SessionIdentity): string {
  return [ref.backendId, ref.sourceId, ref.nativeSessionId].map(encodeURIComponent).join(':')
}

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

export function effectiveBackend(
  methods: SessionMethods,
  available: ReadonlySet<BackendId>
): BackendId {
  const usable = SESSION_BACKENDS.filter((b) => methods.enabled[b] && available.has(b))
  if (usable.includes(methods.defaultBackend)) return methods.defaultBackend
  return usable.length === 1 ? usable[0] : methods.defaultBackend
}
