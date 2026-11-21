import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import {
  ATTENTION_CHANGED,
  DIALOG_CLOSED,
  QUESTION_ASKED,
  SESSION_BOUND,
  SESSION_STARTED,
  SESSION_STARTING,
  STATE_CHANGED,
  STEP_LET_GO,
  TAB_EXITED,
  TAB_FORGOTTEN,
  TAB_STOPPING,
  TAB_TORN_DOWN,
  TOOL_DONE,
  TURN_ENDED,
  TURN_OVER,
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
  does: 'Sessions, messages between them, worktrees, handoffs, and how a session’s question reaches you.',
  mandatory: true,
  needs: [],
  commands: [
    { verb: 'help' },
    { verb: 'session' },
    { verb: 'workspace' },
    { verb: 'instructions' }
  ],
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
      SESSION_BOUND.name,
      STATE_CHANGED.name,
      TOOL_DONE.name,
      TURN_OVER.name,
      ATTENTION_CHANGED.name,
      TAB_STOPPING.name,
      DIALOG_CLOSED.name,
      STEP_LET_GO.name
    ],
    listens: [
      TAB_EXITED.name,
      TURN_STARTED.name,
      TURN_ENDED.name,
      QUESTION_ASKED.name,
      SESSION_BOUND.name,
      STATE_CHANGED.name,
      TOOL_DONE.name,
      TURN_OVER.name,
      DIALOG_CLOSED.name
    ]
  }
}
