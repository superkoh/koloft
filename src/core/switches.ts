// ADR-0051
import type { PluginManifest } from './plugin'
import type { SavedSettings } from './settings'

export const SWITCHES_KEY = 'pluginsOn'

export interface PluginState {
  on: boolean
  offBecause?: PluginManifest
}

export function cleanSwitches(
  plugins: readonly PluginManifest[],
  raw: unknown
): Record<string, boolean> {
  if (!raw || typeof raw !== 'object') return {}
  const saved = raw as Record<string, unknown>
  return Object.fromEntries(
    plugins
      .filter((p) => !p.mandatory && typeof saved[p.id] === 'boolean')
      .map((p) => [p.id, saved[p.id] as boolean])
  )
}

export function neverSetUp(
  plugin: PluginManifest,
  settings: SavedSettings,
  defaults: SavedSettings
): boolean {
  const key = plugin.offUntilSetUp
  return !!key && JSON.stringify(settings[key]) === JSON.stringify(defaults[key])
}

export function pluginStates(
  plugins: readonly PluginManifest[],
  settings: SavedSettings,
  defaults: SavedSettings
): Record<string, PluginState> {
  const switches = cleanSwitches(plugins, settings[SWITCHES_KEY])
  const states: Record<string, PluginState> = {}
  const stateOf = (plugin: PluginManifest): PluginState => {
    if (states[plugin.id]) return states[plugin.id]
    const chosen =
      plugin.mandatory || (switches[plugin.id] ?? !neverSetUp(plugin, settings, defaults))
    const offNeed = plugin.needs
      .map((id) => plugins.find((p) => p.id === id)!)
      .find((need) => !stateOf(need).on)
    return (states[plugin.id] = offNeed ? { on: false, offBecause: offNeed } : { on: chosen })
  }
  for (const plugin of plugins) stateOf(plugin)
  return states
}

const ON: PluginState = { on: true }

let known: Readonly<Record<string, PluginState>> = {}

export function knowPluginStates(states: Readonly<Record<string, PluginState>>): void {
  known = states
}

export const pluginStateOf = (id: string): PluginState => known[id] ?? ON

export const switchesThatAct = (): Record<string, boolean> =>
  Object.fromEntries(Object.entries(known).map(([id, state]) => [id, state.on]))

export function turnedOffLine(plugin: PluginManifest): string | undefined {
  const state = pluginStateOf(plugin.id)
  if (state.on) return undefined
  return state.offBecause
    ? `${plugin.name} is off because ${state.offBecause.name} is turned off in Settings ▸ Plugins.`
    : `${plugin.name} is turned off in Settings ▸ Plugins.`
}
