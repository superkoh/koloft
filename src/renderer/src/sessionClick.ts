import type { SessionRow } from '@shared/types'
import { isRemoteKey } from '@shared/remoteKey'
import { adoptionSettled } from './adoption'
import { resumeInFlight, resumeSession, wakeTab } from './resumeFlow'
import { isOrphanRow, liveTabOf } from './sessionRows'
import { useStore } from './store'

export function offerForceCloseUnlessMainHasBoundIt(row: SessionRow): void {
  void adoptionSettled.then(() => {
    const st = useStore.getState()
    if (!isOrphanRow(row, st.sessions, st.tabs)) return
    void window.api.sessions.list().then((sessionsAheadOfTheStream) => {
      if (isOrphanRow(row, sessionsAheadOfTheStream, useStore.getState().tabs))
        useStore.getState().setOrphanConfirm(row.id)
    })
  })
}

export function visitTab(tabId: string): void {
  const st = useStore.getState()
  window.api.attention.visit(tabId)
  st.activateTab(tabId)
  const tab = st.tabs.find((t) => t.id === tabId)
  if (tab?.asleep) void wakeTab(tab)
}

export function openSessionRow(row: SessionRow, wsPath: string): void {
  const st = useStore.getState()
  if (row.pending) {
    st.activateTab(row.id)
    return
  }
  if (row.running) {
    if (isOrphanRow(row, st.sessions, st.tabs)) {
      // ADR-0025
      if (isRemoteKey(wsPath)) {
        void resumeSession(row)
        return
      }
      offerForceCloseUnlessMainHasBoundIt(row)
      return
    }
    const tabId = liveTabOf(row.id, st.sessions, st.tabs)
    if (tabId) visitTab(tabId)
    return
  }
  if (resumeInFlight(row.id)) {
    const t = st.tabs.find((x) => x.sessionId === row.id && x.alive)
    if (t) st.activateTab(t.id)
    return
  }
  void resumeSession(row)
}
