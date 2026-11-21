import {
  SESSION_BOUND,
  STATE_CHANGED,
  TAB_TORN_DOWN,
  type AgentExit,
  type LeftTab,
  type MadeLater,
  type Moments,
  type StateChanged
} from '@core/moment'
import { plugin } from '../plugin'
import type { RunStartedNews } from '../shared/ipc'

export function followEachRun(
  moments: Moments,
  runner: MadeLater<{
    onPtyExit(tabId: string, left?: LeftTab, exit?: AgentExit): void
    onBound(tabId: string, sessionId: string): void
    onStatus(tabId: string, prev: StateChanged['prev'], next: StateChanged['next']): void
    runStartedIn(tabId: string): boolean
  }>,
  tellWindow: (news: RunStartedNews) => void
): void {
  moments.listen(plugin.id, SESSION_BOUND, ({ tabId, key }) => runner()?.onBound(tabId, key))
  // ADR-0022
  moments.listen(plugin.id, STATE_CHANGED, ({ tabId, prev, next }) =>
    runner()?.onStatus(tabId, prev, next)
  )
  moments.listen(plugin.id, TAB_TORN_DOWN, ({ tabId, left, ...exit }) => {
    if (exit.unexpected) tellWindow({ tabId, started: !!runner()?.runStartedIn(tabId) })
    runner()?.onPtyExit(tabId, left, exit)
  })
}
