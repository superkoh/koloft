import type { Moment, SessionStarting } from '@core/moment'
import { BUTLER_SAYS_OPENING, ownerSays } from '@shared/agentGuide'

export function tellEachHelperItsRole(
  sessionStarting: Moment<SessionStarting>,
  role: () => string
): void {
  sessionStarting.listen(async ({ helper }) => (helper ? role() : undefined))
}

export const butlersWords = {
  says: ownerSays,
  wrote: (said: string): boolean => said.startsWith(BUTLER_SAYS_OPENING)
}
