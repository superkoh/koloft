import type { DiscordChannel } from '@shared/types'
import { privately, type DiscordInteraction, type DiscordLink, type DiscordMessage } from './link'

export const ONE_REPLY_PER_THREAD_WITHIN_MS = 10 * 60_000

export const talkToTheButler = (name: string, channel: DiscordChannel): string =>
  `Koloft no longer reads this thread. Talk to ${name} in <#${channel.channelId}>.`

export interface OldThreadDeps {
  link: Pick<DiscordLink, 'botThreadsUnder' | 'isBotThread' | 'archiveThread' | 'post' | 'respond'>
  butlerName(): string
  channel(): DiscordChannel | undefined
  archived(): boolean
  markArchived(): void
  now(): number
}

export class OldThreads {
  private botThreads = new Map<string, Promise<boolean>>()
  private toldAt = new Map<string, number>()

  constructor(private d: OldThreadDeps) {}

  async archiveOnce(): Promise<void> {
    const channel = this.d.channel()
    if (!channel || this.d.archived()) return
    const threads = await this.d.link
      .botThreadsUnder(channel.guildId, channel.channelId)
      .catch(() => undefined)
    if (!threads) return
    for (const id of threads) await this.d.link.archiveThread(id).catch(() => undefined)
    this.d.markArchived()
  }

  private isOld(channelId: string): Promise<boolean> {
    let known = this.botThreads.get(channelId)
    if (!known) {
      known = this.d.link.isBotThread(channelId).catch(() => false)
      this.botThreads.set(channelId, known)
    }
    return known
  }

  private reply(): string | undefined {
    const channel = this.d.channel()
    return channel && talkToTheButler(this.d.butlerName(), channel)
  }

  async onMessage(m: DiscordMessage): Promise<void> {
    if (!(await this.isOld(m.channelId))) return
    const text = this.reply()
    const told = this.toldAt.get(m.channelId)
    if (!text || (told !== undefined && this.d.now() - told < ONE_REPLY_PER_THREAD_WITHIN_MS))
      return
    this.toldAt.set(m.channelId, this.d.now())
    await this.d.link.post(m.channelId, text, m.id).catch(() => undefined)
  }

  async onInteraction(i: DiscordInteraction): Promise<void> {
    if (!(await this.isOld(i.channelId))) return
    const text = this.reply()
    if (text) await this.d.link.respond(i, privately(text)).catch(() => undefined)
  }
}
