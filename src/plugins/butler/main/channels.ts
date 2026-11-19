import type { MainIpc } from '@core/ipc'
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
}
