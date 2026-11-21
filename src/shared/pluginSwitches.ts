import type { PluginManifest } from '@core/plugin'
import type { SavedSettings } from '@core/settings'
import { knowPluginStates, neverSetUp, pluginStates, type PluginState } from '@core/switches'
import { PLUGINS } from '@plugins/list'
import { DEFAULT_SETTINGS } from './settingsOps'
import type { Settings } from './types'

const saved = (settings: Settings): SavedSettings => settings as unknown as SavedSettings

export const pluginStatesIn = (settings: Settings): Record<string, PluginState> =>
  pluginStates(PLUGINS, saved(settings), saved(DEFAULT_SETTINGS))

export const neverSetUpIn = (plugin: PluginManifest, settings: Settings): boolean =>
  neverSetUp(plugin, saved(settings), saved(DEFAULT_SETTINGS))

let lastKnown = ''

export function knowSwitchesIn(settings: Settings): boolean {
  const states = pluginStatesIn(settings)
  knowPluginStates(states)
  const now = JSON.stringify(Object.entries(states).map(([id, s]) => [id, s.on]))
  const changed = now !== lastKnown
  lastKnown = now
  return changed
}
