import type { Settings } from '@shared/types'
import { useStore } from '../../store'

/** FR-14: the shared optimistic-update helper. Store first so a controlled input
 *  reflects the keystroke in the same render (otherwise the caret jumps to the end
 *  on every character); persistence still flows through settings.set, whose echoed
 *  settings:update carries the same value. */
export function updateSettings(patch: Partial<Settings>): void {
  useStore.getState().setSettings({ ...useStore.getState().settings, ...patch })
  void window.api.settings.set(patch)
}

/** The same function every render, so an effect that saves can depend on it. */
export function useSettingsUpdate(): (patch: Partial<Settings>) => void {
  return updateSettings
}
