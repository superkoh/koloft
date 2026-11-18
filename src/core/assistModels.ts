import type { BackendId, CronEffort } from '@shared/types'

export interface ModelAndEffort {
  model?: string
  effort?: CronEffort
}

// CC§9 CODEX§15
export const EVERY_ACCOUNT_TAKES: Record<BackendId, ModelAndEffort> = {
  claude: { model: 'haiku' },
  codex: { model: 'gpt-6-luna' },
  muse: {},
  agy: {}
}

// CC§9 CODEX§15 MUSE§1 AGY§21
export const SMALL_AND_QUICK: Record<BackendId, ModelAndEffort> = {
  claude: EVERY_ACCOUNT_TAKES.claude,
  codex: { ...EVERY_ACCOUNT_TAKES.codex, effort: 'low' },
  muse: { effort: 'low' },
  agy: { model: 'gemini-3.8-flash', effort: 'low' }
}
