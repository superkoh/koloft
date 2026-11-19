import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TAB_STOPPING } from '@core/moment'
import { TEXT } from './prompts/text'
import { TEXT as SKILL_TEXT } from './skill/text'
import { CHANNELS } from './shared/ipc'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'browser-control',
  name: 'Browser control',
  mandatory: true,
  needs: ['workbench'],
  settings: { keys: ['browserControl'] },
  text: [...TEXT, ...SKILL_TEXT],
  channels: Object.values(CHANNELS),
  moments: { listens: [TAB_STOPPING.name] }
}
