export const USE_A_SAVED_RESET = 'useReset'

// CODEX§15
export const CODEX_RESET_OUTCOMES = [
  'reset',
  'nothingToReset',
  'noCredit',
  'alreadyRedeemed'
] as const

export type CodexResetOutcome = (typeof CODEX_RESET_OUTCOMES)[number] | 'failed'
