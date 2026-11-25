import { backendIdOf, capabilitiesFor } from '@shared/sessionBackend'
import { CH, type Channel } from '@shared/ipcChannels'
import type { BackendSessionInfo, HostId } from '@shared/types'
import type { PtyManager } from './ptyManager'

interface WorktreeRemovalWatch {
  started(data: string): boolean
  failure(): string | undefined
}

interface ClaudeStoreLeaving {
  leavingWorktree(sessionId: string, tabId: string): void
  leftWorktree(sessionId: string, removed: boolean): void
}

export interface WorktreeExitFollowDeps {
  ptyMgr: Pick<PtyManager, 'get' | 'pidOf'>
  tracker: { infoOf(tabId: string): Pick<BackendSessionInfo, 'sessionId' | 'treeRoot'> | undefined }
  claudeStore(): ClaudeStoreLeaving | null
  hostOfTab(tabId: string): HostId
  sendToRenderer(channel: Channel, ...args: unknown[]): boolean
  newWatch(): WorktreeRemovalWatch
  finishAfterKoloftQuits(claudePid: number, treeRoot: string): void
}

interface ClaudeTabExit {
  watch: WorktreeRemovalWatch
  leaving?: { sessionId?: string; claudePid?: number; treeRoot?: string }
}

export function worktreeExitFollow(d: WorktreeExitFollowDeps): {
  watchForWorktreeRemoval(tabId: string, data: string): void
  tabExited(e: { id: string }): void
  koloftQuits(): void
} {
  const { ptyMgr, tracker, hostOfTab, sendToRenderer, finishAfterKoloftQuits } = d
  const claudeTabExits = new Map<string, ClaudeTabExit>()

  function watchForWorktreeRemoval(tabId: string, data: string): void {
    let exit = claudeTabExits.get(tabId)
    if (!exit) {
      const backend = backendIdOf(ptyMgr.get(tabId)?.kind)
      if (!backend || capabilitiesFor(backend, hostOfTab(tabId)).worktreeRemovalFollowed !== true)
        return
      claudeTabExits.set(tabId, (exit = { watch: d.newWatch() }))
    }
    if (!exit.watch.started(data)) return
    const session = tracker.infoOf(tabId)
    const removalOutlivesKoloftsQuit = hostOfTab(tabId) === 'ssh'
    exit.leaving = {
      sessionId: session?.sessionId,
      ...(!removalOutlivesKoloftsQuit && {
        claudePid: ptyMgr.pidOf(tabId),
        treeRoot: session?.treeRoot
      })
    }
    const claudeStore = d.claudeStore()
    if (session?.sessionId) claudeStore?.leavingWorktree(session.sessionId, tabId)
    sendToRenderer(CH.tab.killedByMain, tabId)
  }

  function tabExited(e: { id: string }): void {
    const claudeExit = claudeTabExits.get(e.id)
    claudeTabExits.delete(e.id)
    if (claudeExit?.leaving) {
      const { sessionId } = claudeExit.leaving
      const claudeSaid = claudeExit.watch.failure()
      const claudeStore = d.claudeStore()
      if (sessionId) claudeStore?.leftWorktree(sessionId, !claudeSaid)
      if (claudeSaid)
        sendToRenderer(CH.toast.show, `Claude Code did not remove the worktree: ${claudeSaid}`)
    }
  }

  function koloftQuits(): void {
    for (const { leaving } of claudeTabExits.values()) {
      if (leaving?.claudePid && leaving.treeRoot)
        finishAfterKoloftQuits(leaving.claudePid, leaving.treeRoot)
    }
    claudeTabExits.clear()
  }

  return { watchForWorktreeRemoval, tabExited, koloftQuits }
}
