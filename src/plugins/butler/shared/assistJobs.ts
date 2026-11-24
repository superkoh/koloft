import type { PluginAssistJob } from '@core/plugin'

export const ASSIST_JOBS = [
  {
    id: 'route',
    name: 'Route what you type in ⌘P',
    does: 'Finds the workspace, session or feature your words are for.',
    kind: 'picksFromAList'
  }
] as const satisfies readonly PluginAssistJob[]

export type ButlerAssistJobId = (typeof ASSIST_JOBS)[number]['id']
