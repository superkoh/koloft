import type { AccountMeta, SessionInfo, Settings, WorkspaceRows } from '@shared/types'

export function everyWorkspaceRows(s: {
  workspaceRows: WorkspaceRows[]
  butlerWorkspace: WorkspaceRows | null
}): WorkspaceRows[] {
  return s.butlerWorkspace ? [...s.workspaceRows, s.butlerWorkspace] : s.workspaceRows
}

export function butlerSetUp(s: {
  accounts: readonly AccountMeta[] | null
  settings: Pick<Settings, 'accounts' | 'skipPermissions' | 'skipPermissionsAgreed' | 'discord'>
}): boolean {
  if (s.settings.discord.channel) return true
  const hasAnAccount = (s.accounts ?? s.settings.accounts).length > 0
  const answeredSkippingPermissions =
    !s.settings.skipPermissions || s.settings.skipPermissionsAgreed
  return answeredSkippingPermissions && hasAnAccount
}

type TabState = { id: string; alive: boolean; asleep?: true }

export function butlerTabOf(
  sessions: readonly SessionInfo[],
  opened: string | null,
  tabs: readonly TabState[]
): string | undefined {
  const bound = sessions.find((s) => s.alive && s.butler)?.tabId
  if (bound) return bound
  return opened && tabs.some((t) => t.id === opened && (t.alive || t.asleep)) ? opened : undefined
}

export function isButlerTab(
  sessions: readonly SessionInfo[],
  opened: string | null,
  tabId: string
): boolean {
  return !!sessions.find((s) => s.tabId === tabId)?.butler || opened === tabId
}
