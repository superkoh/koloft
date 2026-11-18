import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TEXT } from './prompts/text'
import { TEXT as SKILL_TEXT } from './skill/text'
import { CHANNELS } from './shared/channels'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'github',
  name: 'GitHub',
  mandatory: false,
  needs: ['sessions'],
  commands: [{ verb: 'gh' }],
  text: [...TEXT, ...SKILL_TEXT],
  channels: Object.values(CHANNELS)
}
