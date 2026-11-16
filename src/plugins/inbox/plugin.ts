import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'inbox',
  name: 'Inbox',
  mandatory: true,
  needs: ['sessions']
}
