import { fill, type PluginUi } from '@core/ui'
import {
  PALETTE_RUN,
  ROW_MARK,
  WINDOW_FEED,
  WORKSPACE_LINE,
  WORKSPACE_MENU,
  WORKSPACE_REMOVAL_LOSS
} from '@renderer/slots'
import { SCHEDULED_JOBS, SCHEDULED_JOBS_DIALOG } from '../plugin'
import { JobsDialog } from './JobsDialog'
import { CronMark, NextJobLine, useJobMarkOf, useNextJobClock } from './sidebarMarks'
import { feedCron, jobsIn, jobsWillGo, JOBS_GONE_FOR_GOOD, openScheduledJobs } from './state'

export const ui: PluginUi = {
  parts: { [SCHEDULED_JOBS_DIALOG]: JobsDialog },
  fills: [
    fill(WINDOW_FEED, feedCron),
    fill(WORKSPACE_REMOVAL_LOSS, {
      countIn: jobsIn,
      willGo: jobsWillGo,
      goneForGood: JOBS_GONE_FOR_GOOD
    }),
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
