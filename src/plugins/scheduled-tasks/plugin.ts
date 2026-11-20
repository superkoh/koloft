import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { SESSION_BOUND, STATE_CHANGED, TAB_TORN_DOWN } from '@core/moment'
import { TEXT } from './prompts/text'
import { TEXT as SKILL_TEXT } from './skill/text'
import { CHANNELS } from './shared/ipc'

export const SCHEDULED_JOBS_DIALOG = 'scheduled-jobs-dialog'
export const SCHEDULED_JOBS = 'scheduled-jobs'
export const SCHEDULED_JOBS_LABEL = 'Scheduled jobs…'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'scheduled-tasks',
  name: 'Scheduled tasks',
  does: 'Starts sessions on a schedule.',
  mandatory: true,
  needs: ['sessions'],
  commands: [{ verb: 'cron' }],
  text: [...TEXT, ...SKILL_TEXT],
  channels: Object.values(CHANNELS),
  moments: { listens: [TAB_TORN_DOWN.name, SESSION_BOUND.name, STATE_CHANGED.name] },
  ui: [
    { place: 'dialog', id: SCHEDULED_JOBS_DIALOG },
    {
      place: 'palette-item',
      id: SCHEDULED_JOBS,
      label: SCHEDULED_JOBS_LABEL,
      words: ['定时任务', '计划任务', 'cron'],
      actsOnCurrent: true
    }
  ]
}
