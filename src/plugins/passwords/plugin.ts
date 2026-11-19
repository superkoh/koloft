import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TAB_EXITED } from '@core/moment'
import { TEXT } from './skill/text'
import { CHANNELS } from './shared/ipc'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'passwords',
  name: 'Passwords and sign-in',
  does: 'An agent asks you for a password, a code or a sign-in; the sudo box.',
  mandatory: false,
  needs: ['sessions', 'workbench'],
  commands: [{ verb: 'secret' }, { verb: 'page' }],
  text: TEXT,
  channels: Object.values(CHANNELS),
  moments: { listens: [TAB_EXITED.name] }
}
