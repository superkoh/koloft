import { closeTabIntent } from './closeSession'
import { releaseResume } from './resumeFlow'
import { useStore } from './store'
import { dirtyIn, discardAll, labelPaths, saveAll } from './unsavedGuard'

export function requestCloseTab(tabId: string | null): void {
  const st = useStore.getState()
  const tab = st.tabs.find((t) => t.id === tabId)
  const intent = closeTabIntent(tab, st.sessions)
  if (intent.kind === 'none') return
  const dirty = dirtyIn(tab!.id)
  const close = (): void => {
    // ADR-0023
    if (tab!.sessionId) releaseResume(tab!.sessionId)
    st.closeTab(tab!.id)
  }
  if (intent.kind === 'confirm') {
    st.setCloseConfirm({
      tabId: tab!.id,
      title: intent.title,
      status: intent.status,
      ...(dirty.length
        ? {
            unsaved: {
              files: labelPaths(dirty),
              discard: () => discardAll(dirty),
              save: () => saveAll(dirty)
            }
          }
        : {})
    })
    return
  }
  if (dirty.length) {
    st.setUnsavedPrompt({
      files: labelPaths(dirty),
      onCancel: () => {},
      onDiscard: () => {
        discardAll(dirty)
        close()
      },
      onSave: async () => {
        const ok = await saveAll(dirty)
        useStore.getState().setUnsavedPrompt(null)
        if (ok) close()
      }
    })
    return
  }
  close()
}
