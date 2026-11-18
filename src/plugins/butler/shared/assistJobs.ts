import type { PluginAssistJob } from '@core/plugin'

export const ASSIST_JOBS: readonly PluginAssistJob[] = [
  {
    id: 'route',
    name: 'Route what you type in ⌘P',
    does: 'Finds the workspace, session or feature your words are for.',
    // CC§9 CODEX§15 MUSE§1 AGY§21
    defaults: {
      claude: { model: 'sonnet', effort: 'low' },
      codex: { model: 'gpt-6.1-sol', effort: 'low' },
      muse: { effort: 'low' },
      agy: { model: 'gemini-3.8-flash', effort: 'low' }
    }
  }
]
