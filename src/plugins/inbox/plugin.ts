import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TEXT } from './skill/text'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'inbox',
  name: 'Inbox',
  mandatory: true,
  needs: ['sessions'],
  commands: [{ verb: 'inbox' }],
  text: TEXT
}
