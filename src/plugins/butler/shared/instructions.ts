import {
  savedVersions,
  textInUse,
  versionsSavedByTheOwner,
  type VersionsSaved
} from '@core/ownerInstructions'
import type { ButlerSetting } from './types'

// CC§13 MUSE§12
export const INSTRUCTIONS_MAX_BYTES = 10_000

export const instructionsOf = (butler: ButlerSetting): string => textInUse(butler.instructions)

export type InstructionsSaved =
  { ok: true; butler: ButlerSetting } | { ok: false; error: string; inUse?: string }

const withVersions = (butler: ButlerSetting, saved: VersionsSaved): InstructionsSaved => {
  if (!saved.ok) return saved
  return { ok: true, butler: saved.versions ? { ...butler, instructions: saved.versions } : butler }
}

export const savedInstructions = (
  butler: ButlerSetting,
  raw: string,
  by: string,
  at: number
): InstructionsSaved =>
  withVersions(butler, savedVersions(butler.instructions, raw, by, at, INSTRUCTIONS_MAX_BYTES))

export const savedByTheOwner = (
  butler: ButlerSetting,
  typed: string,
  opened: string,
  at: number
): InstructionsSaved =>
  withVersions(
    butler,
    versionsSavedByTheOwner(butler.instructions, typed, opened, at, INSTRUCTIONS_MAX_BYTES)
  )
