import { fill, type PluginUi } from '@core/ui'
import {
  PALETTE_RUN,
  ROW_MARK,
  STARTED_BEFORE_EXIT,
  WINDOW_FEED,
  WORKSPACE_LINE,
  WORKSPACE_MENU,
  WORKSPACE_REMOVAL_LOSS
} from '@renderer/slots'
import { SCHEDULED_JOBS, SCHEDULED_JOBS_DIALOG, SCHEDULED_JOBS_LABEL } from '../plugin'
import { JobsDialog } from './JobsDialog'
import { CronMark, NextJobLine, useJobMarkOf, useNextJobClock } from './sidebarMarks'
import { feedCron, jobsLost, openScheduledJobs, runStartedBeforeExit } from './state'

export const ui: PluginUi = {
  parts: { [SCHEDULED_JOBS_DIALOG]: JobsDialog },
  fills: [
    fill(WINDOW_FEED, feedCron),
    fill(STARTED_BEFORE_EXIT, runStartedBeforeExit),
    fill(WORKSPACE_REMOVAL_LOSS, jobsLost),
    fill(ROW_MARK, { at: 'title', useMarkOf: useJobMarkOf, Mark: CronMark }),
    fill(WORKSPACE_LINE, { useWatch: useNextJobClock, Line: NextJobLine }),
    fill(WORKSPACE_MENU, {
      label: SCHEDULED_JOBS_LABEL,
      run: (wsPath) => openScheduledJobs(wsPath)
    }),
    fill(PALETTE_RUN, {
      key: SCHEDULED_JOBS,
      run: (currentWs) => {
        if (currentWs) openScheduledJobs(currentWs)
      },
      disabled: (currentWs) => !currentWs
    })
  ]
}
