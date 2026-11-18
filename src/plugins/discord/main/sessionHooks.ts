import type { Moment, SessionStarted } from '@core/moment'
import { DISCORD_PREFIX } from '@plugins/discord/api'

const roomStarted = (link: string): string =>
  `The owner asked for it on Discord, so it has a room there, where the owner talks to it: ${link}. Give the owner that link exactly as written.`

export function giveEachStartedSessionARoom(
  sessionStarted: Moment<SessionStarted>,
  d: {
    isButler(tabId: string): boolean
    butlerFolder(): string
    roomFor(started: SessionStarted): Promise<string | undefined>
  }
): void {
  sessionStarted.listen(async (started) => {
    if (!d.isButler(started.by) || started.workspace === d.butlerFolder()) return undefined
    const link = await d.roomFor(started)
    return link ? roomStarted(link) : undefined
  })
}

const RELAYED = `${DISCORD_PREFIX} `

export const withoutTheRelayTag = (said: string): string =>
  said.startsWith(RELAYED) ? said.slice(RELAYED.length) : said
