import {
  cleanInstructions,
  instructionsBytes,
  overTheLimit,
  textInUse,
  withNewVersion
} from '@core/ownerInstructions'
import type { ButlerSetting } from './types'

export { OWNER, cleanInstructions, cleanVersions, instructionsBytes } from '@core/ownerInstructions'

// CC§13 MUSE§12
export const INSTRUCTIONS_MAX_BYTES = 10_000

export const instructionsOf = (butler: ButlerSetting): string => textInUse(butler.instructions)

export type InstructionsSaved = { ok: true; butler: ButlerSetting } | { ok: false; error: string }

export function savedInstructions(
  butler: ButlerSetting,
  raw: string,
  by: string,
  at: number
): InstructionsSaved {
  const text = cleanInstructions(raw)
  const over = instructionsBytes(text) - INSTRUCTIONS_MAX_BYTES
  if (over > 0) return { ok: false, error: overTheLimit(over) }
  const versions = withNewVersion(butler.instructions, text, by, at)
  return { ok: true, butler: versions ? { ...butler, instructions: versions } : butler }
}
