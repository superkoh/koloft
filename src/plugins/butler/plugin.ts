import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import {
  ATTENTION_CHANGED,
  SESSION_BOUND,
  STATE_CHANGED,
  SESSION_STARTING,
  TAB_EXITED,
  TAB_FORGOTTEN,
  TAB_TORN_DOWN,
  TURN_ENDED,
  TURN_STARTED
} from '@core/moment'
import { TEXT } from './prompts/text'
import { ASSIST_JOBS } from './shared/assistJobs'
import { CHANNELS } from './shared/ipc'

export const BUTLER_ROW_PART = 'butler-row'
export const BUTLER_RENAME = 'butler-rename'
export const BUTLER_SET_UP = 'butler-set-up'
export const BUTLER_STRIP = 'butler-strip'
export const BUTLER_INSTRUCTIONS = 'butler-instructions'
export const BUTLER_FRESH = 'butler-fresh'
export const OWNER_ASLEEP_SWITCH = 'owner-asleep'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'butler',
  name: 'Butler',
  mandatory: true,
  needs: ['sessions'],
  settings: { keys: ['butler', 'butlerSession', 'ownerAsleepSince'] },
  text: TEXT,
  channels: Object.values(CHANNELS),
  assistJobs: ASSIST_JOBS,
  moments: {
    listens: [
      SESSION_STARTING.name,
      TAB_EXITED.name,
      TAB_TORN_DOWN.name,
      TAB_FORGOTTEN.name,
      TURN_STARTED.name,
      TURN_ENDED.name,
      SESSION_BOUND.name,
      STATE_CHANGED.name,
      ATTENTION_CHANGED.name
    ]
  },
  ui: [
    { place: 'sidebar-row', id: BUTLER_ROW_PART },
    { place: 'dialog', id: BUTLER_RENAME },
    { place: 'dialog', id: BUTLER_SET_UP },
    { place: 'below-terminal', id: BUTLER_STRIP },
    { place: 'dialog', id: BUTLER_INSTRUCTIONS },
    { place: 'dialog', id: BUTLER_FRESH },
    { place: 'sidebar-foot', id: OWNER_ASLEEP_SWITCH }
  ]
}
