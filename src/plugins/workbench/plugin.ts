import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { FILE_OPENED } from '@core/moment'
import { TEXT } from './skill/text'
import { ASSIST_JOBS } from './shared/assistJobs'
import { CHANNELS } from './shared/ipc'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'workbench',
  name: 'Workbench',
  does: 'Files, web pages and diffs beside each session; the file browser; the note.',
  mandatory: true,
  needs: [],
  commands: [{ verb: 'open' }, { verb: 'diff' }, { verb: 'note' }],
  text: TEXT,
  assistJobs: ASSIST_JOBS,
  channels: Object.values(CHANNELS),
  moments: { announces: [FILE_OPENED.name] }
}
