import type { BackendId, HostId, SessionMethods } from './types'

export const SESSION_BACKENDS: BackendId[] = ['claude', 'codex']

export function normalizeSessionMethods(raw: unknown): SessionMethods {
  const value = raw && typeof raw === 'object' ? (raw as Partial<SessionMethods>) : {}
  const enabled = { claude: true, codex: value.enabled?.codex !== false }
  return {
    enabled,
    defaultBackend: value.defaultBackend === 'codex' && enabled.codex ? 'codex' : 'claude'
  }
}

export const BACKEND_LABEL: Record<BackendId, string> = { claude: 'Claude', codex: 'Codex' }

export type Capability = true | { unsupported: string } | { pending: true }

export interface Capabilities {
  workbench: Capability
  worktree: Capability
  accounts: Capability
  scheduledTasks: Capability
  agentOpen: Capability
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
  browserControl: PENDING,
  filesTouched: PENDING,
  statusline3: PENDING,
  rename: PENDING
}

const CAPABILITIES: Record<BackendId, Record<HostId, Capabilities>> = {
  claude: {
    local: EVERYTHING,
    ssh: {
      ...EVERYTHING,
      agentOpen: PENDING,
      browserControl: PENDING,
      scheduledTasks: PENDING,
      rename: PENDING
    }
  },
  codex: {
    local: {
      ...EVERYTHING,
      workbench: PENDING,
      accounts: PENDING,
      scheduledTasks: PENDING,
      filesTouched: PENDING,
      agentOpen: PENDING,
      browserControl: PENDING,
      // CODEX§8
      statusline3: { unsupported: 'CODEX§8' }
    },
    ssh: NOTHING_YET
  }
}

export function capabilitiesFor(backend: BackendId, host: HostId): Capabilities {
  return CAPABILITIES[backend][host]
}

export const SUPPORTED_PAIRS: Record<BackendId, Record<HostId, boolean>> = {
  claude: { local: true, ssh: true },
  codex: { local: true, ssh: false }
}

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
