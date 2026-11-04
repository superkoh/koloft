import { describe, expect, it } from 'vitest'
import type { SessionRoom } from '../../src/shared/types'
import {
  CLOSED_IN_ROOM,
  Rooms,
  STARTED_OVER_IN_ROOM,
  STOPPED_IN_ROOM,
  type RoomSubject
} from '../../src/main/discord/rooms'

const LOBBY = { guildId: '1', channelId: '200', name: 'global' }
const OWNER = '555'

function setup(saved: SessionRoom[] = []) {
  let stored = saved
  let next = 700
  const calls: string[] = []
  const rooms = new Rooms({
    link: {
      card: async (channelId, card) => {
        calls.push(`card ${channelId} ${card.header}`)
        return [String(++next)]
      },
      startThread: async (channelId, messageId, name) => {
        calls.push(`thread ${channelId} ${messageId} ${name}`)
        return `t${messageId}`
      },
      addToThread: async (threadId, userId) => void calls.push(`add ${threadId} ${userId}`),
      archiveThread: async (threadId) => void calls.push(`archive ${threadId}`),
      post: async (channelId, text) => void calls.push(`post ${channelId} ${text}`)
    },
    owner: () => OWNER,
    lobby: () => LOBBY,
    rooms: () => stored,
    save: (list) => void (stored = list)
  })
  const show = async (threadId: string): Promise<void> => void calls.push(`show ${threadId}`)
  return { rooms, calls, stored: () => stored, show }
}

const fix: RoomSubject = { tabId: 'tab-1', key: 'k1', name: 'Fix login', backend: 'claude' }
const fresh = async (): Promise<boolean> => true

describe('a session’s room on Discord', () => {
  it('is opened once, as a thread on a card in the butler’s channel, shows where the session is and then adds the owner; opening it again reuses the same thread', async () => {
    const { rooms, calls, stored, show } = setup()
    expect(await rooms.open(fix, show)).toBe('t701')
    expect(calls).toEqual([
      'card 200 🧵 **Fix login**',
      'thread 200 701 Fix login',
      'show t701',
      `add t701 ${OWNER}`
    ])
    expect(stored()).toEqual([
      { threadId: 't701', keys: ['k1'], name: 'Fix login', lastMessageId: 't701' }
    ])
    calls.length = 0
    expect(await rooms.open(fix, show)).toBe('t701')
    expect(calls).toEqual(['show t701', `add t701 ${OWNER}`])
  })

  it('a session that has no id yet keeps its room by its tab, and the room is saved under its id once it binds, also when it binds before the thread is made', async () => {
    const { rooms, stored, show } = setup()
    await rooms.open({ tabId: 'tab-2', name: 'New work', backend: 'codex' }, show)
    expect(stored()).toEqual([])
    expect(rooms.carried('tab-2')).toBe('t701')
    await rooms.bound('tab-2', 'k2', fresh)
    expect(stored()).toEqual([
      { threadId: 't701', keys: ['k2'], name: 'New work', lastMessageId: 't701' }
    ])
    const opening = rooms.open({ tabId: 'tab-3', name: 'Quick', backend: 'claude' }, show)
    await rooms.bound('tab-3', 'k3', fresh)
    await opening
    expect(rooms.ofKey('k3')?.threadId).toBe('t702')
  })

  it('after /clear in the same tab it is still the same room, now also under the new id, and says so in the room; a resume into its own id says nothing', async () => {
    const { rooms, calls, stored, show } = setup()
    await rooms.open(fix, show)
    await rooms.bound('tab-1', 'k1', fresh)
    calls.length = 0
    await rooms.bound('tab-1', 'k1b', fresh)
    expect(stored()[0].keys).toEqual(['k1', 'k1b'])
    expect(calls).toEqual([`post t701 ${STARTED_OVER_IN_ROOM}`])
    calls.length = 0
    await rooms.bound('tab-9', 'k1b', fresh)
    expect(calls).toEqual([])
    expect(rooms.carried('tab-9')).toBe('t701')
  })

  it('a tab that resumes another session that already talked leaves the room behind with the session it belongs to', async () => {
    const { rooms, calls, stored, show } = setup()
    await rooms.open(fix, show)
    calls.length = 0
    await rooms.bound('tab-1', 'other', async () => false)
    expect(stored()[0].keys).toEqual(['k1'])
    expect(rooms.carried('tab-1')).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('is put down (archived) when the owner works on the session at the Mac, and is carried again only when the owner opens it or speaks in it', async () => {
    const { rooms, calls, stored, show } = setup()
    await rooms.open(fix, show)
    calls.length = 0
    rooms.handsOn('tab-1')
    rooms.handsOn('tab-1')
    expect(calls).toEqual(['archive t701'])
    expect(rooms.carried('tab-1')).toBeUndefined()
    expect(stored()[0].putDown).toBe(true)
    rooms.ownerSpoke('t701')
    expect(rooms.carried('tab-1')).toBe('t701')
    rooms.handsOn('tab-1')
    await rooms.open(fix, show)
    expect(rooms.carried('tab-1')).toBe('t701')
  })

  it('when its session closes, says so first and archives only once that message is posted, so the post does not open it again', async () => {
    const { rooms, calls, show } = setup()
    await rooms.open(fix, show)
    calls.length = 0
    await rooms.closed('tab-1')
    expect(calls).toEqual([`post t701 ${CLOSED_IN_ROOM}`, 'archive t701'])
    expect(rooms.carried('tab-1')).toBeUndefined()
  })

  it('when its session stops unexpectedly, says so and stays carried', async () => {
    const { rooms, calls, stored, show } = setup()
    await rooms.open(fix, show)
    calls.length = 0
    rooms.stopped('tab-1')
    expect(calls).toEqual([`post t701 ${STOPPED_IN_ROOM}`])
    expect(stored()[0].putDown).toBeUndefined()
  })

  it('remembers the newest message read in it, never going back', () => {
    const { rooms, stored } = setup([{ threadId: '71', keys: ['k1'], name: 'Fix login' }])
    rooms.seen('71', '90')
    rooms.seen('71', '80')
    expect(stored()[0].lastMessageId).toBe('90')
  })
})
