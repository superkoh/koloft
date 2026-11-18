import type { MainIpc } from '@core/ipc'
import type { SecretAskView } from '@shared/types'
import { CHANNELS } from '../shared/channels'

export interface Asks {
  views(): SecretAskView[]
  answer(id: string, typed: string): void
  done(id: string): void
  decline(id: string): void
}

export function registerChannels(ipc: MainIpc, asks: () => Asks | null | undefined): void {
  ipc.handle(CHANNELS.list, () => asks()?.views() ?? [])
  ipc.on(CHANNELS.answer, (id: unknown, value: unknown) => {
    if (typeof id === 'string' && typeof value === 'string') asks()?.answer(id, value)
  })
  ipc.on(CHANNELS.done, (id: unknown) => {
    if (typeof id === 'string') asks()?.done(id)
  })
  ipc.on(CHANNELS.decline, (id: unknown) => {
    if (typeof id === 'string') asks()?.decline(id)
  })
}

export const pushAsks =
  (ipc: MainIpc) =>
  (views: SecretAskView[]): void =>
    ipc.push(CHANNELS.asks, views)
