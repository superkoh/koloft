import { backendIdOf } from '@shared/sessionBackend'
import { CH, type Channel } from '@shared/ipcChannels'
import type { BackendId, HostId } from '@shared/types'
import { agentManifest } from '@core/agent/registry'
import type { WorktreeExitWatch } from '@core/agent/sessionBackends'
import type { PtyManager } from './ptyManager'

export interface WorktreeExitFollowDeps {
  ptyMgr: Pick<PtyManager, 'get'>
  watchOf(backend: BackendId, tabId: string, hostOfTab: () => HostId): WorktreeExitWatch | undefined
  hostOfTab(tabId: string): HostId
  sendToRenderer(channel: Channel, ...args: unknown[]): boolean
}

export function worktreeExitFollow(d: WorktreeExitFollowDeps): {
  watchForWorktreeRemoval(tabId: string, data: string): void
  tabExited(e: { id: string }): void
  koloftQuits(): void
} {
  const { ptyMgr, hostOfTab, sendToRenderer } = d
  const tabExits = new Map<string, WorktreeExitWatch>()

  function watchForWorktreeRemoval(tabId: string, data: string): void {
    let exit = tabExits.get(tabId)
    if (!exit) {
      const backend = backendIdOf(ptyMgr.get(tabId)?.kind)
      if (!backend || !agentManifest(backend).flags.removesItsWorktreeAsItExits) return
      exit = d.watchOf(backend, tabId, () => hostOfTab(tabId))
      if (!exit) return
      tabExits.set(tabId, exit)
    }
    if (!exit.startedRemoving(data)) return
    sendToRenderer(CH.tab.killedByMain, tabId)
  }

  function tabExited(e: { id: string }): void {
    const exit = tabExits.get(e.id)
    tabExits.delete(e.id)
    const failure = exit?.failedSaying()
    if (failure) sendToRenderer(CH.toast.show, failure)
  }

  function koloftQuits(): void {
    for (const exit of tabExits.values()) exit.koloftQuits()
    tabExits.clear()
  }

  return { watchForWorktreeRemoval, tabExited, koloftQuits }
}
