import type { PluginAssistJob } from '@core/plugin'
import { SMALL_AND_QUICK } from '@core/assistModels'

export const ASSIST_JOBS = [
  {
    id: 'title',
    name: 'Name a new session',
    does: 'A short title for a session that an agent or your butler starts.',
    defaults: SMALL_AND_QUICK
  },
  {
    id: 'handover',
    name: 'Translate a handover',
    does: 'The note a new session gets, in your language.',
    defaults: SMALL_AND_QUICK
  },
  {
    id: 'turn',
    name: 'After each turn',
    does: 'Decides whether a reply needs you or is only news, and offers one-click answers.',
    // CC§9 CODEX§15 AGY§21
    defaults: {
      claude: { model: 'haiku' },
      codex: { model: 'gpt-6.1-sol', effort: 'medium' },
      agy: { model: 'gemini-4-argon', effort: 'medium' }
    }
  }
] as const satisfies readonly PluginAssistJob[]

export type SessionsAssistJobId = (typeof ASSIST_JOBS)[number]['id']
