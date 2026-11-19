import {
  QUESTION_ASKED,
  SESSION_BOUND,
  TAB_EXITED,
  TURN_ENDED,
  TURN_STARTED,
  type MadeLater,
  type Moments
} from '@core/moment'
import type { Turn } from '@core/moment'
import { plugin } from '../plugin'
import type { SessionAsks } from './sessionAsks'
import type { SlashCommands } from './slashCommands'
import type { NewsJudge } from './turnNews'

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

export interface TurnParts {
  judge: Pick<NewsJudge, 'turnEnded' | 'prompted'>
  slash: Pick<SlashCommands, 'turnEnded' | 'bound'>
  replies: { turnEnded(tabId: string, turn: Turn): boolean }
  asks: MadeLater<Pick<SessionAsks, 'onAsk'>>
  askBeforeAsksAreMade(tabId: string): void
}

export function followEachTurn(
  moments: Moments,
  d: TurnParts
): { tookTheTurn(tabId: string): boolean } {
  const taken = new Set<string>()
  moments.listen(plugin.id, TURN_STARTED, (tabId) => d.judge.prompted(tabId))
  moments.listen(plugin.id, TURN_ENDED, ({ tabId, turn }) => d.judge.turnEnded(tabId, turn))
  moments.listen(plugin.id, TURN_ENDED, ({ tabId, turn }) => d.slash.turnEnded(tabId, turn))
  moments.listen(plugin.id, TURN_ENDED, ({ tabId, turn }) => {
    taken.delete(tabId)
    if (d.replies.turnEnded(tabId, turn)) taken.add(tabId)
  })
  moments.listen(plugin.id, TAB_EXITED, ({ tabId }) => taken.delete(tabId))
  moments.listen(plugin.id, QUESTION_ASKED, ({ tabId, ask }) => {
    const asks = d.asks()
    if (asks) asks.onAsk(tabId, ask)
    else d.askBeforeAsksAreMade(tabId)
  })
  moments.listen(plugin.id, SESSION_BOUND, ({ tabId, key }) => d.slash.bound(tabId, key))
  return { tookTheTurn: (tabId) => taken.has(tabId) }
}
