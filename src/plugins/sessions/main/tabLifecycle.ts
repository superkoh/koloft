import { EventEmitter } from 'events'
import {
  TAB_EXITED,
  TAB_FORGOTTEN,
  TAB_STOPPING,
  TAB_TORN_DOWN,
  type MadeLater,
  type Moment,
  type TabEnded
} from '@core/moment'
import type { AttentionTracker } from './attention'
import type { ClaudeBackend } from '@agents/claude/main/backend'
import type { SessionTracker } from '@agents/claude/main/sessionTracker'
import type { SessionsWithStore } from '@agents/kit/main/storedSessions'
import type { WorkspaceManager } from './workspaces'

export class TabLifecycle extends EventEmitter<{
  stopping: [string, boolean]
  exit: [TabEnded]
  teardown: [TabEnded]
  slept: []
  woken: []
  forgotten: [string]
}> {}

export interface TabSubsystems {
  attention: Pick<AttentionTracker, 'clear' | 'tabStopping'>
  claude: Pick<ClaudeBackend, 'onPtyExit' | 'launchEnded'>
  tracker: Pick<SessionTracker, 'setAlive'>
  storedOwnerOf: (tabId: string) => Pick<SessionsWithStore, 'stop'> | undefined
  toast: (message: string) => void
  workspaces: MadeLater<Pick<WorkspaceManager, 'onTrackerUpdate'>>
  announce: <T>(moment: Moment<T>, m: T) => void
}

export function subscribeTabSubsystems(lifecycle: TabLifecycle, s: TabSubsystems): void {
  lifecycle.on('stopping', (tabId, restarting) => s.attention.tabStopping(tabId, restarting))
  lifecycle.on('stopping', (tabId, restarting) => s.announce(TAB_STOPPING, { tabId, restarting }))

  lifecycle.on('exit', (exit) => s.announce(TAB_EXITED, exit))

  lifecycle.on('teardown', ({ tabId }) => s.attention.clear(tabId))
  lifecycle.on('teardown', ({ tabId, crashed }) => s.claude.onPtyExit(tabId, crashed))
  lifecycle.on('teardown', ({ tabId }) => s.tracker.setAlive(tabId, false))
  lifecycle.on('teardown', ({ tabId, exitCode, signal }) => {
    void s
      .storedOwnerOf(tabId)
      ?.stop(tabId, signal ? -1 : exitCode)
      .catch((error) => s.toast(String(error)))
  })
  lifecycle.on('teardown', ({ tabId }) => s.claude.launchEnded(tabId))
  lifecycle.on('teardown', (exit) => s.announce(TAB_TORN_DOWN, exit))

  lifecycle.on('slept', () => s.workspaces()?.onTrackerUpdate())
  lifecycle.on('woken', () => s.workspaces()?.onTrackerUpdate())
  lifecycle.on('forgotten', (tabId) => s.announce(TAB_FORGOTTEN, tabId))
  lifecycle.on('forgotten', () => s.workspaces()?.onTrackerUpdate())
}
