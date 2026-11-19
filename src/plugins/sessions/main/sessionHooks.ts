import { TAB_EXITED, type MadeLater, type Moments } from '@core/moment'
import { plugin } from '../plugin'

export function forgetAsksOfEndedTabs(
  moments: Moments,
  d: {
    slash: { closed(tabId: string): void }
    asks: MadeLater<{ forget(tabId: string): void }>
  }
): void {
  moments.listen(plugin.id, TAB_EXITED, ({ tabId }) => d.slash.closed(tabId))
  moments.listen(plugin.id, TAB_EXITED, ({ tabId }) => d.asks()?.forget(tabId))
}
