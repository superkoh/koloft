import { create } from 'zustand'
import { useStore } from '@renderer/store'

interface ButlerState {
  openedTab: string | null
  renaming: boolean
  setUpAsked: boolean
}

export const useButler = create<ButlerState>(() => ({
  openedTab: null,
  renaming: false,
  setUpAsked: false
}))

export async function openButler(fresh = false): Promise<void> {
  const r = await (fresh ? window.api.conductors.startFresh() : window.api.conductors.open())
  if (!r.ok) return useStore.getState().showToast(r.error)
  useButler.setState({ openedTab: r.tabId })
  useStore.getState().activateTab(r.tabId)
}
