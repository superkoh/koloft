import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TEXT } from './skill/text'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'workbench',
  name: 'Workbench',
  mandatory: true,
  needs: [],
  text: TEXT
}
