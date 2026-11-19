import type { PreloadIpc } from '@core/ipc'
import type { ConductorOpenResult, PaletteRequest } from '@shared/types'
import { CHANNELS, type InstructionsSaveResult } from '../shared/ipc'

export interface ButlerBridge {
  butler: {
    open(): Promise<ConductorOpenResult>
    startFresh(): Promise<ConductorOpenResult>
    fromPalette(request: PaletteRequest): Promise<ConductorOpenResult>
    saveInstructions(text: string): Promise<InstructionsSaveResult>
    instructionsSeen(): Promise<void>
    undoInstructions(changeAt: number): Promise<InstructionsSaveResult>
  }
}

export const bridge = (ipc: PreloadIpc): ButlerBridge => ({
  butler: {
    open: () => ipc.invoke(CHANNELS.open),
    startFresh: () => ipc.invoke(CHANNELS.startFresh),
    fromPalette: (request) => ipc.invoke(CHANNELS.fromPalette, request),
    saveInstructions: (text) => ipc.invoke(CHANNELS.saveInstructions, text),
    instructionsSeen: () => ipc.invoke(CHANNELS.instructionsSeen),
    undoInstructions: (changeAt) => ipc.invoke(CHANNELS.undoInstructions, changeAt)
  }
})
