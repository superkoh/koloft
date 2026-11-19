import type { MainIpc } from '@core/ipc'
import { errorText } from '@core/errorText'
import { allSeen, withChangeUndone } from '@core/ownerInstructions'
import type { ConductorOpenResult, PaletteRequest } from '@shared/types'
import { CHANNELS, type InstructionsSaveResult } from '../shared/ipc'
import { savedInstructions } from '../shared/instructions'
import type { ButlerSetting } from '../shared/types'

export interface ChannelDeps {
  open(): Promise<ConductorOpenResult>
  startFresh(): Promise<ConductorOpenResult>
  fromPalette(request: PaletteRequest): Promise<ConductorOpenResult>
  butler(): ButlerSetting
  save(butler: ButlerSetting): void
}

export function registerChannels(ipc: MainIpc, deps: ChannelDeps): void {
  ipc.handle(CHANNELS.open, () => deps.open())
  ipc.handle(CHANNELS.startFresh, () => deps.startFresh())
  ipc.handle(CHANNELS.fromPalette, (request: PaletteRequest) => deps.fromPalette(request))
  ipc.handle(CHANNELS.saveInstructions, (text: unknown): InstructionsSaveResult => {
    if (typeof text !== 'string') return { ok: false, error: 'Koloft could not read the text.' }
    const saved = savedInstructions(deps.butler(), text, Date.now())
    if (!saved.ok) return saved
    deps.save(saved.butler)
    return { ok: true }
  })
  ipc.handle(CHANNELS.instructionsSeen, () => {
    const butler = deps.butler()
    if (butler.instructions?.some((v) => v.unseen))
      deps.save({ ...butler, instructions: allSeen(butler.instructions) })
  })
  ipc.handle(CHANNELS.undoInstructions, (changeAt: unknown): InstructionsSaveResult => {
    const butler = deps.butler()
    try {
      if (typeof changeAt !== 'number') throw new Error('Koloft could not read which change.')
      deps.save({
        ...butler,
        instructions: withChangeUndone(butler.instructions, changeAt, Date.now())
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  })
}
