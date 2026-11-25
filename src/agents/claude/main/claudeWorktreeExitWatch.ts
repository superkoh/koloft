import type { WorktreeExitWatch } from '@core/agent/sessionBackends'
import type { BackendSessionInfo, HostId } from '@shared/types'
import { WorktreeRemovalWatch } from './claudeWorktreeExit'

export interface ClaudeWorktreeExitDeps {
  pidOf(tabId: string): number | undefined
  infoOf(tabId: string): Pick<BackendSessionInfo, 'sessionId' | 'treeRoot'> | undefined
  store(): {
    leavingWorktree(sessionId: string, tabId: string): void
    leftWorktree(sessionId: string, removed: boolean): void
  } | null
  finishAfterKoloftQuits(claudePid: number, treeRoot: string): void
}

// CC§4
export function claudeWorktreeExitWatch(
  tabId: string,
  hostOfTab: () => HostId,
  d: ClaudeWorktreeExitDeps
): WorktreeExitWatch {
  const watch = new WorktreeRemovalWatch()
  let leaving: { sessionId?: string; claudePid?: number; treeRoot?: string } | undefined
  return {
    startedRemoving(data) {
      if (!watch.started(data)) return false
      const session = d.infoOf(tabId)
      const removalOutlivesKoloftsQuit = hostOfTab() === 'ssh'
      leaving = {
        sessionId: session?.sessionId,
        ...(!removalOutlivesKoloftsQuit && {
          claudePid: d.pidOf(tabId),
          treeRoot: session?.treeRoot
        })
      }
      if (session?.sessionId) d.store()?.leavingWorktree(session.sessionId, tabId)
      return true
    },
    failedSaying() {
      if (!leaving) return undefined
      const { sessionId } = leaving
      const claudeSaid = watch.failure()
      if (sessionId) d.store()?.leftWorktree(sessionId, !claudeSaid)
      return claudeSaid ? `Claude Code did not remove the worktree: ${claudeSaid}` : undefined
    },
    koloftQuits() {
      if (leaving?.claudePid && leaving.treeRoot)
        d.finishAfterKoloftQuits(leaving.claudePid, leaving.treeRoot)
    }
  }
}
