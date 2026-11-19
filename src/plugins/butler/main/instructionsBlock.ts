import type { InstructionsBlock } from '@plugins/sessions/api'
import { instructionsOf, savedInstructions } from '../shared/instructions'
import type { ButlerSetting } from '../shared/types'

export const butlersBlock = (
  butler: ButlerSetting,
  save: (butler: ButlerSetting) => void,
  now: () => number
): InstructionsBlock => ({
  name: `${butler.name}'s instructions`,
  changedBy: (by) =>
    by === butler.name
      ? `${by} changed its instructions.`
      : `"${by}" changed ${butler.name}'s instructions.`,
  read: async () => instructionsOf(butler),
  write: async (edit, by) => {
    const saved = savedInstructions(butler, edit(instructionsOf(butler)), now(), by)
    if (!saved.ok) throw new Error(saved.error)
    if (saved.butler === butler) return false
    save(saved.butler)
    return true
  }
})
