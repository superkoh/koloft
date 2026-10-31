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
  muse: 'Muse',
  agy: 'Antigravity'
}

export const BACKEND_PRODUCT: Record<BackendId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  muse: 'Muse Code',
  agy: 'Antigravity CLI'
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
  // CC§13
  claude: { local: 'peerLine', ssh: 'peerLine' },
  // CODEX§17
  codex: { local: 'queue', ssh: 'queue' },
  // MUSE§7
  muse: { local: 'typed', ssh: 'typed' },
  // AGY§15 AGY§16
  agy: { local: 'typed', ssh: 'typed' }
}

export function messagingOf(backend: BackendId, remote: boolean): Messaging {
  return MESSAGING[backend][remote ? 'ssh' : 'local']
}

export function reachedBySendMessage(backend: BackendId): boolean {
  return MESSAGING[backend].local === 'peerLine'
}

export interface PeerTraits {
  handoverAsRole: boolean
  quotesOwnerWordsInHooks: boolean
}

export const PEER_TRAITS: Record<BackendId, PeerTraits> = {
  // CC§13
  claude: {
    handoverAsRole: false,
    quotesOwnerWordsInHooks: true
  },
  // CODEX§17
  codex: {
    handoverAsRole: true,
    quotesOwnerWordsInHooks: false
  },
  muse: {
    handoverAsRole: false,
    quotesOwnerWordsInHooks: false
  },
  agy: {
    handoverAsRole: false,
    quotesOwnerWordsInHooks: false
  }
}

const CONVERSATION_AT_FIRST_PROMPT: Record<BackendId, boolean> = {
  claude: false,
  codex: false,
  // MUSE§4
  muse: false,
  // AGY§8
  agy: true
}

export function conversationAtFirstPrompt(backend: BackendId): boolean {
  return CONVERSATION_AT_FIRST_PROMPT[backend]
}

// AGY§16
export function namedAtLaunch(backend: BackendId, remote: boolean): boolean {
  return !(backend === 'agy' && remote)
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
  askHookWaitsForDiscord: Capability
  panelSeen: Capability
  worktreeRemovalFollowed: Capability
}

const PENDING = { pending: true } as const

const EVERYTHING: Capabilities = {
  workbench: true,
  scheduledTasks: true,
  agentTools: true,
  browserControl: true,
  askHookWaitsForDiscord: true,
  panelSeen: true,
  worktreeRemovalFollowed: true
}

const OUTSIDE_LOCAL_CLAUDE: Capabilities = {
  ...EVERYTHING,
  askHookWaitsForDiscord: PENDING,
  panelSeen: PENDING,
  worktreeRemovalFollowed: PENDING
}

const ON_A_MACHINE: Capabilities = {
  ...OUTSIDE_LOCAL_CLAUDE,
  browserControl: PENDING
}

const CAPABILITIES: Record<BackendId, Record<HostId, Capabilities>> = {
  // CC§4 CC§11 CC§14
  claude: {
    local: EVERYTHING,
    // PLATFORM§33
    ssh: { ...ON_A_MACHINE, browserControl: true, panelSeen: true, worktreeRemovalFollowed: true }
  },
  // CODEX§21
  codex: {
    local: { ...OUTSIDE_LOCAL_CLAUDE, panelSeen: true },
    // CODEX§16
    ssh: { ...ON_A_MACHINE, panelSeen: true }
  },
  muse: {
    local: { ...OUTSIDE_LOCAL_CLAUDE, panelSeen: true },
    ssh: { ...ON_A_MACHINE, panelSeen: true }
  },
  agy: {
    local: OUTSIDE_LOCAL_CLAUDE,
    ssh: ON_A_MACHINE
  }
}

export function capabilitiesFor(backend: BackendId, host: HostId): Capabilities {
  return CAPABILITIES[backend][host]
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

// CC§10 CODEX§16
export function checkedOnThisMac(backend: BackendId, host: HostId): boolean {
  return host === 'local' || backend !== 'claude'
}

export function listedBackends(
  methods: SessionMethods,
  installed: ((backend: BackendId) => boolean) | null,
  host: HostId
): BackendId[] {
  const listed = installed
    ? SESSION_BACKENDS.filter(
        (b) => methods.enabled[b] && (installed(b) || !checkedOnThisMac(b, host))
      )
    : []
  return listed.length ? listed : [methods.defaultBackend]
}

export interface LaunchMenu {
  listed: BackendId[]
  named: BackendId[] | null
  sole: BackendId
}

export function launchMenus(
  methods: SessionMethods,
  installed: ((backend: BackendId) => boolean) | null
): Record<HostId, LaunchMenu> {
  const on = (host: HostId): LaunchMenu => {
    const listed = listedBackends(methods, installed, host)
    const { defaultBackend } = methods
    return {
      listed,
      named:
        listed.length < 2 || !listed.includes(defaultBackend)
          ? null
          : backendsFrom(defaultBackend).filter((b) => listed.includes(b)),
      sole: effectiveBackend(methods, new Set(listed))
    }
  }
  return { local: on('local'), ssh: on('ssh') }
}

export function effectiveBackend(
  methods: SessionMethods,
  available: ReadonlySet<BackendId>
): BackendId {
  const usable = SESSION_BACKENDS.filter((b) => methods.enabled[b] && available.has(b))
  if (usable.includes(methods.defaultBackend)) return methods.defaultBackend
  return usable[0] ?? methods.defaultBackend
}
