import { TAB_EXITED, type Moments } from '@core/moment'
import { plugin } from '../plugin'

export function letGoOfEachEndedTab(
  moments: Moments,
  asks: () => { forget(tabId: string): void } | null
): void {
  moments.listen(plugin.id, TAB_EXITED, ({ tabId }) => asks()?.forget(tabId))
}
