import type { PreloadIpc } from '@core/ipc'
import { CHANNELS, type InstructionsSaveResult } from '../shared/channels'

export interface ButlerBridge {
  butler: {
    saveInstructions(text: string): Promise<InstructionsSaveResult>
  }
}

export const bridge = (ipc: PreloadIpc): ButlerBridge => ({
  butler: {
    saveInstructions: (text) => ipc.invoke(CHANNELS.saveInstructions, text)
  }
})
