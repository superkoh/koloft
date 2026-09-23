import type { Settings } from '@shared/types'
import { useStore } from '../../store'

export function updateSettings(patch: Partial<Settings>): void {
  useStore.getState().setSettings({ ...useStore.getState().settings, ...patch })
  void window.api.settings.set(patch)
}

export function useSettingsUpdate(): (patch: Partial<Settings>) => void {
  return updateSettings
}
