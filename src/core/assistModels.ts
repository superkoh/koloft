import type { AssistRowId, BackendId, CronEffort } from '@shared/types'
import { agentManifest, ofEachAgent } from './agent/registry'

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

export const EVERY_ACCOUNT_TAKES: Record<BackendId, ModelAndEffort> = ofEachAgent((id) => {
  const model = agentManifest(id).modelEveryAccountTakes
  return model ? { model } : {}
})

// CC§9 CODEX§15 AGY§21
export const SMALL_AND_QUICK: Record<BackendId, ModelAndEffort> = {
  claude: EVERY_ACCOUNT_TAKES.claude,
  codex: { ...EVERY_ACCOUNT_TAKES.codex, effort: 'low' },
  agy: { model: 'gemini-3.8-flash', effort: 'low' }
}
