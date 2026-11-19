import { useStore } from '@renderer/store'
import { visitTab } from '@renderer/sessionClick'
import { setPluginOn } from '@renderer/pluginSwitches'
import { plugin } from '../plugin'

export async function setUpDiscordWithButler(ownerWords?: string): Promise<string | null> {
  setPluginOn(plugin.id, true)
  const r = await window.api.discord.setUpWithButler(ownerWords)
  if (!r.ok) return r.error
  useStore.getState().setSettingsOpen(false)
  visitTab(r.tabId)
  return null
}
