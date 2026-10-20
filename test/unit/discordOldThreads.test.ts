import { describe, it, expect } from 'vitest'
import {
  OldThreads,
  ONE_REPLY_PER_THREAD_WITHIN_MS,
  talkToTheButler
} from '../../src/main/discord/oldThreads'
import type { DiscordInteraction, DiscordMessage } from '../../src/main/discord/link'
import type { DiscordChannel } from '../../src/shared/types'

const CHANNEL: DiscordChannel = { guildId: '1', channelId: '200', name: 'global' }
const OLD = '701'
const OTHER = '800'

function setup(over: { listFails?: boolean; archiveFails?: string[] } = {}) {
  let now = 1_000_000
  let archived = false
  const archivedThreads: string[] = []
  const posts: { channelId: string; text: string; replyTo?: string }[] = []
  const responses: { channelId: string; body: unknown }[] = []
  const lookups: string[] = []
  const threads = new OldThreads({
    link: {
      botThreadsUnder: async (guildId, parentId) => {
        if (over.listFails) throw new Error('Discord answered 500')
        return guildId === '1' && parentId === '200' ? [OLD, '702'] : []
      },
      isBotThread: async (channelId) => {
        lookups.push(channelId)
        return channelId === OLD
      },
      archiveThread: async (id) => {
        if (over.archiveFails?.includes(id)) throw new Error('Discord answered 403')
        archivedThreads.push(id)
      },
      post: async (channelId, text, replyTo) => void posts.push({ channelId, text, replyTo }),
      respond: async (i, body) => void responses.push({ channelId: i.channelId, body })
    },
    butlerName: () => 'Alfred',
    channel: () => CHANNEL,
    archived: () => archived,
    markArchived: () => void (archived = true),
    now: () => now
  })
  return {
    threads,
    archivedThreads,
    posts,
    responses,
    lookups,
    archived: () => archived,
    later: (ms: number) => void (now += ms)
  }
}

const message = (id: string, channelId: string): DiscordMessage => ({
  id,
  channelId,
  authorId: '555',
  bot: false,
  content: 'hello',
  attachments: []
})

const interaction = (channelId: string): DiscordInteraction => ({
  id: '9',
  token: 't',
  type: 2,
  channelId,
  userId: '555',
  command: 'run',
  options: {}
})

describe('session threads an older Koloft opened under the butler’s channel', () => {
  it('are archived once, each of the bot’s own open threads there, and never again after', async () => {
    const t = setup()
    await t.threads.archiveOnce()
    await t.threads.archiveOnce()
    expect(t.archivedThreads).toEqual([OLD, '702'])
    expect(t.archived()).toBe(true)
  })

  it('a thread Discord will not archive is skipped and the rest still are; a list Discord will not give is tried again on the next connect', async () => {
    const skipped = setup({ archiveFails: [OLD] })
    await skipped.threads.archiveOnce()
    expect(skipped.archivedThreads).toEqual(['702'])
    expect(skipped.archived()).toBe(true)
    const unlisted = setup({ listFails: true })
    await unlisted.threads.archiveOnce()
    expect(unlisted.archived()).toBe(false)
  })

  it('the owner writing in one gets one reply sending them to the butler’s channel, and no second within the quiet time', async () => {
    const t = setup()
    await t.threads.onMessage(message('1', OLD))
    await t.threads.onMessage(message('2', OLD))
    t.later(ONE_REPLY_PER_THREAD_WITHIN_MS)
    await t.threads.onMessage(message('3', OLD))
    expect(t.posts).toEqual([
      { channelId: OLD, text: talkToTheButler('Alfred', CHANNEL), replyTo: '1' },
      { channelId: OLD, text: talkToTheButler('Alfred', CHANNEL), replyTo: '3' }
    ])
    expect(t.posts[0].text).toBe('Koloft no longer reads this thread. Talk to Alfred in <#200>.')
  })

  it('a slash command or a button pressed in one is answered privately with the same line, every time, so Discord never says the app did not respond', async () => {
    const t = setup()
    await t.threads.onInteraction(interaction(OLD))
    await t.threads.onInteraction(interaction(OLD))
    expect(t.responses).toEqual([
      {
        channelId: OLD,
        body: { type: 4, data: { content: talkToTheButler('Alfred', CHANNEL), flags: 64 } }
      },
      {
        channelId: OLD,
        body: { type: 4, data: { content: talkToTheButler('Alfred', CHANNEL), flags: 64 } }
      }
    ])
  })

  it('a channel that is not one of the bot’s threads gets nothing, and is looked up only once', async () => {
    const t = setup()
    await t.threads.onMessage(message('1', OTHER))
    await t.threads.onMessage(message('2', OTHER))
    await t.threads.onInteraction(interaction(OTHER))
    expect(t.posts).toEqual([])
    expect(t.responses).toEqual([])
    expect(t.lookups).toEqual([OTHER])
  })
})
