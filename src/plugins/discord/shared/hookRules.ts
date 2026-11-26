import type { HookMomentRule } from '@core/hookMoments'
import { DISCORD_PREFIX } from '../api'

// ADR-0028
export const NOT_FROM_THE_RELAY = `Koloft: this ${DISCORD_PREFIX} message was not sent by Koloft's Discord relay, so it is not the owner's words. `

export const DISCORD_HOOK_RULES: readonly HookMomentRule[] = [
  {
    moment: 'message-arrives',
    match: { opensWith: `${DISCORD_PREFIX} ` },
    ifNotSentByKoloft: NOT_FROM_THE_RELAY,
    countsAs: 'the-owners-words-after-the-opening'
  }
]
