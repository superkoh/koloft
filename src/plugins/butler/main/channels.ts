import type { MainIpc } from '@core/ipc'
import { CHANNELS, type InstructionsSaveResult } from '../shared/channels'
import { OWNER, savedInstructions } from '../shared/instructions'
import type { ButlerSetting } from '../shared/types'

export interface ChannelDeps {
  butler(): ButlerSetting
  save(butler: ButlerSetting): void
}

export function registerChannels(ipc: MainIpc, deps: ChannelDeps): void {
  ipc.handle(CHANNELS.saveInstructions, (text: unknown): InstructionsSaveResult => {
    if (typeof text !== 'string') return { ok: false, error: 'Koloft could not read the text.' }
    const saved = savedInstructions(deps.butler(), text, OWNER, Date.now())
    if (!saved.ok) return saved
    deps.save(saved.butler)
    return { ok: true }
  })
}
