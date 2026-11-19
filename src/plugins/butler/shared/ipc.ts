export const CHANNELS = {
  open: 'conductors:open',
  startFresh: 'conductors:startFresh',
  fromPalette: 'conductors:fromPalette',
  saveInstructions: 'butler:saveInstructions',
  instructionsSeen: 'butler:instructionsSeen',
  undoInstructions: 'butler:undoInstructions'
} as const

export type InstructionsSaveResult = { ok: true } | { ok: false; error: string }
