import type { PreloadIpc } from '@core/ipc'
import type { ConductorOpenResult } from '@shared/types'
import type { ConductorSaveResult, DiscordChannel, DiscordStatus } from '../shared/types'
import { CHANNELS } from '../shared/ipc'

export interface DiscordBridge {
  conductors: {
    bind(channel: DiscordChannel): Promise<ConductorSaveResult>
    bindNewChannel(): Promise<ConductorSaveResult>
    unbind(): Promise<void>
  }
  discord: {
    status(): Promise<DiscordStatus>
    onStatus(cb: (s: DiscordStatus) => void): () => void
    pair(isMe: boolean): Promise<void>
    channels(): Promise<DiscordChannel[]>
    setUpWithButler(ownerWords?: string): Promise<ConductorOpenResult>
  }
}

export const bridge = (ipc: PreloadIpc): DiscordBridge => ({
  conductors: {
    bind: (channel) => ipc.invoke(CHANNELS.bind, channel),
    bindNewChannel: () => ipc.invoke(CHANNELS.bindNewChannel),
    unbind: () => ipc.invoke(CHANNELS.unbind)
  },
  discord: {
    status: () => ipc.invoke(CHANNELS.status),
    onStatus: (cb) => ipc.listen(CHANNELS.status, cb),
    pair: (isMe) => ipc.invoke(CHANNELS.pair, isMe),
    channels: () => ipc.invoke(CHANNELS.channels),
    setUpWithButler: (ownerWords) => ipc.invoke(CHANNELS.setUpWithButler, ownerWords)
  }
})
