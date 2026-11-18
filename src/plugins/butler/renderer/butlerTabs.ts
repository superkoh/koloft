import type { AccountMeta, SessionInfo, Settings } from '@shared/types'
import { fillsOf } from '@renderer/pluginUi'
import { ROW_SET_UP } from '@renderer/slots'
import { BUTLER_ROW_PART } from '../plugin'

export function butlerSetUp(s: {
  accounts: readonly AccountMeta[] | null
  settings: Settings
}): boolean {
  if (fillsOf(ROW_SET_UP).some((f) => f.row === BUTLER_ROW_PART && f.setUp(s.settings))) return true
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
