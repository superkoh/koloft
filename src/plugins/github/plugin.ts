import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TEXT } from './prompts/text'
import { TEXT as SKILL_TEXT } from './skill/text'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'github',
  name: 'GitHub',
  mandatory: false,
  needs: ['sessions'],
  text: [...TEXT, ...SKILL_TEXT]
}
