import { TAB_STOPPING, type Moments } from '@core/moment'
import { plugin } from '../plugin'
import { relayTabClosed } from './cdpRelay'

export function closeEachStoppingTabsEndpoint(moments: Moments): void {
  moments.listen(plugin.id, TAB_STOPPING, ({ tabId }) => relayTabClosed(tabId))
}
