import { fill, type PluginUi } from '@core/ui'
import { PALETTE_RUN, ROW_MARK, WORKSPACE_LINE, WORKSPACE_MENU } from '@renderer/slots'
import { SCHEDULED_JOBS, SCHEDULED_JOBS_DIALOG } from '../plugin'
import { JobsDialog } from './JobsDialog'
import { CronMark, NextJobLine, useJobMarkOf, useNextJobClock } from './sidebarMarks'
import { openScheduledJobs } from './state'

export const ui: PluginUi = {
  parts: { [SCHEDULED_JOBS_DIALOG]: JobsDialog },
  fills: [
    fill(ROW_MARK, { at: 'title', useMarkOf: useJobMarkOf, Mark: CronMark }),
    fill(WORKSPACE_LINE, { useWatch: useNextJobClock, Line: NextJobLine }),
    fill(WORKSPACE_MENU, { label: 'Scheduled jobs…', run: (wsPath) => openScheduledJobs(wsPath) }),
    fill(PALETTE_RUN, {
      key: SCHEDULED_JOBS,
      run: (currentWs) => {
        if (currentWs) openScheduledJobs(currentWs)
      },
      disabled: (currentWs) => !currentWs
    })
  ]
}
