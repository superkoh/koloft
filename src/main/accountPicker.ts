import type { AccountView, BackendId, SessionInfo } from '@shared/types'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import { homeRoom } from '@shared/accountUsage'
import { EPS } from './usageProbe'

export const SCORE_PER_LIVE_SESSION = 2 * EPS

export type LaunchedSession = Pick<SessionInfo, 'tabId' | 'account' | 'status'>

export function liveSessionsPerAccount(
  sessions: LaunchedSession[],
  exceptTab: string | undefined
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const s of sessions) {
    if (!s.account || s.tabId === exceptTab || s.status === 'idle') continue
    const key = s.account.toLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

export function allLimitedNotice(a: AccountView, backend: BackendId): string | undefined {
  const room = homeRoom(a, Math.floor(Date.now() / 1000))
  if (!room?.walled) return undefined
  const agent = BACKEND_LABEL[backend]
  return `Every ${agent} account is at its limit, so ${agent} runs on ${a.name}, the first to reset (${fmtReset(room.backAt)}).`
}

export function fmtReset(epoch: number): string {
  if (epoch <= 0) return '?'
  const d = new Date(epoch * 1000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

export function soonest<T>(list: T[], backAt: (item: T) => number): T {
  return list.reduce((best, item) => (backAt(item) < backAt(best) ? item : best))
}
