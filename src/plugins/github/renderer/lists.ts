import { useStore } from '@renderer/store'
import { workspaceWorkbenchKey } from '@shared/workbenchState'

const GITHUB_LIST_UNREACHABLE_NOTICE = 'Could not find this workspace’s GitHub page — try again.'

export function openWorkspaceList(path: string, what: 'issues' | 'pulls'): void {
  const st = useStore.getState()
  st.selectWorkspace(path)
  void window.api.github
    .target(path, what)
    .then((url) => {
      if (!url) return useStore.getState().showToast(GITHUB_LIST_UNREACHABLE_NOTICE)
      useStore.getState().openWorkbenchTarget(workspaceWorkbenchKey(path), { url, source: 'user' })
    })
    .catch(() => useStore.getState().showToast(GITHUB_LIST_UNREACHABLE_NOTICE))
}
