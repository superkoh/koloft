import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TEXT } from './skill/text'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'passwords',
  name: 'Passwords and sign-in',
  mandatory: false,
  needs: ['sessions', 'workbench'],
  text: TEXT
}
