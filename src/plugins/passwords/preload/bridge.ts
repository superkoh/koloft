import type { PreloadIpc } from '@core/ipc'
import type { SecretAskView } from '@shared/types'
import { CHANNELS } from '../shared/ipc'

export interface SecretBridge {
  secret: {
    list(): Promise<SecretAskView[]>
    onAsks(cb: (asks: SecretAskView[]) => void): () => void
    answer(id: string, value: string): void
    done(id: string): void
    decline(id: string): void
  }
}

export const bridge = (ipc: PreloadIpc): SecretBridge => ({
  secret: {
    list: () => ipc.invoke(CHANNELS.list),
    onAsks: (cb) => ipc.listen(CHANNELS.asks, cb),
    answer: (id, value) => ipc.send(CHANNELS.answer, id, value),
    done: (id) => ipc.send(CHANNELS.done, id),
    decline: (id) => ipc.send(CHANNELS.decline, id)
  }
})
