import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TEXT } from './skill/text'
import { CHANNELS } from './shared/ipc'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'scheduled-tasks',
  name: 'Scheduled tasks',
  mandatory: true,
  needs: ['sessions'],
  commands: [{ verb: 'cron' }],
  text: TEXT,
  channels: Object.values(CHANNELS)
}
