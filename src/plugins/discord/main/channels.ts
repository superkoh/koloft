import type { MainIpc } from '@core/ipc'
import type { ConductorOpenResult } from '@shared/types'
import { isDiscordId } from '../shared/channels'
import type { ConductorSaveResult, DiscordChannel, DiscordStatus } from '../shared/types'
import { CHANNELS } from '../shared/ipc'

export interface ChannelDeps {
  bind(channel: DiscordChannel): ConductorSaveResult
  bindNewChannel(): Promise<ConductorSaveResult>
  unbind(): void
  status(): DiscordStatus
  pair(isMe: boolean): void
  channels(): Promise<DiscordChannel[]> | DiscordChannel[]
  setUpWithButler(ownerWords: string | undefined): Promise<ConductorOpenResult>
}

export function registerChannels(ipc: MainIpc, deps: ChannelDeps): void {
  ipc.handle(CHANNELS.bind, (channel: DiscordChannel | undefined) => {
    if (
      !isDiscordId(channel?.guildId) ||
      !isDiscordId(channel.channelId) ||
      typeof channel.name !== 'string'
    )
      return { ok: false, error: 'Pick a channel.' }
    const { guildId, channelId, name } = channel
    return deps.bind({ guildId, channelId, name })
  })
  ipc.handle(CHANNELS.bindNewChannel, () => deps.bindNewChannel())
  ipc.handle(CHANNELS.unbind, () => deps.unbind())
  ipc.handle(CHANNELS.status, () => deps.status())
  ipc.handle(CHANNELS.pair, (isMe: unknown) => deps.pair(isMe === true))
  ipc.handle(CHANNELS.channels, () => deps.channels())
  ipc.handle(CHANNELS.setUpWithButler, (ownerWords?: string) =>
    deps.setUpWithButler(typeof ownerWords === 'string' ? ownerWords : undefined)
  )
}

export const pushStatus =
  (ipc: MainIpc) =>
  (status: DiscordStatus): void =>
    ipc.push(CHANNELS.status, status)
