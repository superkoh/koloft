import type { SessionInfo } from '@shared/types'

export function browserOpenTargetSession(
  sessions: SessionInfo[],
  request: { tabId: string; source: 'agent' | 'user' },
  activeTabId?: string | null
): SessionInfo | undefined {
  const bound = sessions.find((s) => s.tabId === request.tabId && s.sessionId)
  if (bound || request.source !== 'user') return bound
  const live = (s: SessionInfo): boolean => !!(s.alive && s.sessionId)
  return sessions.find((s) => s.tabId === activeTabId && live(s)) ?? sessions.find(live)
}

export function overlayPresentation(
  request: { tabId: string },
  tabs: { id: string }[],
  sessions: SessionInfo[]
): 'now' | 'background' {
  const stillOpen = tabs.some((t) => t.id === request.tabId)
  const isSession = sessions.some((s) => s.tabId === request.tabId)
  return stillOpen && !isSession ? 'now' : 'background'
}
