import { versionsStore } from '@core/ownerInstructions'
import type { InstructionsBlock } from '@plugins/sessions/api'
import { INSTRUCTIONS_MAX_BYTES } from '../shared/instructions'
import type { ButlerSetting } from '../shared/types'

export const butlersBlock = (
  butler: () => ButlerSetting,
  save: (butler: ButlerSetting) => void,
  now: () => number
): InstructionsBlock => ({
  name: `${butler().name}'s instructions`,
  ...versionsStore(
    () => butler().instructions,
    (instructions) => save({ ...butler(), instructions }),
    INSTRUCTIONS_MAX_BYTES,
    now
  )
})
