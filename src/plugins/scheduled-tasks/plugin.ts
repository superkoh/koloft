import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { SESSION_BOUND, STATE_CHANGED, TAB_TORN_DOWN } from '@core/moment'
import { TEXT } from './skill/text'
import { CHANNELS } from './shared/ipc'

export const SCHEDULED_JOBS_DIALOG = 'scheduled-jobs-dialog'
export const SCHEDULED_JOBS = 'scheduled-jobs'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'scheduled-tasks',
  name: 'Scheduled tasks',
  mandatory: true,
  needs: ['sessions'],
  commands: [{ verb: 'cron' }],
  text: TEXT,
  channels: Object.values(CHANNELS),
  moments: { listens: [TAB_TORN_DOWN.name, SESSION_BOUND.name, STATE_CHANGED.name] },
  ui: [
    { place: 'dialog', id: SCHEDULED_JOBS_DIALOG },
    { place: 'palette-item', id: SCHEDULED_JOBS }
  ]
}
