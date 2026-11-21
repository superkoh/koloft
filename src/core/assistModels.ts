import type { AssistRowId, BackendId, CronEffort } from '@shared/types'

export interface ModelAndEffort {
  model?: string
  effort?: CronEffort
}

export interface AssistJob<Id extends AssistRowId = AssistRowId> {
  row: Id
  system: string
  prompt: string
  signal?: AbortSignal
}

export type Assist<Id extends AssistRowId = AssistRowId> = (
  job: AssistJob<Id>
) => Promise<string | null>

// CC§9 CODEX§15
export const EVERY_ACCOUNT_TAKES: Record<BackendId, ModelAndEffort> = {
  claude: { model: 'haiku' },
  codex: { model: 'gpt-6-luna' },
  agy: {}
}

// CC§9 CODEX§15 AGY§21
export const SMALL_AND_QUICK: Record<BackendId, ModelAndEffort> = {
  claude: EVERY_ACCOUNT_TAKES.claude,
  codex: { ...EVERY_ACCOUNT_TAKES.codex, effort: 'low' },
  agy: { model: 'gemini-3.8-flash', effort: 'low' }
}
