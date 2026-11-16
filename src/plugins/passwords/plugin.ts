import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'passwords',
  name: 'Passwords and sign-in',
  mandatory: false,
  needs: ['sessions', 'workbench']
}
