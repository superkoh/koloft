import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TEXT } from './prompts/text'
import { TEXT as SKILL_TEXT } from './skill/text'

export const DISCORD_BIND = 'discord-bind'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'discord',
  name: 'Discord',
  mandatory: false,
  needs: ['butler'],
  commands: [{ verb: 'discord' }],
  text: [...TEXT, ...SKILL_TEXT],
  ui: [{ place: 'dialog', id: DISCORD_BIND }]
}
