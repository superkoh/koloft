import type { AssistTaskRow, SessionInfo, Settings } from '@shared/types'
import { GLOBAL_SCOPE } from '@shared/conductors'

type TabState = { id: string; alive: boolean; asleep?: true }

export function conductorTab(
  scope: string,
  sessions: readonly SessionInfo[],
  opened: Record<string, string>,
  tabs: readonly TabState[]
): string | undefined {
  const bound = sessions.find((s) => s.alive && s.conductor === scope && !s.assistTask)?.tabId
  if (bound) return bound
  const tabId = opened[scope]
  return tabId && tabs.some((t) => t.id === tabId && (t.alive || t.asleep)) ? tabId : undefined
}

export function conductorOfTab(
  sessions: readonly SessionInfo[],
  opened: Record<string, string>,
  tasks: readonly AssistTaskRow[],
  tabId: string
): string | undefined {
  return (
    sessions.find((s) => s.tabId === tabId)?.conductor ??
    tasks.find((t) => t.tabId === tabId)?.scope ??
    Object.keys(opened).find((scope) => opened[scope] === tabId)
  )
}

export function assistScopes(
  settings: Pick<Settings, 'assist' | 'discord' | 'assistSessions'>
): string[] {
  const talked = settings.assist?.on ? settings.assistSessions.map((r) => r.scope) : []
  return [...new Set([GLOBAL_SCOPE, ...settings.discord.bindings.map((b) => b.scope), ...talked])]
}

export function conductorsNeedYou(n: number): string {
  return n > 1 ? `${n} Assists need you` : '1 Assist needs you'
}
