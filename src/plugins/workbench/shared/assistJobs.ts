import type { PluginAssistJob } from '@core/plugin'
import { SMALL_AND_QUICK } from '@core/assistModels'

export const ASSIST_JOBS = [
  {
    id: 'docs',
    name: 'Pick the documents to show',
    does: 'Which files written in a turn are for you to read.',
    defaults: SMALL_AND_QUICK
  }
] as const satisfies readonly PluginAssistJob[]

export type WorkbenchAssistJobId = (typeof ASSIST_JOBS)[number]['id']
