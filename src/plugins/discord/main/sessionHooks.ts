import { SESSION_STARTED, TAB_EXITED, type Moments, type SessionStarted } from '@core/moment'
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

type MadeLater<T> = () => T | null

interface ForgetsTabs {
  forget(tabId: string): void
}

export interface EndedTabParts {
  typing: MadeLater<ForgetsTabs>
  relay: MadeLater<ForgetsTabs>
  buttons: MadeLater<ForgetsTabs>
  rooms: MadeLater<ForgetsTabs & { stopped(tabId: string): void; closed(tabId: string): unknown }>
}

export function letGoOfEachEndedTab(moments: Moments, d: EndedTabParts): void {
  moments.listen(plugin.id, TAB_EXITED, ({ tabId, sessionGoesOn, unexpected }) => {
    d.typing()?.forget(tabId)
    d.relay()?.forget(tabId)
    d.buttons()?.forget(tabId)
    const rooms = d.rooms()
    if (sessionGoesOn) rooms?.forget(tabId)
    else if (unexpected) rooms?.stopped(tabId)
    else void rooms?.closed(tabId)
  })
}

const RELAYED = `${DISCORD_PREFIX} `

export const withoutTheRelayTag = (said: string): string =>
  said.startsWith(RELAYED) ? said.slice(RELAYED.length) : said
