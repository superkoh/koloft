import {
  TAB_TORN_DOWN,
  type AgentExit,
  type LeftTab,
  type MadeLater,
  type Moments
} from '@core/moment'
import { plugin } from '../plugin'

export function closeOutEachEndedRun(
  moments: Moments,
  runner: MadeLater<{ onPtyExit(tabId: string, left?: LeftTab, exit?: AgentExit): void }>
): void {
  moments.listen(plugin.id, TAB_TORN_DOWN, ({ tabId, left, ...exit }) =>
    runner()?.onPtyExit(tabId, left, exit)
  )
}
