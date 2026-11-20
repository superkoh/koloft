import { textInUse, versionsSavedByTheOwner } from '@core/ownerInstructions'
import type { ButlerSetting } from './types'

// CC§13 MUSE§12
export const INSTRUCTIONS_MAX_BYTES = 10_000

export const instructionsOf = (butler: ButlerSetting): string => textInUse(butler.instructions)

export type InstructionsSaved =
  { ok: true; butler: ButlerSetting } | { ok: false; error: string; inUse?: string }

export function savedByTheOwner(
  butler: ButlerSetting,
  typed: string,
  opened: string,
  at: number
): InstructionsSaved {
  const saved = versionsSavedByTheOwner(
    butler.instructions,
    typed,
    opened,
    at,
    INSTRUCTIONS_MAX_BYTES
  )
  if (!saved.ok) return saved
  return { ok: true, butler: saved.versions ? { ...butler, instructions: saved.versions } : butler }
}
