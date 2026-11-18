import { useStore } from '@renderer/store'
import { visitTab } from '@renderer/sessionClick'

export async function setUpDiscordWithButler(ownerWords?: string): Promise<string | null> {
  const r = await window.api.discord.setUpWithButler(ownerWords)
  if (!r.ok) return r.error
  useStore.getState().setSettingsOpen(false)
  visitTab(r.tabId)
  return null
}
