import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { FILE_OPENED, SESSION_STARTED, TAB_EXITED } from '@core/moment'
import { TEXT } from './prompts/text'
import { TEXT as SKILL_TEXT } from './skill/text'
import { CHANNELS } from './shared/ipc'

export const DISCORD_BIND = 'discord-bind'
export const DISCORD_PAGE = 'discord'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'discord',
  name: 'Discord',
  mandatory: false,
  needs: ['butler'],
  settings: { page: { label: 'Discord', words: ['机器人'] }, keys: ['discord'] },
  commands: [{ verb: 'discord' }],
  text: [...TEXT, ...SKILL_TEXT],
  ui: [
    { place: 'dialog', id: DISCORD_BIND },
    { place: 'settings-page', id: DISCORD_PAGE }
  ],
  channels: Object.values(CHANNELS),
  moments: { listens: [FILE_OPENED.name, SESSION_STARTED.name, TAB_EXITED.name] }
}
