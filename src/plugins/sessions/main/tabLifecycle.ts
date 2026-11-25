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
import type { SessionBackends } from '@core/agent/sessionBackends'
import type { AttentionTracker } from './attention'
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
  backends: Pick<SessionBackends, 'tabExited'>
  toast: (message: string) => void
  workspaces: MadeLater<Pick<WorkspaceManager, 'sessionsChanged'>>
  announce: <T>(moment: Moment<T>, m: T) => void
}

export function subscribeTabSubsystems(lifecycle: TabLifecycle, s: TabSubsystems): void {
  lifecycle.on('stopping', (tabId, restarting) => s.attention.tabStopping(tabId, restarting))
  lifecycle.on('stopping', (tabId, restarting) => s.announce(TAB_STOPPING, { tabId, restarting }))

  lifecycle.on('exit', (exit) => s.announce(TAB_EXITED, exit))

  lifecycle.on('teardown', ({ tabId }) => s.attention.clear(tabId))
  lifecycle.on('teardown', (exit) => s.backends.tabExited(exit, (error) => s.toast(String(error))))
  lifecycle.on('teardown', (exit) => s.announce(TAB_TORN_DOWN, exit))

  lifecycle.on('slept', () => s.workspaces()?.sessionsChanged())
  lifecycle.on('woken', () => s.workspaces()?.sessionsChanged())
  lifecycle.on('forgotten', (tabId) => s.announce(TAB_FORGOTTEN, tabId))
  lifecycle.on('forgotten', () => s.workspaces()?.sessionsChanged())
}
