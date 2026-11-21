import type { PluginAssistJob } from '@core/plugin'

export const ASSIST_JOBS = [
  {
    id: 'route',
    name: 'Route what you type in ⌘P',
    does: 'Finds the workspace, session or feature your words are for.',
    // CC§9 CODEX§15 AGY§21
    defaults: {
      claude: { model: 'sonnet', effort: 'low' },
      codex: { model: 'gpt-6.1-sol', effort: 'low' },
      agy: { model: 'gemini-3.8-flash', effort: 'low' }
    }
  }
] as const satisfies readonly PluginAssistJob[]

export type ButlerAssistJobId = (typeof ASSIST_JOBS)[number]['id']
