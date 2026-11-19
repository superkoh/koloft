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
  writeIfStill: async (before, after, by) => {
    const was = butler()
    if (instructionsOf(was) !== before) return false
    const saved = savedInstructions(was, after, by, now())
    if (!saved.ok) throw new Error(saved.error)
    save(saved.butler)
    return true
  }
})
