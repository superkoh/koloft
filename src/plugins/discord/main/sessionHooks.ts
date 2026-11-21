import {
  DIALOG_CLOSED,
  SESSION_BOUND,
  SESSION_STARTED,
  STATE_CHANGED,
  STEP_LET_GO,
  TAB_EXITED,
  TOOL_DONE,
  TURN_ENDED,
  type MadeLater,
  type Moments,
  type SessionStarted
} from '@core/moment'
import type { Turn } from '@core/moment'
import { DISCORD_PREFIX } from '@plugins/discord/api'
import { plugin } from '../plugin'

const roomStarted = (link: string): string =>
  `The owner asked for it on Discord, so it has a room there, where the owner talks to it: ${link}. Give the owner that link exactly as written.`

export function giveEachStartedSessionARoom(
  moments: Moments,
  d: {
    isButler(tabId: string): boolean
    butlerFolder(): string
    roomFor(started: SessionStarted): Promise<string | undefined>
  }
): void {
  moments.listen(plugin.id, SESSION_STARTED, async (started) => {
    if (!d.isButler(started.by) || started.workspace === d.butlerFolder()) return undefined
    const link = await d.roomFor(started)
    return link ? roomStarted(link) : undefined
  })
}

interface ForgetsTabs {
  forget(tabId: string): void
}

export interface EndedTabParts {
  typing: MadeLater<ForgetsTabs>
  relay: MadeLater<ForgetsTabs>
  buttons: MadeLater<ForgetsTabs>
  rooms: MadeLater<ForgetsTabs & { stopped(tabId: string): void; closed(tabId: string): unknown }>
}

export function discordFollowsEachTurn<Ask>(
  moments: Moments,
  d: {
    relay: MadeLater<{
      turnEnded(tabId: string, turn: Turn): void
      stoppedAsking(tabId: string): void
      codexAsked(tabId: string, ask: Ask): void
      askLetGo(tabId: string): void
    }>
    typing: MadeLater<{ refresh(tabId: string): void }>
    rooms: MadeLater<{
      bound(tabId: string, key: string, newConversation: () => Promise<boolean>): Promise<void>
    }>
    buttons: MadeLater<{ check(tabId: string): Promise<void> }>
    noTurnsYet(key: string): Promise<boolean>
    askChannelOf(tabId: string): string | undefined
    pendingAskOf(tabId: string): Promise<Ask | undefined>
    askUnreadablySoon(tabId: string): void
  }
): void {
  moments.listen(plugin.id, TURN_ENDED, ({ tabId, turn }) => d.relay()?.turnEnded(tabId, turn))
  moments.listen(plugin.id, SESSION_BOUND, ({ tabId }) => d.typing()?.refresh(tabId))
  moments.listen(
    plugin.id,
    SESSION_BOUND,
    ({ tabId, key, idleCompaction }) =>
      void d.rooms()?.bound(tabId, key, async () => !idleCompaction && (await d.noTurnsYet(key))),
    [],
    ROOMS_FOLLOW_A_NEW_CONVERSATION_WHILE_DISCORD_IS_OFF
  )
  moments.listen(plugin.id, STATE_CHANGED, ({ tabId, next }) => {
    const asksOnDiscord = !!d.askChannelOf(tabId)
    if (next !== 'approval') d.relay()?.stoppedAsking(tabId)
    if (asksOnDiscord && (next === 'approval' || next === 'waiting'))
      void d.pendingAskOf(tabId).then((ask) => {
        if (ask) return d.relay()?.codexAsked(tabId, ask)
        if (next === 'approval') d.askUnreadablySoon(tabId)
      })
    if (asksOnDiscord) void d.buttons()?.check(tabId)
    d.typing()?.refresh(tabId)
  })
  moments.listen(plugin.id, TOOL_DONE, ({ tabId }) => void d.buttons()?.check(tabId))
  moments.listen(plugin.id, DIALOG_CLOSED, (tabId) => void d.buttons()?.check(tabId))
  moments.listen(plugin.id, STEP_LET_GO, (tabId) => d.relay()?.askLetGo(tabId))
}

export function discordTakesTheTurnsItCarries(d: {
  steps: { hold(holder: { claims(tabId: string, step: string): 'take' | undefined }): void }
  carriedOnDiscord(tabId: string): boolean
}): void {
  d.steps.hold({
    claims: (tabId, step) =>
      step === 'turn-done' && d.carriedOnDiscord(tabId) ? 'take' : undefined
  })
}

export function closeRoomsOfEndedTabs(moments: Moments, d: EndedTabParts): void {
  for (const part of [d.typing, d.relay, d.buttons])
    moments.listen(plugin.id, TAB_EXITED, ({ tabId }) => part()?.forget(tabId))
  moments.listen(
    plugin.id,
    TAB_EXITED,
    ({ tabId, sessionGoesOn, unexpected }) => {
      const rooms = d.rooms()
      if (sessionGoesOn) rooms?.forget(tabId)
      else if (unexpected) rooms?.stopped(tabId)
      else void rooms?.closed(tabId)
    },
    SECRET_ASK_CARDS_END_BEFORE_THE_ROOM_CLOSES
  )
}

const SECRET_ASK_CARDS_END_BEFORE_THE_ROOM_CLOSES = ['passwords']

const ROOMS_FOLLOW_A_NEW_CONVERSATION_WHILE_DISCORD_IS_OFF = true

const RELAYED = `${DISCORD_PREFIX} `

export const withoutTheRelayTag = (said: string): string =>
  said.startsWith(RELAYED) ? said.slice(RELAYED.length) : said
