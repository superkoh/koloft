import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'butler',
  name: 'Butler',
  mandatory: true,
  needs: ['sessions']
}
