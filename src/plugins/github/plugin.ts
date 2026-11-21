import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TEXT } from './prompts/text'
import { TEXT as SKILL_TEXT } from './skill/text'
import { CHANNELS } from './shared/ipc'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'github',
  name: 'GitHub',
  does: 'koloft gh, PR and issue counts in the sidebar, PRs in the Workbench, a worktree from a PR, a session from an issue.',
  mandatory: false,
  needs: ['sessions'],
  commands: [{ verb: 'gh' }],
  hints: ['github'],
  text: [...TEXT, ...SKILL_TEXT],
  channels: Object.values(CHANNELS)
}
