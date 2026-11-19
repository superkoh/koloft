import { useMemo } from 'react'
import type { PluginManifest } from '@core/plugin'
import type { SavedSettings } from '@core/settings'
import { neverSetUp, pluginStates, type PluginState } from '@core/switches'
import { PLUGINS } from '@plugins/list'
import { DEFAULT_SETTINGS } from '@shared/settingsOps'
import type { Settings } from '@shared/types'
import { useStore } from './store'
import { updateSettings } from './components/settings/useSettingsUpdate'

const saved = (settings: Settings): SavedSettings => settings as unknown as SavedSettings

export function usePluginStates(): Record<string, PluginState> {
  const settings = useStore((s) => s.settings)
  return useMemo(
    () => pluginStates(PLUGINS, settings.pluginsOn, saved(settings), saved(DEFAULT_SETTINGS)),
    [settings]
  )
}

export function useNeverSetUp(plugin: PluginManifest): boolean {
  return useStore((s) => neverSetUp(plugin, saved(s.settings), saved(DEFAULT_SETTINGS)))
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
