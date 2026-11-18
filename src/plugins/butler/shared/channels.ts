export const CHANNELS = {
  saveInstructions: 'butler:saveInstructions'
} as const

export type InstructionsSaveResult = { ok: true } | { ok: false; error: string }
