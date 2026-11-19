import { EventEmitter } from 'events'
import {
  TAB_EXITED,
  TAB_FORGOTTEN,
  TAB_TORN_DOWN,
  type MadeLater,
  type Moments,
  type TabEnded
} from '@core/moment'
import type { AttentionTracker } from './attention'
import type { ClaudeBackend } from './backends/claude'
import type { SessionTracker } from './sessionTracker'
import type { SessionsWithStore } from './storedSessions'
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
  cdpTabClosed: (tabId: string) => void
  claude: Pick<ClaudeBackend, 'onPtyExit'>
  tracker: Pick<SessionTracker, 'setAlive'>
  storedOwnerOf: (tabId: string) => Pick<SessionsWithStore, 'stop'> | undefined
  toast: (message: string) => void
  workspaces: MadeLater<Pick<WorkspaceManager, 'launchEnded' | 'onTrackerUpdate'>>
  moments: Pick<Moments, 'announce'>
  failed: (error: unknown) => void
}

export function subscribeTabSubsystems(lifecycle: TabLifecycle, s: TabSubsystems): void {
  lifecycle.on('stopping', (tabId, restarting) => s.attention.tabStopping(tabId, restarting))
  lifecycle.on('stopping', (tabId) => s.cdpTabClosed(tabId))

  lifecycle.on('exit', (exit) => void s.moments.announce(TAB_EXITED, exit).catch(s.failed))

  lifecycle.on('teardown', ({ tabId }) => s.attention.clear(tabId))
  lifecycle.on('teardown', ({ tabId, crashed }) => s.claude.onPtyExit(tabId, crashed))
  lifecycle.on('teardown', ({ tabId }) => s.tracker.setAlive(tabId, false))
  lifecycle.on('teardown', ({ tabId, exitCode, signal }) => {
    void s
      .storedOwnerOf(tabId)
      ?.stop(tabId, signal ? -1 : exitCode)
      .catch((error) => s.toast(String(error)))
  })
  lifecycle.on('teardown', ({ tabId }) => s.workspaces()?.launchEnded(tabId))
  lifecycle.on('teardown', (exit) => void s.moments.announce(TAB_TORN_DOWN, exit).catch(s.failed))

  lifecycle.on('slept', () => s.workspaces()?.onTrackerUpdate())
  lifecycle.on('woken', () => s.workspaces()?.onTrackerUpdate())
  lifecycle.on(
    'forgotten',
    (tabId) => void s.moments.announce(TAB_FORGOTTEN, tabId).catch(s.failed)
  )
  lifecycle.on('forgotten', () => s.workspaces()?.onTrackerUpdate())
}
