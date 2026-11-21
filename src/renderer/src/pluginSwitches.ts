import { useMemo } from 'react'
import type { PluginManifest } from '@core/plugin'
import type { PluginState } from '@core/switches'
import { neverSetUpIn, pluginStatesIn } from '@shared/pluginSwitches'
import { useStore } from './store'
import { updateSettings } from './components/settings/useSettingsUpdate'

export function usePluginStates(): Record<string, PluginState> {
  const settings = useStore((s) => s.settings)
  return useMemo(() => pluginStatesIn(settings), [settings])
}

export function useNeverSetUp(plugin: PluginManifest): boolean {
  return useStore((s) => neverSetUpIn(plugin, s.settings))
}

export function setPluginOn(id: string, on: boolean): void {
  const { pluginsOn } = useStore.getState().settings
  updateSettings({ pluginsOn: { ...pluginsOn, [id]: on } })
}

const BUTLER_NAME = /\{\{butler-name\}\}/g

export function useDoes(plugin: PluginManifest): string {
  const name = useStore((s) => s.settings.butler.name)
  return plugin.does.replace(BUTLER_NAME, () => name)
}
