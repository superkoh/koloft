import type { InstructionsBlock } from '@plugins/sessions/api'
import { instructionsOf, savedInstructions } from '../shared/instructions'
import type { ButlerSetting } from '../shared/types'

export const butlersBlock = (
  butler: () => ButlerSetting,
  save: (butler: ButlerSetting) => void,
  now: () => number
): InstructionsBlock => ({
  name: `${butler().name}'s instructions`,
  read: async () => instructionsOf(butler()),
  check: async (text) => {
    const saved = savedInstructions(butler(), text, '', now())
    if (!saved.ok) throw new Error(saved.error)
  },
  write: async (edit, by) => {
    const was = butler()
    const saved = savedInstructions(was, edit(instructionsOf(was)), by, now())
    if (!saved.ok) throw new Error(saved.error)
    if (saved.butler === was) return false
    save(saved.butler)
    return true
  }
})
