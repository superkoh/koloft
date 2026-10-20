import { EventEmitter } from 'events'
import type { TerminalExit } from '@shared/types'
import type { AttentionTracker } from './attention'
import type { ClaudeBackend } from './backends/claude'
import type { CronRunner, LeftTab } from './cronRunner'
import type { AskButtons } from './discord/buttons'
import type { Butler } from './discord/butler'
import type { ButlerTyping } from './discord/butlerTyping'
import type { SecretAsks } from './discord/secretAsks'
import type { DiscordRelay } from './discord/relay'
import type { SlashCommands } from './discord/slash'
import type { SessionTracker } from './sessionTracker'
import type { SessionsWithStore } from './storedSessions'
import type { WorkspaceManager } from './workspaces'

export interface TabExit extends Pick<TerminalExit, 'exitCode' | 'signal'> {
  tabId: string
  asleep: boolean
  crashed: boolean
  left?: LeftTab
}

export class TabLifecycle extends EventEmitter<{
  exit: [TabExit]
  teardown: [TabExit]
  slept: []
  woken: []
  forgotten: [string]
}> {}

type MadeLater<T> = () => T | null

export interface TabSubsystems {
  slash: Pick<SlashCommands, 'closed'>
  attention: Pick<AttentionTracker, 'clear'>
  claude: Pick<ClaudeBackend, 'onPtyExit'>
  tracker: Pick<SessionTracker, 'setAlive'>
  storedOwnerOf: (tabId: string) => Pick<SessionsWithStore, 'stop'> | undefined
  toast: (message: string) => void
  typing: MadeLater<Pick<ButlerTyping, 'forget'>>
  relay: MadeLater<Pick<DiscordRelay, 'forget'>>
  buttons: MadeLater<Pick<AskButtons, 'forget'>>
  secrets: MadeLater<Pick<SecretAsks, 'forget'>>
  workspaces: MadeLater<Pick<WorkspaceManager, 'launchEnded' | 'onTrackerUpdate'>>
  cron: MadeLater<Pick<CronRunner, 'onPtyExit'>>
  butler: MadeLater<Pick<Butler, 'onPtyExit'>>
}

export function subscribeTabSubsystems(lifecycle: TabLifecycle, s: TabSubsystems): void {
  lifecycle.on('exit', ({ tabId }) => s.slash.closed(tabId))
  lifecycle.on('exit', ({ tabId }) => s.typing()?.forget(tabId))
  lifecycle.on('exit', ({ tabId }) => s.relay()?.forget(tabId))
  lifecycle.on('exit', ({ tabId }) => s.buttons()?.forget(tabId))
  lifecycle.on('exit', ({ tabId }) => s.secrets()?.forget(tabId))

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
  lifecycle.on('teardown', ({ tabId, asleep }) => s.butler()?.onPtyExit(tabId, asleep))

  lifecycle.on('slept', () => s.workspaces()?.onTrackerUpdate())
  lifecycle.on('woken', () => s.workspaces()?.onTrackerUpdate())
  lifecycle.on('forgotten', (tabId) => s.butler()?.onPtyExit(tabId, false))
  lifecycle.on('forgotten', () => s.workspaces()?.onTrackerUpdate())
}
