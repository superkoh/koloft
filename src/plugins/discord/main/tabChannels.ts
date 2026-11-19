import type { SessionRoom } from '@shared/types'
import { roomLink } from '../../../main/discord/rooms'

interface TabChannelDeps {
  butlerSide(tabId: string): boolean
  lobby(): string | undefined
  boundChannelOf(tabId: string): string | undefined
  roomCarrying(tabId: string): string | undefined
  reaches(tabId: string): boolean
}

export function tabChannels(d: TabChannelDeps) {
  const roomOf = (tabId: string): string | undefined =>
    d.butlerSide(tabId) ? undefined : d.roomCarrying(tabId)
  return {
    roomOf,
    boundChannelOf: d.boundChannelOf,
    askChannelOf: (tabId: string): string | undefined =>
      d.butlerSide(tabId) ? d.lobby() : roomOf(tabId),
    phoneChannelOf: (tabId: string): string | undefined => d.boundChannelOf(tabId) ?? roomOf(tabId),
    turnTakenOnDiscord: (tabId: string): boolean => !!d.boundChannelOf(tabId) && d.reaches(tabId)
  }
}

export type TabChannels = ReturnType<typeof tabChannels>

export const roomNote = (room: Pick<SessionRoom, 'threadId' | 'putDown'>): string =>
  `room on Discord: ${roomLink(room.threadId)}${room.putDown ? ' (put down: the owner took it back at the Mac)' : ''}`
