import { TAB_EXITED, type MadeLater, type Moments } from '@core/moment'
import { plugin } from '../plugin'

export function forgetSecretAsksOfEndedTabs(
  moments: Moments,
  asks: MadeLater<{ forget(tabId: string): void }>
): void {
  moments.listen(plugin.id, TAB_EXITED, ({ tabId }) => asks()?.forget(tabId))
}
