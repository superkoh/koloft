import { create } from 'zustand'
import type { WorkspaceRemovalLoss } from '@renderer/slots'
import type { CronState } from '@shared/types'

interface JobsDialog {
  wsPath: string | null
  jobId?: string
}

export const useJobsDialog = create<JobsDialog>(() => ({ wsPath: null }))

export const openScheduledJobs = (wsPath: string, jobId?: string): void =>
  useJobsDialog.setState({ wsPath, jobId })

export const closeScheduledJobs = (): void => useJobsDialog.setState({ wsPath: null })

export const useCron = create<CronState>(() => ({ jobs: [], live: [], folders: {}, notes: {} }))

export const setCron = (s: CronState): void => useCron.setState(s, true)

const tabsWhoseRunStarted = new Set<string>()

export function runStartedBeforeExit(tabId: string): boolean {
  return tabsWhoseRunStarted.delete(tabId)
}

export function feedCron(adopted: Promise<void>): () => void {
  let pushed = false
  const offState = window.api.cron.onState((s) => {
    pushed = true
    setCron(s)
  })
  const offRunStarted = window.api.cron.onRunStarted(({ tabId, started }) => {
    if (started) tabsWhoseRunStarted.add(tabId)
    else tabsWhoseRunStarted.delete(tabId)
  })
  void adopted.then(() =>
    window.api.cron
      .list()
      .then((s) => {
        if (!pushed) setCron(s)
      })
      .catch(() => {})
  )
  return () => {
    offState()
    offRunStarted()
  }
}

export const jobsLost: WorkspaceRemovalLoss = {
  countIn: (wsPath) => useCron.getState().jobs.filter((j) => j.workspacePath === wsPath).length,
  willGo: (n) => `${n} scheduled job${n === 1 ? '' : 's'} will be deleted`,
  goneForGood: 'Jobs do not come back.'
}
