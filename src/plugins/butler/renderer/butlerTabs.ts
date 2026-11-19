import type { AccountMeta, SessionInfo, Settings, WorkspaceRows } from '@shared/types'
import { fillsOf } from '@renderer/pluginUi'
import { ROW_SET_UP, type RowSetUpFill } from '@renderer/slots'
import { BUTLER_ROW_PART, plugin } from '../plugin'

const setUpElsewhere = (settings: Settings): readonly RowSetUpFill['setUp'][] =>
  fillsOf(ROW_SET_UP, settings)
    .filter((f) => f.row === BUTLER_ROW_PART)
    .map((f) => f.setUp)

export function butlerSetUp(s: {
  accounts: readonly AccountMeta[] | null
  settings: Settings
}): boolean {
  if (setUpElsewhere(s.settings).some((setUp) => setUp(s.settings))) return true
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
  const bound = sessions.find((s) => s.alive && s.overseer)?.tabId
  if (bound) return bound
  return opened && tabs.some((t) => t.id === opened && (t.alive || t.asleep)) ? opened : undefined
}

export function isButlerTab(
  sessions: readonly SessionInfo[],
  opened: string | null,
  tabId: string
): boolean {
  return !!sessions.find((s) => s.tabId === tabId)?.overseer || opened === tabId
}

export const isButlersWorkspace = (w: WorkspaceRows): boolean => w.workspace.claim?.by === plugin.id
