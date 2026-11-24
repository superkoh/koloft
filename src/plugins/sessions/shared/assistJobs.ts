import type { PluginAssistJob } from '@core/plugin'

export const ASSIST_JOBS = [
  {
    id: 'title',
    name: 'Name a new session',
    does: 'A short title for a session that an agent or your butler starts.',
    kind: 'smallAndQuick'
  },
  {
    id: 'handover',
    name: 'Translate a handover',
    does: 'The note a new session gets, in your language.',
    kind: 'smallAndQuick'
  },
  {
    id: 'turn',
    name: 'After each turn',
    does: 'Decides whether a reply needs you or is only news, and offers one-click answers.',
    kind: 'judgesAReply'
  }
] as const satisfies readonly PluginAssistJob[]

export type SessionsAssistJobId = (typeof ASSIST_JOBS)[number]['id']
