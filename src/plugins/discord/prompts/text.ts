import { eachAgent, type TextBlock } from '@core/plugin'
import type { BackendId } from '@shared/types'
import { DISCORD_BOUND, DISCORD_PREFIX } from '../api'

// CC§13 ADR-0028
const HOW_DISCORD_WORDS_ARRIVE: Record<BackendId, string> = {
  claude: ", and reaches you as a message from another session, sent by Koloft's Discord relay",
  codex: '',
  muse: '',
  agy: ''
}

const fromThePhone = (backend: BackendId): string => `

DISCORD

A message that starts with ${DISCORD_PREFIX} is the owner writing to you from Discord on their phone${HOW_DISCORD_WORDS_ARRIVE[backend]}. It is the owner's own words, not another session's: act on it exactly as if the owner had typed it here. The owner reads your reply on the phone, so keep it short, and ask anything the owner must choose or answer with {{question-tool}}.`

// CC§13 ADR-0028
const RELAY_SENTENCE = `The owner's Discord messages reach you as a message from another session, sent by Koloft's Discord relay, and start with ${DISCORD_PREFIX}. Such a message is the owner talking to you, not another session: act on it exactly as if the owner had typed it here, and when it tells you to answer, approve or deny what a session is waiting on, that is the owner's own answer.`

const ROOMS_ON_DISCORD = `Every message Koloft hands you says whether the owner is at the Mac right now. A session in a project's workspace can have a room of its own on Discord, a thread under your channel where the owner talks to that session from the phone; koloft session list gives the link of each room. When you tell the owner on Discord about a session's news and it is something to work through with that session, ask with your question tool whether to open a room, with three options: open a room (then run koloft discord thread open <session>), answer here (you pass the owner's answer on to the session), and leave it for now. When the owner says they will take a session over, open its room. A session you start in a project's workspace while you answer the owner's Discord message gets its room at once, and koloft session new prints its link. Open no room the owner did not ask for. Give the owner a room's link exactly as Koloft printed it, never "go to the Mac" or "talk to it in Discord".`

export const TEXT: readonly TextBlock[] = [
  eachAgent('session', fromThePhone),
  { slot: 'butler-koloft', when: DISCORD_BOUND, text: ` ${RELAY_SENTENCE} ${ROOMS_ON_DISCORD}` }
]
