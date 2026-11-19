import { TURN_ENDED, type Moments } from '@core/moment'
import type { Turn } from '@shared/turns'
import { plugin } from '../plugin'

export function pickDocsOfEachTurn(
  moments: Moments,
  docs: { turnEnded(tabId: string, turn: Turn): Promise<void> }
): void {
  moments.listen(plugin.id, TURN_ENDED, ({ tabId, turn }) => void docs.turnEnded(tabId, turn))
}
