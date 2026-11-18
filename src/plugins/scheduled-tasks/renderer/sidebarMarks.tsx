import { useEffect, useState, type JSX } from 'react'
import { IconScheduled } from '@renderer/icons'
import { forecastFor, type Forecast } from './cronForm'
import { slugOf } from '@shared/cronNames'
import { describeWhen } from '@shared/schedule'
import { capabilitiesFor } from '@shared/sessionBackend'
import type { CronState, SessionRow } from '@shared/types'

const CRON_BADGE_MS = 30_000

export function useNextJobClock(cron: CronState): void {
  const [, bumpCronClock] = useState(0)
  const showsAClock = cron.jobs.length > 0
  useEffect(() => {
    if (!showsAClock) return
    const t = setInterval(() => bumpCronClock((n) => n + 1), CRON_BADGE_MS)
    return () => clearInterval(t)
  }, [showsAClock])
}

export const CronMark = (): JSX.Element => (
  <span className="ws-tab-cron" title="started by a scheduled job">
    <IconScheduled size={12} />
  </span>
)

export function startedByAJob(
  cron: CronState
): (wsPath: string, row: SessionRow, tabId: string | undefined) => boolean {
  const liveTabs = new Set(cron.live.map((l) => l.tabId))
  const liveSessions = new Set(cron.live.map((l) => l.sessionId))
  const worktreePrefixes = new Map<string, string[]>()
  for (const j of cron.jobs) {
    const list = worktreePrefixes.get(j.workspacePath) ?? []
    list.push(slugOf(j.name) + '-')
    worktreePrefixes.set(j.workspacePath, list)
  }
  return (wsPath, row, tabId) =>
    capabilitiesFor(row.backendId, row.host).scheduledTasks === true &&
    ((!!tabId && liveTabs.has(tabId)) ||
      liveSessions.has(row.id) ||
      (row.worktree !== 'main' &&
        (worktreePrefixes.get(wsPath) ?? []).some((p) => row.worktree.startsWith(p))))
}

export const nextJobIn = (cron: CronState, wsPath: string, now: Date): Forecast | null =>
  forecastFor(cron.jobs, cron.live, wsPath, now)

export function NextJobLine({
  soon,
  now,
  onOpen
}: {
  soon: Forecast
  now: Date
  onOpen: () => void
}): JSX.Element {
  return (
    <div
      className="ws-next"
      title={soon.title}
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
    >
      <IconScheduled size={12} className="ws-next-ico" />
      <span className="ws-next-name">{soon.name}</span>
      {soon.more > 0 && <span className="ws-next-more">{`+${soon.more}`}</span>}
      <span className="ws-next-dot">·</span>
      <span className={'ws-next-at' + (soon.soon ? ' soon' : '')}>
        {describeWhen(soon.at, now)}
      </span>
    </div>
  )
}
