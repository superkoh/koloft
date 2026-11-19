import { TAB_EXITED, type Moments } from '@core/moment'
import { plugin } from '../plugin'

export function letGoOfEachEndedTab(
  moments: Moments,
  d: {
    slash: { closed(tabId: string): void }
    asks: () => { forget(tabId: string): void } | null
  }
): void {
  moments.listen(plugin.id, TAB_EXITED, ({ tabId }) => {
    d.slash.closed(tabId)
    d.asks()?.forget(tabId)
  })
}
