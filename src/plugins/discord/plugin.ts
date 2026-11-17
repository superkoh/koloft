import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TEXT } from './prompts/text'
import { TEXT as SKILL_TEXT } from './skill/text'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'discord',
  name: 'Discord',
  mandatory: false,
  needs: ['butler'],
  text: [...TEXT, ...SKILL_TEXT]
}
