import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TEXT } from './skill/text'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'scheduled-tasks',
  name: 'Scheduled tasks',
  mandatory: true,
  needs: ['sessions'],
  commands: [{ verb: 'cron' }],
  text: TEXT
}
