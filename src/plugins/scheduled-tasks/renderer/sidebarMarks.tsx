import { useEffect, useState, type JSX } from 'react'
import { IconScheduled } from '@renderer/icons'
import type { MarkOf } from '@renderer/slots'
import { forecastFor, type Forecast } from './cronForm'
import { openScheduledJobs, useCron } from './state'
import { slugOf } from '@shared/cronNames'
import { describeWhen } from '@shared/schedule'
import { capabilitiesFor } from '@shared/sessionBackend'
import type { CronState, SessionRow } from '@shared/types'

const CRON_BADGE_MS = 30_000
const A_JOB_STARTED_IT = 'job'

export function useNextJobClock(): void {
  const showsAClock = useCron((s) => s.jobs.length > 0)
  const [, bumpCronClock] = useState(0)
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

export function useJobMarkOf(): MarkOf {
  const started = startedByAJob(useCron())
  return (wsPath, row, tabId) => (started(wsPath, row, tabId) ? A_JOB_STARTED_IT : undefined)
}

const nextJobIn = (cron: CronState, wsPath: string, now: Date): Forecast | null =>
  forecastFor(cron.jobs, cron.live, wsPath, now)

export function NextJobLine({
  wsPath,
  now,
  dismissMenu
}: {
  wsPath: string
  now: Date
  dismissMenu: () => void
}): JSX.Element | null {
  const cron = useCron()
  const soon = nextJobIn(cron, wsPath, now)
  if (!soon) return null
  return (
    <div
      className="ws-next"
      title={soon.title}
      onClick={(e) => {
        e.stopPropagation()
        dismissMenu()
        openScheduledJobs(wsPath, soon.id)
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
