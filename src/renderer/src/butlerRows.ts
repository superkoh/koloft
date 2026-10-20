import type { AssistSetting, ConductorBinding, SessionInfo, WorkspaceRows } from '@shared/types'

export function everyWorkspaceRows(s: {
  workspaceRows: WorkspaceRows[]
  butlerWorkspace: WorkspaceRows | null
}): WorkspaceRows[] {
  return s.butlerWorkspace ? [...s.workspaceRows, s.butlerWorkspace] : s.workspaceRows
}

export function butlerSetUp(s: {
  assist: AssistSetting
  binding: ConductorBinding | undefined
}): boolean {
  return s.assist !== null || !!s.binding
}

type TabState = { id: string; alive: boolean; asleep?: true }

export function butlerTabOf(
  sessions: readonly SessionInfo[],
  opened: string | null,
  tabs: readonly TabState[]
): string | undefined {
  const bound = sessions.find((s) => s.alive && s.conductor)?.tabId
  if (bound) return bound
  return opened && tabs.some((t) => t.id === opened && (t.alive || t.asleep)) ? opened : undefined
}

export function isButlerTab(
  sessions: readonly SessionInfo[],
  opened: string | null,
  tabId: string
): boolean {
  return !!sessions.find((s) => s.tabId === tabId)?.conductor || opened === tabId
}
