import type { MainIpc } from '@core/ipc'
import type { ConductorOpenResult, PaletteRequest } from '@shared/types'
import { CHANNELS } from '../shared/ipc'

export interface ChannelDeps {
  open(): ConductorOpenResult | Promise<ConductorOpenResult>
  startFresh(): ConductorOpenResult | Promise<ConductorOpenResult>
  fromPalette(request: PaletteRequest): Promise<ConductorOpenResult>
  savePicture(dataUrl: string): Promise<string | null>
}

export function registerChannels(ipc: MainIpc, deps: ChannelDeps): void {
  ipc.handle(CHANNELS.open, () => deps.open())
  ipc.handle(CHANNELS.startFresh, () => deps.startFresh())
  ipc.handle(CHANNELS.fromPalette, (request: PaletteRequest) => deps.fromPalette(request))
  ipc.handle(CHANNELS.savePicture, (dataUrl: unknown) =>
    typeof dataUrl === 'string' ? deps.savePicture(dataUrl) : null
  )
}
