import { describe, it, expect } from 'vitest'
import { GLOBAL_SCOPE } from '@shared/conductors'
import { newChannelGuild } from '@plugins/discord/shared/channels'
import { sanitizeDiscord } from '@plugins/discord/shared/settings'
import type { DiscordChannel } from '@plugins/discord/shared/types'

function channel(channelId: string, guildId = '100'): DiscordChannel {
  return { guildId, channelId, name: `ch-${channelId}` }
}

function oldBinding(id: string, scope: string, channelId: string, lastMessageId?: string) {
  return {
    id,
    scope,
    backend: 'claude',
    channel: channel(channelId),
    touched: [],
    ...(lastMessageId ? { lastMessageId } : {})
  }
}

describe('sanitizeDiscord', () => {
  it('starts with no channel', () => {
    expect(sanitizeDiscord(undefined)).toEqual({})
  })

  it('keeps the butler’s channel, the last message it read and that the old threads were archived, across a restart', () => {
    expect(
      sanitizeDiscord({
        userId: '555',
        channel: channel('2'),
        lastMessageId: '90',
        oldThreadsArchived: true
      })
    ).toEqual({
      userId: '555',
      channel: channel('2'),
      lastMessageId: '90',
      oldThreadsArchived: true
    })
  })

  it('keeps which thread each session’s room is, every id it went by, where it read up to and whether Koloft put it down, across a restart', () => {
    const room = { threadId: '70', keys: ['a', 'b'], name: 'Fix login', lastMessageId: '71' }
    expect(
      sanitizeDiscord({
        rooms: [
          room,
          { ...room, threadId: '72', putDown: true },
          { threadId: '73', keys: [], name: 'no session' },
          { threadId: 'x', keys: ['c'], name: 'bad id' }
        ]
      })
    ).toEqual({ rooms: [room, { ...room, threadId: '72', putDown: true }] })
  })

  it('drops a channel with no name', () => {
    expect(sanitizeDiscord({ channel: { guildId: '100', channelId: '5' } })).toEqual({})
  })
})

describe('loading the bindings an older Koloft wrote', () => {
  it('keeps only the global channel once workspaces had channels of their own: the butler listens there alone', () => {
    const doc = sanitizeDiscord({
      bindings: [
        oldBinding('a', '/ws/a', '1', '900'),
        oldBinding('g', GLOBAL_SCOPE, '2', '100'),
        oldBinding('b', '/ws/b', '3')
      ]
    })
    expect(doc).toEqual({ channel: channel('2'), lastMessageId: '100' })
  })

  it('turns the workspace channel last written in into the butler’s, for an owner who never bound #global', () => {
    const doc = sanitizeDiscord({
      bindings: [
        oldBinding('a', '/ws/a', '1', '1000'),
        oldBinding('b', 'ssh://box/srv/b', '2', '1500000000000000001'),
        oldBinding('c', '/ws/c', '3')
      ]
    })
    expect(doc).toEqual({ channel: channel('2'), lastMessageId: '1500000000000000001' })
  })

  it('takes the first workspace channel when none was ever written in', () => {
    const doc = sanitizeDiscord({
      bindings: [oldBinding('a', '/ws/a', '1'), oldBinding('b', '/ws/b', '2')]
    })
    expect(doc.channel).toEqual(channel('1'))
  })

  it('drops a binding whose channel has no name', () => {
    const doc = sanitizeDiscord({
      bindings: [
        { ...oldBinding('g', GLOBAL_SCOPE, '5'), channel: { guildId: '100', channelId: '5' } }
      ]
    })
    expect(doc).toEqual({})
  })

  it('a channel already saved the new way wins over old bindings beside it', () => {
    const doc = sanitizeDiscord({
      channel: channel('7'),
      bindings: [oldBinding('g', GLOBAL_SCOPE, '2')]
    })
    expect(doc.channel).toEqual(channel('7'))
  })
})

describe('the server a new channel goes in', () => {
  const guilds = [
    { id: '1', name: 'someone else’s', ownerId: '999' },
    { id: '2', name: 'mine', ownerId: '555' },
    { id: '3', name: 'also mine', ownerId: '555' }
  ]

  it('is a server the owner owns, never one the bot was only invited to', () => {
    expect(newChannelGuild(undefined, guilds, '555')).toBe('2')
    expect(newChannelGuild(undefined, guilds.slice(0, 1), '555')).toBeUndefined()
    expect(newChannelGuild(undefined, guilds, undefined)).toBeUndefined()
  })

  it('is the owned server the butler’s channel is already in', () => {
    expect(newChannelGuild(channel('1', '2'), guilds, '555')).toBe('2')
    expect(newChannelGuild(channel('1', '3'), guilds, '555')).toBe('3')
    expect(newChannelGuild(channel('1', '1'), guilds, '555')).toBe('2')
  })
})
