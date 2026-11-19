import type { SavedSettings } from '@core/settings'
import { knowPluginStates, pluginStates } from '@core/switches'
import { PLUGINS } from '@plugins/list'
import { DEFAULT_SETTINGS } from './settingsOps'
import type { Settings } from './types'

const SWITCHES_THAT_ACT: ReadonlySet<string> = new Set(['todo'])

const saved = (settings: Settings): SavedSettings => settings as unknown as SavedSettings

let lastKnown = ''

export function knowSwitchesIn(settings: Settings): boolean {
  const all = pluginStates(PLUGINS, saved(settings), saved(DEFAULT_SETTINGS))
  const acting = Object.fromEntries(Object.entries(all).filter(([id]) => SWITCHES_THAT_ACT.has(id)))
  knowPluginStates(acting)
  const now = JSON.stringify(Object.entries(acting).map(([id, s]) => [id, s.on]))
  const changed = now !== lastKnown
  lastKnown = now
  return changed
}
