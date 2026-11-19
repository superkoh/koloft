import {
  SESSION_BOUND,
  SESSION_STARTING,
  TAB_EXITED,
  TAB_FORGOTTEN,
  TAB_TORN_DOWN,
  TURN_ENDED,
  TURN_STARTED,
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

export function butlerFollowsEachTurn(
  moments: Moments,
  d: {
    butler: MadeLater<{
      onBound(tabId: string, key: string): void
      isButlerTab(tabId: string): boolean
    }>
    digest: MadeLater<{
      turnEnded(tabId: string, reply: string, handedOff: boolean): void
      prompted(tabId: string): void
    }>
    tookTheTurn(tabId: string): boolean
    asleep: { awakeTabsChanged(): void }
    butlerTabChanged(): void
  }
): void {
  moments.listen(plugin.id, TURN_STARTED, (tabId) => d.digest()?.prompted(tabId))
  moments.listen(plugin.id, TURN_ENDED, ({ tabId, turn }) =>
    d.digest()?.turnEnded(tabId, turn.reply, d.tookTheTurn(tabId))
  )
  moments.listen(plugin.id, SESSION_BOUND, ({ tabId, key }) => {
    const butler = d.butler()
    butler?.onBound(tabId, key)
    if (!butler?.isButlerTab(tabId)) return
    d.asleep.awakeTabsChanged()
    d.butlerTabChanged()
  })
}

export const butlersWords = {
  says: ownerSays,
  wrote: (said: string): boolean => said.startsWith(BUTLER_SAYS_OPENING)
}
