import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TAB_STOPPING } from '@core/moment'
import { TEXT } from './prompts/text'
import { TEXT as SKILL_TEXT } from './skill/text'
import { CHANNELS } from './shared/ipc'

export const BROWSER_CONTROL_PAGE = 'browser-control'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'browser-control',
  name: 'Browser control',
  does: 'Agents open and drive the web pages in a session’s Workbench.',
  mandatory: true,
  needs: ['workbench'],
  settings: {
    page: { label: 'Browser control', words: ['网页控制', '浏览器控制'] },
    keys: ['browserControl']
  },
  text: [...TEXT, ...SKILL_TEXT],
  channels: Object.values(CHANNELS),
  moments: { listens: [TAB_STOPPING.name] },
  ui: [{ place: 'settings-page', id: BROWSER_CONTROL_PAGE }]
}
