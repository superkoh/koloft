import { create } from 'zustand'
import { useStore } from '@renderer/store'
import type { InstructionsChange } from '@core/ownerInstructions'

interface ButlerState {
  openedTab: string | null
  renaming: boolean
  setUpAsked: boolean
  editingInstructions: boolean
  viewingChange: InstructionsChange | null
  changeUndone: boolean
  askingFresh: boolean
}

export const useButler = create<ButlerState>(() => ({
  openedTab: null,
  renaming: false,
  setUpAsked: false,
  editingInstructions: false,
  viewingChange: null,
  changeUndone: false,
  askingFresh: false
}))

export const renameButler = (renaming: boolean): void => useButler.setState({ renaming })

export async function openButler(fresh = false): Promise<void> {
  const r = await (fresh ? window.api.butler.startFresh() : window.api.butler.open())
  if (!r.ok) return useStore.getState().showToast(r.error)
  useButler.setState({ openedTab: r.tabId })
  useStore.getState().activateTab(r.tabId)
}
