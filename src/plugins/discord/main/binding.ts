import type {
  ConductorSaveResult,
  DiscordChannel,
  DiscordSettings,
  SessionRoom
} from '@shared/types'
import { CannotMakeChannels, type NewChannel } from './link'
import { newerSnowflake } from '@plugins/discord/shared/channels'
import { DISCORD_BOUND } from '@plugins/discord/api'
import { errorText } from '@core/errorText'
import { discordOn } from './switchOn'

export interface DiscordBindingDeps {
  load(): DiscordSettings
  save(discord: DiscordSettings): void
  saveQuietly(discord: DiscordSettings): void
  rowsChanged(): void
  isButlerTab(tabId: string): boolean
}

const LAST_MESSAGE_SAVE_DELAY_MS = 1000

export class DiscordBinding {
  private discord: DiscordSettings
  private pendingSave: ReturnType<typeof setTimeout> | null = null

  constructor(private d: DiscordBindingDeps) {
    this.discord = d.load()
  }

  channel(): DiscordChannel | undefined {
    return discordOn() ? this.discord.channel : undefined
  }

  butlerRoleFacts(): string[] {
    return this.channel() ? [DISCORD_BOUND] : []
  }

  lastMessageId(): string | undefined {
    return this.discord.lastMessageId
  }

  oldThreadsArchived(): boolean {
    return !!this.discord.oldThreadsArchived
  }

  markOldThreadsArchived(): void {
    this.discord = { ...this.discord, oldThreadsArchived: true }
    this.d.saveQuietly(this.discord)
  }

  private write(patch: Partial<DiscordSettings>): void {
    this.discord = { ...this.discord, ...patch }
    this.d.save(this.discord)
    this.d.rowsChanged()
  }

  flush(): void {
    if (!this.pendingSave) return
    clearTimeout(this.pendingSave)
    this.pendingSave = null
    this.d.saveQuietly(this.discord)
  }

  channelOfTab(tabId: string): string | undefined {
    return this.d.isButlerTab(tabId) ? this.channel()?.channelId : undefined
  }

  isButlerChannel(channelId: string): boolean {
    return this.channel()?.channelId === channelId
  }

  setLastMessage(messageId: string): void {
    const last = this.discord.lastMessageId
    if (last && !newerSnowflake(messageId, last)) return
    this.discord = { ...this.discord, lastMessageId: messageId }
    this.saveSoon()
  }

  rooms(): SessionRoom[] {
    return this.discord.rooms ?? []
  }

  saveRooms(rooms: SessionRoom[]): void {
    this.discord = { ...this.discord, rooms }
    this.saveSoon()
  }

  private saveSoon(): void {
    this.pendingSave ??= setTimeout(() => this.flush(), LAST_MESSAGE_SAVE_DELAY_MS)
  }

  async bindNewChannel(
    make: (category: DiscordChannel | undefined) => Promise<NewChannel>
  ): Promise<ConductorSaveResult> {
    let made: NewChannel
    try {
      made = await make(this.discord.category)
    } catch (error) {
      return {
        ok: false,
        error: errorText(error),
        ...(error instanceof CannotMakeChannels ? { cannotMakeChannels: true } : {})
      }
    }
    this.discord = { ...this.discord, category: made.category }
    return this.bind(made.channel)
  }

  bind(channel: DiscordChannel): ConductorSaveResult {
    const same = this.discord.channel?.channelId === channel.channelId
    this.write({
      channel,
      lastMessageId: same ? this.discord.lastMessageId : undefined,
      rooms: same ? this.discord.rooms : undefined
    })
    return { ok: true }
  }

  unbind(): void {
    this.write({ channel: undefined, lastMessageId: undefined, rooms: undefined })
  }

  settings(): DiscordSettings {
    return this.discord
  }

  owner(): string | undefined {
    return this.discord.userId
  }

  setOwner(owner: { id: string; name: string }): void {
    if (owner.id === this.discord.userId && owner.name === this.discord.userName) return
    this.discord = { ...this.discord, userId: owner.id, userName: owner.name }
    this.d.save(this.discord)
  }
}
