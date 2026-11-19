import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { ATTENTION_CHANGED, QUESTION_ASKED, SESSION_BOUND, TURN_ENDED } from '@core/moment'
import { TEXT } from './skill/text'
import { CHANNELS } from './shared/ipc'

export const INBOX_ROW = 'inbox-row'
export const INBOX_PAGE = 'inbox-page'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'inbox',
  name: 'Inbox',
  mandatory: true,
  needs: ['sessions'],
  commands: [{ verb: 'inbox' }],
  text: TEXT,
  channels: Object.values(CHANNELS),
  moments: {
    listens: [TURN_ENDED.name, QUESTION_ASKED.name, SESSION_BOUND.name, ATTENTION_CHANGED.name]
  },
  ui: [
    { place: 'sidebar-head', id: INBOX_ROW },
    { place: 'centre-page', id: INBOX_PAGE }
  ]
}
