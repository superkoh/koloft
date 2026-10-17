import type { AttentionTracker } from './attention'
import type { ClaudeBackend } from './backends/claude'
import type { CronRunner, LeftTab } from './cronRunner'
import type { AskButtons } from './discord/buttons'
import type { Conductors } from './discord/conductors'
import type { LiveStatus } from './discord/liveStatus'
import type { Notices } from './discord/notices'
import type { DiscordRelay } from './discord/relay'
import type { SlashCommands } from './discord/slash'
import type { SessionThreads } from './discord/threads'
import type { SessionTracker } from './sessionTracker'
import type { SessionsWithStore } from './storedSessions'
import type { WorkspaceManager } from './workspaces'

export interface TabExit {
  tabId: string
  exitCode: number
  signal?: number
  asleep: boolean
  crashed: boolean
  left?: LeftTab
}

interface TabEvents {
  exit: TabExit
  teardown: TabExit
  slept: string
  woken: string
}

type Listener<K extends keyof TabEvents> = (e: TabEvents[K]) => void

export class TabLifecycle {
  private readonly listeners: { [K in keyof TabEvents]: Listener<K>[] } = {
    exit: [],
    teardown: [],
    slept: [],
    woken: []
  }

  on<K extends keyof TabEvents>(event: K, listener: Listener<K>): void {
    this.listeners[event].push(listener)
  }

  emit<K extends keyof TabEvents>(event: K, e: TabEvents[K]): void {
    for (const listener of this.listeners[event]) listener(e)
  }
}

type MadeLater<T> = () => T | null

export interface TabSubsystems {
  slash: Pick<SlashCommands, 'closed'>
  attention: Pick<AttentionTracker, 'clear'>
  claude: Pick<ClaudeBackend, 'onPtyExit'>
  tracker: Pick<SessionTracker, 'setAlive'>
  storedOwnerOf: (tabId: string) => Pick<SessionsWithStore, 'stop'> | undefined
  toast: (message: string) => void
  notices: MadeLater<Pick<Notices, 'closed' | 'forget'>>
  live: MadeLater<Pick<LiveStatus, 'closed' | 'forget'>>
  relay: MadeLater<Pick<DiscordRelay, 'forget'>>
  threads: MadeLater<Pick<SessionThreads, 'forget'>>
  buttons: MadeLater<Pick<AskButtons, 'forget'>>
  workspaces: MadeLater<Pick<WorkspaceManager, 'launchEnded' | 'onTrackerUpdate'>>
  cron: MadeLater<Pick<CronRunner, 'onPtyExit'>>
  conductors: MadeLater<Pick<Conductors, 'onPtyExit'>>
}

export function subscribeTabSubsystems(lifecycle: TabLifecycle, s: TabSubsystems): void {
  lifecycle.on('exit', ({ tabId }) => s.slash.closed(tabId))
  lifecycle.on('exit', ({ tabId, asleep }) => {
    const notices = s.notices()
    if (!asleep) notices?.closed(tabId)
    notices?.forget(tabId)
  })
  lifecycle.on('exit', ({ tabId, asleep }) => {
    const live = s.live()
    if (!asleep) live?.closed(tabId)
    live?.forget(tabId)
  })
  lifecycle.on('exit', ({ tabId }) => s.relay()?.forget(tabId))
  lifecycle.on('exit', ({ tabId }) => s.threads()?.forget(tabId))
  lifecycle.on('exit', ({ tabId }) => s.buttons()?.forget(tabId))

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
  lifecycle.on('teardown', ({ tabId, left }) => s.cron()?.onPtyExit(tabId, left))
  lifecycle.on('teardown', ({ tabId, asleep }) => s.conductors()?.onPtyExit(tabId, asleep))

  lifecycle.on('slept', () => s.workspaces()?.onTrackerUpdate())
  lifecycle.on('woken', () => s.workspaces()?.onTrackerUpdate())
}
