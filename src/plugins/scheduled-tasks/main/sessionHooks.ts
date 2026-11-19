import { TAB_TORN_DOWN, type Moments, type TabEnded } from '@core/moment'
import { plugin } from '../plugin'

export interface EndsRuns {
  onPtyExit(
    tabId: string,
    left: TabEnded['left'],
    exit: Pick<TabEnded, 'exitCode' | 'signal' | 'unexpected'>
  ): void
}

export function closeOutEachEndedRun(moments: Moments, runner: () => EndsRuns | null): void {
  moments.listen(plugin.id, TAB_TORN_DOWN, ({ tabId, left, ...exit }) =>
    runner()?.onPtyExit(tabId, left, exit)
  )
}
