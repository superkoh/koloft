import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TEXT } from './skill/text'
import { CHANNELS } from './shared/channels'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'passwords',
  name: 'Passwords and sign-in',
  mandatory: false,
  needs: ['sessions', 'workbench'],
  commands: [{ verb: 'secret' }, { verb: 'page' }],
  text: TEXT,
  channels: Object.values(CHANNELS)
}
