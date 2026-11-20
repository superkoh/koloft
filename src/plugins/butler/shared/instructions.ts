import {
  ChangedWhileOpen,
  OWNER,
  cleanInstructions,
  instructionsBytes,
  overTheLimit,
  textInUse,
  textTheOwnerChose,
  withNewVersion
} from '@core/ownerInstructions'
import type { ButlerSetting } from './types'

// CC§13 MUSE§12
export const INSTRUCTIONS_MAX_BYTES = 10_000

export const instructionsOf = (butler: ButlerSetting): string => textInUse(butler.instructions)

export type InstructionsSaved =
  { ok: true; butler: ButlerSetting } | { ok: false; error: string; inUse?: string }

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

export function savedByTheOwner(
  butler: ButlerSetting,
  typed: string,
  opened: string,
  at: number
): InstructionsSaved {
  try {
    const text = textTheOwnerChose(
      instructionsOf(butler),
      cleanInstructions(opened),
      cleanInstructions(typed)
    )
    return savedInstructions(butler, text, OWNER, at)
  } catch (error) {
    if (!(error instanceof ChangedWhileOpen)) throw error
    return { ok: false, error: error.message, inUse: error.inUse }
  }
}
