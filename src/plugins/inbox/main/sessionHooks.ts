import {
  ATTENTION_CHANGED,
  QUESTION_ASKED,
  SESSION_BOUND,
  TURN_ENDED,
  type Moments
} from '@core/moment'
import { plugin } from '../plugin'

const AFTER_SESSIONS_CORE_DECIDED_WHO_TOOK_THE_TURN = ['sessions']

export function cardEachTurnAndQuestion(
  moments: Moments,
  d: {
    inbox: {
      turnEnded(tabId: string, reply: string, handedOff: boolean): void
      asked(tabId: string): void
      rebound(oldRef: string, newKey: string): void
      sync(): void
    }
    tookTheTurn(tabId: string): boolean
  }
): void {
  moments.listen(
    plugin.id,
    TURN_ENDED,
    ({ tabId, turn }) => d.inbox.turnEnded(tabId, turn.reply, d.tookTheTurn(tabId)),
    AFTER_SESSIONS_CORE_DECIDED_WHO_TOOK_THE_TURN
  )
  moments.listen(plugin.id, QUESTION_ASKED, ({ tabId }) => d.inbox.asked(tabId))
  moments.listen(plugin.id, SESSION_BOUND, ({ tabId, key }) => d.inbox.rebound(tabId, key))
  moments.listen(plugin.id, ATTENTION_CHANGED, () => d.inbox.sync())
}
