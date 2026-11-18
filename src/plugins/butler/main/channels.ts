import type { MainIpc } from '@core/ipc'
import type { ConductorOpenResult, PaletteRequest } from '@shared/types'
import { CHANNELS } from '../shared/ipc'

export interface ChannelDeps {
  open(): Promise<ConductorOpenResult>
  startFresh(): Promise<ConductorOpenResult>
  fromPalette(request: PaletteRequest): Promise<ConductorOpenResult>
}

export function registerChannels(ipc: MainIpc, deps: ChannelDeps): void {
  ipc.handle(CHANNELS.open, () => deps.open())
  ipc.handle(CHANNELS.startFresh, () => deps.startFresh())
  ipc.handle(CHANNELS.fromPalette, (request: PaletteRequest) => deps.fromPalette(request))
}
