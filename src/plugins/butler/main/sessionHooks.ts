import {
  SESSION_STARTING,
  TAB_EXITED,
  TAB_FORGOTTEN,
  TAB_TORN_DOWN,
  type MadeLater,
  type Moments
} from '@core/moment'
import { BUTLER_SAYS_OPENING, ownerSays } from '@shared/agentGuide'
import { plugin } from '../plugin'

export function tellEachHelperItsRole(moments: Moments, role: () => string): void {
  moments.listen(plugin.id, SESSION_STARTING, async ({ helper }) => (helper ? role() : undefined))
}

export function butlerLetsGoOfEndedTabs(
  moments: Moments,
  d: {
    butler: MadeLater<{ onPtyExit(tabId: string): void }>
    digest: MadeLater<{ forget(tabId: string): void }>
  }
): void {
  moments.listen(plugin.id, TAB_EXITED, ({ tabId }) => d.digest()?.forget(tabId))
  moments.listen(plugin.id, TAB_TORN_DOWN, ({ tabId }) => d.butler()?.onPtyExit(tabId))
  moments.listen(plugin.id, TAB_FORGOTTEN, (tabId) => d.butler()?.onPtyExit(tabId))
}

export const butlersWords = {
  says: ownerSays,
  wrote: (said: string): boolean => said.startsWith(BUTLER_SAYS_OPENING)
}
