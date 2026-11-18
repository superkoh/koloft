import type { AccountMeta, Settings } from '@shared/types'
import { backendsByAccountAge, type AssistInputs } from '@shared/assistPicks'

export function assistInputs(s: {
  accounts: readonly AccountMeta[] | null
  settings: Pick<Settings, 'accounts' | 'assist' | 'sessionMethods'>
}): AssistInputs {
  return {
    assist: s.settings.assist,
    sessionMethods: s.settings.sessionMethods,
    accounts: s.accounts ?? s.settings.accounts
  }
}

export function someAccountCanRunAssist(s: Parameters<typeof assistInputs>[0]): boolean {
  return backendsByAccountAge(assistInputs(s)).length > 0
}
