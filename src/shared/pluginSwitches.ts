import type { PluginManifest } from '@core/plugin'
import type { SavedSettings } from '@core/settings'
import { knowPluginStates, neverSetUp, pluginStates, type PluginState } from '@core/switches'
import { PLUGINS } from '@plugins/list'
import { DEFAULT_SETTINGS } from './settingsOps'
import type { Settings } from './types'

const SWITCHES_THAT_ACT: ReadonlySet<string> = new Set(['todo', 'docs-writing', 'passwords'])

const saved = (settings: Settings): SavedSettings => settings as unknown as SavedSettings

export const pluginStatesIn = (settings: Settings): Record<string, PluginState> =>
  pluginStates(PLUGINS, saved(settings), saved(DEFAULT_SETTINGS))

export const neverSetUpIn = (plugin: PluginManifest, settings: Settings): boolean =>
  neverSetUp(plugin, saved(settings), saved(DEFAULT_SETTINGS))

let lastKnown = ''

export function knowSwitchesIn(settings: Settings): boolean {
  const all = pluginStatesIn(settings)
  const acting = Object.fromEntries(Object.entries(all).filter(([id]) => SWITCHES_THAT_ACT.has(id)))
  knowPluginStates(acting)
  const now = JSON.stringify(Object.entries(acting).map(([id, s]) => [id, s.on]))
  const changed = now !== lastKnown
  lastKnown = now
  return changed
}
