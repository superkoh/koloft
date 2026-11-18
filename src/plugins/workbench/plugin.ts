import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TEXT } from './skill/text'
import { ASSIST_JOBS } from './shared/assistJobs'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'workbench',
  name: 'Workbench',
  mandatory: true,
  needs: [],
  commands: [{ verb: 'open' }, { verb: 'diff' }, { verb: 'note' }],
  text: TEXT,
  assistJobs: ASSIST_JOBS
}
