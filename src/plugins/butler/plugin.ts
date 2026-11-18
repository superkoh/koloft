import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TEXT } from './prompts/text'
import { ASSIST_JOBS } from './shared/assistJobs'

export const BUTLER_ROW_PART = 'butler-row'
export const BUTLER_RENAME = 'butler-rename'
export const BUTLER_SET_UP = 'butler-set-up'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'butler',
  name: 'Butler',
  mandatory: true,
  needs: ['sessions'],
  text: TEXT,
  assistJobs: ASSIST_JOBS,
  ui: [
    { place: 'sidebar-row', id: BUTLER_ROW_PART },
    { place: 'dialog', id: BUTLER_RENAME },
    { place: 'dialog', id: BUTLER_SET_UP }
  ]
}
