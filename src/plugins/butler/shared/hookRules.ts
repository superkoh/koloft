import type { HookMomentRule } from '@core/hookMoments'
import { BUTLER_SAYS_OPENING } from '@shared/koloftOpenings'
import { OWNER_ASLEEP_FILE } from '@core/presence'
import { FROM_KOLOFT, NOT_SENT_BY_KOLOFT } from '@plugins/sessions/windowApi'

export const OWNER_ASLEEP_PUSH = `${FROM_KOLOFT}The owner is asleep: until they write to you themself, they cannot answer, approve or check anything. Do not stop to wait for them. If there is more you can do toward your task, do it now: where you would ask the owner, choose what you would recommend and note the choice in your report. Leave for the owner only what cannot be undone (merging, releasing, pushing to main, deleting on GitHub, spending money, accounts and passwords) and go on with the rest. If the task is done, or you truly cannot go on, end your turn and say plainly what is left and what the owner must do.`

export const BUTLER_HOOK_RULES: readonly HookMomentRule[] = [
  {
    moment: 'message-arrives',
    match: { opensWith: BUTLER_SAYS_OPENING },
    ifNotSentByKoloft: NOT_SENT_BY_KOLOFT,
    countsAs: 'not-the-owners-words'
  },
  {
    moment: 'turn-about-to-end',
    whileSwitchIsOn: OWNER_ASLEEP_FILE,
    say: OWNER_ASLEEP_PUSH
  }
]
