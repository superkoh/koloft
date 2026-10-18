import type {
  BackendAvailability,
  BackendId,
  HostId,
  SessionInfo,
  SessionMethods,
  SessionSource
} from './types'
import { hostOf } from './remoteKey'

export const BACKEND_LABEL: Record<BackendId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  muse: 'Muse'
}

export const BACKEND_PRODUCT: Record<BackendId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  muse: 'Muse Code'
}

export const SESSION_BACKENDS = Object.keys(BACKEND_LABEL) as BackendId[]

export const ALWAYS_ON_BACKEND: BackendId = 'claude'

export function byBackend<T>(value: (backend: BackendId) => T): Record<BackendId, T> {
  return Object.fromEntries(SESSION_BACKENDS.map((b) => [b, value(b)])) as Record<BackendId, T>
}

export function backendsFrom(preferred: BackendId): BackendId[] {
  return [preferred, ...SESSION_BACKENDS.filter((b) => b !== preferred)]
}

export function productList(backends: readonly BackendId[], joiner: 'or' | 'and'): string {
  const names = backends.map((b) => BACKEND_PRODUCT[b])
  return names.length < 2
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} ${joiner} ${names[names.length - 1]}`
}

export function statusUnavailable(session?: Pick<SessionInfo, 'details'>): boolean {
  return session?.details?.codex?.observation === 'degraded'
}

export function backendIdOf(value: unknown): BackendId | undefined {
  return SESSION_BACKENDS.find((b) => b === value)
}

export function normalizeSessionMethods(raw: unknown): SessionMethods {
  const value = raw && typeof raw === 'object' ? (raw as Partial<SessionMethods>) : {}
  const enabled = byBackend((b) => b === ALWAYS_ON_BACKEND || value.enabled?.[b] !== false)
  const picked = backendIdOf(value.defaultBackend)
  return {
    enabled,
    defaultBackend: picked && enabled[picked] ? picked : ALWAYS_ON_BACKEND
  }
}

export function preferredAssistBackend(settings: {
  assist: { backend: BackendId } | null
  sessionMethods: SessionMethods
}): BackendId {
  return settings.assist?.backend ?? settings.sessionMethods.defaultBackend
}

export function backendAvailable(list: BackendAvailability[], id: BackendId): boolean {
  return list.some((b) => b.id === id && b.available)
}

export function shownAsInstalled(list: BackendAvailability[] | null, id: BackendId): boolean {
  return list ? backendAvailable(list, id) : id === ALWAYS_ON_BACKEND
}

export type Messaging = 'queue' | 'peerLine' | 'typed'

const MESSAGING: Record<BackendId, Record<HostId, Messaging>> = {
  claude: { local: 'peerLine', ssh: 'typed' },
  // CODEX§17
  codex: { local: 'queue', ssh: 'queue' },
  // MUSE§7
  muse: { local: 'typed', ssh: 'typed' }
}

export function messagingOf(backend: BackendId, remote: boolean): Messaging {
  return MESSAGING[backend][remote ? 'ssh' : 'local']
}

export function sourceOf(backendId: BackendId, workspacePath: string): SessionSource {
  return { backendId, host: hostOf(workspacePath) }
}

export type Capability = true | { pending: true }

export interface Capabilities {
  workbench: Capability
  scheduledTasks: Capability
  agentTools: Capability
  browserControl: Capability
}

const PENDING = { pending: true } as const

const EVERYTHING: Capabilities = {
  workbench: true,
  scheduledTasks: true,
  agentTools: true,
  browserControl: true
}

const NOTHING_YET: Capabilities = {
  workbench: PENDING,
  scheduledTasks: PENDING,
  agentTools: PENDING,
  browserControl: PENDING
}

const ON_A_MACHINE: Capabilities = {
  ...EVERYTHING,
  browserControl: PENDING
}

const CAPABILITIES: Record<BackendId, Record<HostId, Capabilities | 'refused'>> = {
  claude: {
    local: EVERYTHING,
    ssh: ON_A_MACHINE
  },
  codex: {
    local: EVERYTHING,
    // CODEX§16
    ssh: ON_A_MACHINE
  },
  muse: {
    local: EVERYTHING,
    ssh: ON_A_MACHINE
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
  const backendId = backendIdOf(parts[0])
  if (parts.length === 3 && backendId) {
    return {
      backendId,
      sourceId: decodeURIComponent(parts[1]),
      nativeSessionId: decodeURIComponent(parts[2])
    }
  }
  return { backendId: 'claude', sourceId: 'local', nativeSessionId: key }
}

export function listedBackends(
  methods: SessionMethods,
  installed: ((backend: BackendId) => boolean) | null
): BackendId[] {
  const listed = installed ? SESSION_BACKENDS.filter((b) => methods.enabled[b] && installed(b)) : []
  return listed.length ? listed : [methods.defaultBackend]
}

export function effectiveBackend(
  methods: SessionMethods,
  available: ReadonlySet<BackendId>
): BackendId {
  const usable = SESSION_BACKENDS.filter((b) => methods.enabled[b] && available.has(b))
  if (usable.includes(methods.defaultBackend)) return methods.defaultBackend
  return usable[0] ?? methods.defaultBackend
}
