import type { InstructionsBlock } from '@plugins/sessions/api'
import { instructionsOf, savedInstructions } from '../shared/instructions'
import type { ButlerSetting } from '../shared/types'

export const butlersBlock = (
  butler: ButlerSetting,
  save: (butler: ButlerSetting) => void,
  now: () => number
): InstructionsBlock => ({
  name: `${butler.name}'s instructions`,
  read: async () => instructionsOf(butler),
  write: async (edit, by) => {
    const saved = savedInstructions(butler, edit(instructionsOf(butler)), now(), by)
    if (!saved.ok) throw new Error(saved.error)
    save(saved.butler)
  }
})
