import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'browser-control',
  name: 'Browser control',
  mandatory: true,
  needs: ['workbench']
}
