import { useStore, type LandingAfterClose } from '@renderer/store'
import { butlerSetUp, butlerTabOf, isButlerTab } from './butlerTabs'
import { useButler } from './state'

function landOnButler(): void {
  const get = useStore.getState
  if (!butlerSetUp(get())) return
  const live = butlerTabOf(get().sessions, useButler.getState().openedTab, get().tabs)
  if (live) return get().activateTab(live)
  const landedOn = get().activeTabId
  void window.api.butler.open().then((r) => {
    if (!r.ok) return get().showToast(r.error)
    useButler.setState({ openedTab: r.tabId })
    if (get().activeTabId === landedOn) get().activateTab(r.tabId)
  })
}

export const butlerLanding: LandingAfterClose = {
  isLandingTab: (s, tabId) => isButlerTab(s.sessions, useButler.getState().openedTab, tabId),
  land: landOnButler
}

export function useButlerShowsGlobalNote(tabId: string | null, rowId: string | null): boolean {
  const openedTab = useButler((s) => s.openedTab)
  return useStore(
    (s) =>
      !!tabId &&
      (isButlerTab(s.sessions, openedTab, tabId) ||
        !!s.butlerWorkspace?.rows.some((r) => r.id === rowId))
  )
}
