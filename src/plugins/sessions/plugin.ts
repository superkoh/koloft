import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import {
  SESSION_STARTED,
  SESSION_STARTING,
  TAB_EXITED,
  TAB_FORGOTTEN,
  TAB_TORN_DOWN
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
    announces: [SESSION_STARTING, SESSION_STARTED, TAB_EXITED, TAB_TORN_DOWN, TAB_FORGOTTEN].map(
      (m) => m.name
    ),
    listens: [TAB_EXITED.name]
  }
}
