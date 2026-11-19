import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
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
  commands: [{ verb: 'help' }, { verb: 'session' }, { verb: 'workspace' }],
  text: [...TEXT, ...SKILL_TEXT],
  assistJobs: ASSIST_JOBS,
  channels: Object.values(CHANNELS)
}
