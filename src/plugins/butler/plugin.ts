import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'
import { TEXT } from './prompts/text'
import { ASSIST_JOBS } from './shared/assistJobs'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'butler',
  name: 'Butler',
  mandatory: true,
  needs: ['sessions'],
  settings: { keys: ['butler', 'butlerSession'] },
  text: TEXT,
  assistJobs: ASSIST_JOBS
}
