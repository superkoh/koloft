import type { PreloadIpc } from '@core/ipc'
import type { ConductorOpenResult, PaletteRequest } from '@shared/types'
import { CHANNELS, type InstructionsSaveResult } from '../shared/ipc'

export interface ButlerBridge {
  butler: {
    open(): Promise<ConductorOpenResult>
    startFresh(): Promise<ConductorOpenResult>
    fromPalette(request: PaletteRequest): Promise<ConductorOpenResult>
    saveInstructions(text: string, opened: string): Promise<InstructionsSaveResult>
  }
}

export const bridge = (ipc: PreloadIpc): ButlerBridge => ({
  butler: {
    open: () => ipc.invoke(CHANNELS.open),
    startFresh: () => ipc.invoke(CHANNELS.startFresh),
    fromPalette: (request) => ipc.invoke(CHANNELS.fromPalette, request),
    saveInstructions: (text, opened) => ipc.invoke(CHANNELS.saveInstructions, text, opened)
  }
})
