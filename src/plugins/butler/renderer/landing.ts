import { useStore, type LandingAfterClose } from '@renderer/store'
import { butlerSetUp, butlerTabOf, isButlerTab } from './butlerTabs'

function landOnButler(): void {
  const get = useStore.getState
  if (!butlerSetUp(get())) return
  const live = butlerTabOf(get().sessions, get().butlerTab, get().tabs)
  if (live) return get().activateTab(live)
  const landedOn = get().activeTabId
  void window.api.conductors.open().then((r) => {
    if (!r.ok) return get().showToast(r.error)
    get().setButlerTab(r.tabId)
    if (get().activeTabId === landedOn) get().activateTab(r.tabId)
  })
}

export const butlerLanding: LandingAfterClose = {
  isLandingTab: (s, tabId) => isButlerTab(s.sessions, s.butlerTab, tabId),
  land: landOnButler
}
