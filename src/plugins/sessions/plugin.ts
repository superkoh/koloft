import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import {
  QUESTION_ASKED,
  SESSION_BOUND,
  SESSION_STARTED,
  SESSION_STARTING,
  TAB_EXITED,
  TAB_FORGOTTEN,
  TAB_TORN_DOWN,
  TURN_ENDED,
  TURN_STARTED
} from '@core/moment'
import { TEXT } from './prompts/text'
import { TEXT as SKILL_TEXT } from './skill/text'
import { ASSIST_JOBS } from './shared/assistJobs'
import { CHANNELS } from './shared/ipc'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'sessions',
  name: 'Sessions core',
  mandatory: true,
  needs: [],
  commands: [{ verb: 'help' }, { verb: 'session' }, { verb: 'workspace' }],
  text: [...TEXT, ...SKILL_TEXT],
  assistJobs: ASSIST_JOBS,
  channels: Object.values(CHANNELS),
  moments: {
    announces: [
      SESSION_STARTING.name,
      SESSION_STARTED.name,
      TAB_EXITED.name,
      TAB_TORN_DOWN.name,
      TAB_FORGOTTEN.name,
      TURN_STARTED.name,
      TURN_ENDED.name,
      QUESTION_ASKED.name,
      SESSION_BOUND.name
    ],
    listens: [
      TAB_EXITED.name,
      TURN_STARTED.name,
      TURN_ENDED.name,
      QUESTION_ASKED.name,
      SESSION_BOUND.name
    ]
  }
}
