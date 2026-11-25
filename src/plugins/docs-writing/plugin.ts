import { PLUGIN_FORMAT_VERSION, type PluginManifest } from '@core/plugin'

export const plugin: PluginManifest = {
  formatVersion: PLUGIN_FORMAT_VERSION,
  id: 'docs-writing',
  name: 'Docs writing',
  does: 'The koloft-docs skill: how agents write documents for you to read.',
  mandatory: false,
  needs: [],
  skills: [{ name: 'koloft-docs', group: 'koloft-docs' }]
}
