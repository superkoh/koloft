import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TEXT } from './skill/text'
import { CHANNELS } from './shared/channels'

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
  ui: [
    { place: 'dialog', id: SCHEDULED_JOBS_DIALOG },
    { place: 'palette-item', id: SCHEDULED_JOBS }
  ]
}
