import { QUESTION_ASKED, SESSION_BOUND, TURN_ENDED, type Moments } from '@core/moment'
import { plugin } from '../plugin'

export function cardEachTurnAndQuestion(
  moments: Moments,
  d: {
    inbox: {
      turnEnded(tabId: string, reply: string, handedOff: boolean): void
      asked(tabId: string): void
      rebound(oldRef: string, newKey: string): void
    }
    tookTheTurn(tabId: string): boolean
  }
): void {
  moments.listen(plugin.id, TURN_ENDED, ({ tabId, turn }) =>
    d.inbox.turnEnded(tabId, turn.reply, d.tookTheTurn(tabId))
  )
  moments.listen(plugin.id, QUESTION_ASKED, ({ tabId }) => d.inbox.asked(tabId))
  moments.listen(plugin.id, SESSION_BOUND, ({ tabId, key }) => d.inbox.rebound(tabId, key))
}
