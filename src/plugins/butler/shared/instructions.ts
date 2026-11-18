import type { ButlerSetting, InstructionsVersion } from './types'

// CC§13 MUSE§12
export const INSTRUCTIONS_MAX_BYTES = 10_000

export const OWNER = 'owner'

const VERSIONS_KEPT = 20

const UNSEEN_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/g

const encoder = new TextEncoder()

// MUSE§12
export const instructionsBytes = (text: string): number =>
  encoder.encode(JSON.stringify(text)).length - 2

export const cleanInstructions = (raw: string): string =>
  raw.replace(/\r\n?/g, '\n').replace(UNSEEN_CONTROL_CHARACTERS, '').trim()

export const instructionsOf = (butler: ButlerSetting): string =>
  butler.instructions?.at(-1)?.text ?? ''

export type InstructionsSaved = { ok: true; butler: ButlerSetting } | { ok: false; error: string }

export function savedInstructions(
  butler: ButlerSetting,
  raw: string,
  by: string,
  at: number
): InstructionsSaved {
  const text = cleanInstructions(raw)
  const over = instructionsBytes(text) - INSTRUCTIONS_MAX_BYTES
  if (over > 0)
    return {
      ok: false,
      error: `The instructions are ${over.toLocaleString('en-US')} over the limit.`
    }
  if (text === instructionsOf(butler)) return { ok: true, butler }
  const versions = [...(butler.instructions ?? []), { text, at, by }].slice(-VERSIONS_KEPT)
  return { ok: true, butler: { ...butler, instructions: versions } }
}

export function cleanVersions(raw: unknown): InstructionsVersion[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((v: unknown) => {
    if (!v || typeof v !== 'object') return []
    const { text, at, by } = v as Record<string, unknown>
    if (typeof text !== 'string' || typeof at !== 'number' || typeof by !== 'string') return []
    return [{ text: cleanInstructions(text), at, by }]
  })
}
