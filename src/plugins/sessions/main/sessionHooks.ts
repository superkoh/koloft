import {
  DIALOG_CLOSED,
  QUESTION_ASKED,
  SESSION_BOUND,
  STATE_CHANGED,
  TAB_EXITED,
  TOOL_DONE,
  TURN_ENDED,
  TURN_OVER,
  TURN_STARTED,
  type MadeLater,
  type Moments,
  type StateChanged,
  type Turn
} from '@core/moment'
import { plugin } from '../plugin'
import type { SessionAsks } from './sessionAsks'
import type { SlashCommands } from './slashCommands'
import type { NewsJudge } from './turnNews'

export function forgetAsksOfEndedTabs(
  moments: Moments,
  d: {
    slash: { closed(tabId: string): void }
    asks: MadeLater<{ forget(tabId: string): void }>
    instructionAsks: MadeLater<{ forget(tabId: string): void }>
  }
): void {
  moments.listen(plugin.id, TAB_EXITED, ({ tabId }) => d.slash.closed(tabId))
  moments.listen(plugin.id, TAB_EXITED, ({ tabId }) => d.asks()?.forget(tabId))
  moments.listen(plugin.id, TAB_EXITED, ({ tabId }) => d.instructionAsks()?.forget(tabId))
}

export interface TurnParts {
  judge: Pick<NewsJudge, 'turnEnded' | 'prompted'>
  slash: Pick<SlashCommands, 'turnEnded' | 'bound'>
  replies: { turnEnded(tabId: string, turn: Turn): boolean }
  asks: MadeLater<Pick<SessionAsks, 'onAsk'>>
  askBeforeAsksAreMade(tabId: string): void
  askAsItsAgentGaveIt(tabId: string): Parameters<SessionAsks['onAsk']>[1] | undefined
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
  moments.listen(plugin.id, QUESTION_ASKED, ({ tabId }) => {
    const asks = d.asks()
    if (!asks) return d.askBeforeAsksAreMade(tabId)
    const given = d.askAsItsAgentGaveIt(tabId)
    if (given) asks.onAsk(tabId, given)
  })
  moments.listen(plugin.id, SESSION_BOUND, ({ tabId, key }) => d.slash.bound(tabId, key))
  return { tookTheTurn: (tabId) => taken.has(tabId) }
}

export function followEachState(
  moments: Moments,
  d: {
    asks: MadeLater<Pick<SessionAsks, 'dialogGone' | 'toolDone'>>
    slash: Pick<SlashCommands, 'turnOver'>
    attention: { stateChanged(edge: StateChanged): void }
  }
): void {
  moments.listen(plugin.id, STATE_CHANGED, ({ tabId, prev }) => {
    if (prev === 'approval') d.asks()?.dialogGone(tabId, false)
  })
  moments.listen(plugin.id, STATE_CHANGED, (edge) => d.attention.stateChanged(edge))
  moments.listen(plugin.id, TOOL_DONE, ({ tabId, call, endsTheAsk }) => {
    const asks = d.asks()
    if (endsTheAsk) asks?.dialogGone(tabId, false)
    asks?.toolDone(tabId, call)
  })
  moments.listen(plugin.id, TURN_OVER, ({ tabId, over }) => d.slash.turnOver(tabId, over))
  moments.listen(plugin.id, DIALOG_CLOSED, (tabId) => d.asks()?.dialogGone(tabId, true))
}
