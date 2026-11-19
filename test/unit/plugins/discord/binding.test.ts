import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DiscordBinding } from '../../../../src/plugins/discord/main/binding'
import { DISCORD_BOUND } from '../../../../src/plugins/discord/api'
import type { DiscordSettings } from '@shared/types'
import { knowPluginStates } from '../../../../src/core/switches'

const CHANNEL = { guildId: '100', channelId: '200', name: 'global' }
const BUTLER_TAB = 'tab-1'

let saved: DiscordSettings
let quiet: DiscordSettings[]
let rescans: number

function make(): DiscordBinding {
  return new DiscordBinding({
    load: () => saved,
    save: (d) => void (saved = d),
    saveQuietly: (d) => void quiet.push(d),
    rowsChanged: () => void rescans++,
    isButlerTab: (tabId) => tabId === BUTLER_TAB
  })
}

beforeEach(() => {
  saved = {}
  quiet = []
  rescans = 0
})

afterEach(() => {
  vi.useRealTimers()
  knowPluginStates({})
})

describe('Discord turned off in Settings ▸ Plugins', () => {
  it('reads as bound to nothing, with no rooms and no word of Discord for the butler, and keeps the channel and rooms on disk for when it is on again', () => {
    const room = { threadId: '300', keys: ['k1'], name: 'fix-login' }
    saved = { channel: CHANNEL, rooms: [room] }
    const c = make()
    knowPluginStates({ discord: { on: false } })
    expect(c.channel()).toBeUndefined()
    expect(c.channelOfTab(BUTLER_TAB)).toBeUndefined()
    expect(c.isButlerChannel('200')).toBe(false)
    expect(c.butlerRoleFacts()).toEqual([])
    expect(c.rooms()).toEqual([])
    c.saveRooms([])
    c.flush()
    knowPluginStates({ discord: { on: true } })
    expect(c.channelOfTab(BUTLER_TAB)).toBe('200')
    expect(c.rooms()).toEqual([room])
    expect(quiet).toEqual([])
  })
})

describe('the butler’s Discord channel', () => {
  it('only while bound is the butler’s channel known by its tab, and its role told how the owner’s Discord messages reach it', () => {
    const c = make()
    expect(c.butlerRoleFacts()).toEqual([])
    c.bind(CHANNEL)
    expect(c.butlerRoleFacts()).toEqual([DISCORD_BOUND])
    expect(c.channelOfTab(BUTLER_TAB)).toBe('200')
    expect(c.channelOfTab('another-tab')).toBeUndefined()
    c.unbind()
    expect(saved.channel).toBeUndefined()
    expect(c.channelOfTab(BUTLER_TAB)).toBeUndefined()
    expect(c.butlerRoleFacts()).toEqual([])
  })

  it('binding again changes the one channel; the last message read is kept only when it is the same channel', () => {
    saved = { channel: CHANNEL, lastMessageId: '9' }
    const c = make()
    c.bind(CHANNEL)
    expect(saved).toEqual({ channel: CHANNEL, lastMessageId: '9' })
    c.bind({ ...CHANNEL, channelId: '201' })
    expect(saved.channel).toEqual({ ...CHANNEL, channelId: '201' })
    expect(saved.lastMessageId).toBeUndefined()
    expect(c.isButlerChannel('201')).toBe(true)
    expect(c.isButlerChannel('200')).toBe(false)
  })

  it('the last Discord message is saved a second later or at quit, never going back, and without a rescan of the sidebar rows', () => {
    const c = make()
    c.bind(CHANNEL)
    rescans = 0
    vi.useFakeTimers()
    c.setLastMessage('101')
    c.setLastMessage('102')
    c.setLastMessage('100')
    expect(quiet).toHaveLength(0)
    vi.advanceTimersByTime(1000)
    expect(quiet.map((d) => d.lastMessageId)).toEqual(['102'])
    c.setLastMessage('103')
    c.flush()
    expect(quiet.at(-1)?.lastMessageId).toBe('103')
    expect(rescans).toBe(0)
  })
})
