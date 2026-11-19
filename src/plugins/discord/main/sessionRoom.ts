import type { SessionRoom } from '@shared/types'
import { roomLink } from '../../../main/discord/rooms'

export const roomNote = (room: Pick<SessionRoom, 'threadId' | 'putDown'>): string =>
  `room on Discord: ${roomLink(room.threadId)}${room.putDown ? ' (put down: the owner took it back at the Mac)' : ''}`

export const turnTakenOnDiscord =
  (d: { boundChannelOf(tabId: string): string | undefined; reaches(tabId: string): boolean }) =>
  (tabId: string): boolean =>
    !!d.boundChannelOf(tabId) && d.reaches(tabId)
