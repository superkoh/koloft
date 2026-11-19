import { create } from 'zustand'

interface JobsDialog {
  wsPath: string | null
  jobId?: string
}

export const useJobsDialog = create<JobsDialog>(() => ({ wsPath: null }))

export const openScheduledJobs = (wsPath: string, jobId?: string): void =>
  useJobsDialog.setState({ wsPath, jobId })

export const closeScheduledJobs = (): void => useJobsDialog.setState({ wsPath: null })
