import type { ConductorBinding, SessionInfo } from '@shared/types'
import { GLOBAL_SCOPE } from '@shared/conductors'
import { isRemoteKey } from '@shared/remoteKey'

export function conductorTab(
  binding: ConductorBinding,
  sessions: readonly SessionInfo[],
  opened: Record<string, string>,
  tabs: readonly { id: string; alive: boolean }[]
): string | undefined {
  const bound = sessions.find(
    (s) => s.alive && !!s.sessionId && binding.sessionIds.includes(s.sessionId)
  )?.tabId
  if (bound) return bound
  const tabId = opened[binding.id]
  return tabId && tabs.some((t) => t.id === tabId && t.alive) ? tabId : undefined
}

export function conductorOfTab(
  bindings: readonly ConductorBinding[],
  sessions: readonly SessionInfo[],
  opened: Record<string, string>,
  tabs: readonly { id: string; alive: boolean }[],
  tabId: string
): ConductorBinding | undefined {
  return bindings.find((b) => conductorTab(b, sessions, opened, tabs) === tabId)
}

export function conductorNotesWorkspace(binding: ConductorBinding): string | null {
  return binding.scope === GLOBAL_SCOPE || isRemoteKey(binding.scope) ? null : binding.scope
}

export function conductorsNeedYou(n: number): string {
  return n > 1 ? `${n} conductors need you` : '1 conductor needs you'
}
