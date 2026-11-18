import type { PreloadIpc } from '@core/ipc'
import type { ConductorOpenResult, PaletteRequest } from '@shared/types'
import { CHANNELS } from '../shared/ipc'

export interface ButlerBridge {
  butler: {
    open(): Promise<ConductorOpenResult>
    startFresh(): Promise<ConductorOpenResult>
    fromPalette(request: PaletteRequest): Promise<ConductorOpenResult>
  }
}

export const bridge = (ipc: PreloadIpc): ButlerBridge => ({
  butler: {
    open: () => ipc.invoke(CHANNELS.open),
    startFresh: () => ipc.invoke(CHANNELS.startFresh),
    fromPalette: (request) => ipc.invoke(CHANNELS.fromPalette, request)
  }
})
