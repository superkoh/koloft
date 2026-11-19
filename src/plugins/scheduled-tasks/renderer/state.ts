import { create } from 'zustand'
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

export function feedCron(adopted: Promise<void>): () => void {
  let pushed = false
  const off = window.api.cron.onState((s) => {
    pushed = true
    setCron(s)
  })
  void adopted.then(() =>
    window.api.cron
      .list()
      .then((s) => {
        if (!pushed) setCron(s)
      })
      .catch(() => {})
  )
  return off
}

export const jobsIn = (wsPath: string): number =>
  useCron.getState().jobs.filter((j) => j.workspacePath === wsPath).length

export const jobsWillGo = (n: number): string =>
  `${n} scheduled job${n === 1 ? '' : 's'} will be deleted`

export const JOBS_GONE_FOR_GOOD = 'Jobs do not come back.'
