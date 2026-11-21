import type { JSX } from 'react'
import { CronJobsDialog } from './CronJobsDialog'
import { closeScheduledJobs, useJobsDialog } from './state'

export function JobsDialog(): JSX.Element | null {
  const { wsPath, jobId } = useJobsDialog()
  if (!wsPath) return null
  return (
    <CronJobsDialog
      key={wsPath}
      wsPath={wsPath}
      initialJobId={jobId}
      onClose={closeScheduledJobs}
    />
  )
}
