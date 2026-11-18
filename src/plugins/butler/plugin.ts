import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TEXT } from './prompts/text'
import { ASSIST_JOBS } from './shared/assistJobs'
import { CHANNELS } from './shared/channels'

export const BUTLER_ROW_PART = 'butler-row'
export const BUTLER_RENAME = 'butler-rename'
export const BUTLER_SET_UP = 'butler-set-up'
export const BUTLER_STRIP = 'butler-strip'
export const BUTLER_INSTRUCTIONS = 'butler-instructions'
export const BUTLER_FRESH = 'butler-fresh'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'butler',
  name: 'Butler',
  mandatory: true,
  needs: ['sessions'],
  text: TEXT,
  channels: Object.values(CHANNELS),
  assistJobs: ASSIST_JOBS,
  ui: [
    { place: 'sidebar-row', id: BUTLER_ROW_PART },
    { place: 'dialog', id: BUTLER_RENAME },
    { place: 'dialog', id: BUTLER_SET_UP },
    { place: 'below-terminal', id: BUTLER_STRIP },
    { place: 'dialog', id: BUTLER_INSTRUCTIONS },
    { place: 'dialog', id: BUTLER_FRESH }
  ]
}
