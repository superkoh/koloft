export const CHANNELS = {
  open: 'conductors:open',
  startFresh: 'conductors:startFresh',
  fromPalette: 'conductors:fromPalette',
  saveInstructions: 'butler:saveInstructions'
} as const

export type InstructionsSaveResult = { ok: true } | { ok: false; error: string; inUse?: string }
