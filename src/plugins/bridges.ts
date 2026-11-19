// ADR-0051
import type { PreloadIpc } from '@core/ipc'
import type { CoreApi } from '@shared/types'
import { bridge as sessions, type SessionsBridge } from './sessions/preload/bridge'
import { bridge as workbench, type WorkbenchBridge } from './workbench/preload/bridge'
import { bridge as butler, type ButlerBridge } from './butler/preload/bridge'
import { bridge as inbox, type InboxBridge } from './inbox/preload/bridge'
import { bridge as scheduledTasks, type CronBridge } from './scheduled-tasks/preload/bridge'
import { bridge as github, type GithubBridge } from './github/preload/bridge'
import { bridge as discord, type DiscordBridge } from './discord/preload/bridge'
import { bridge as passwords, type SecretBridge } from './passwords/preload/bridge'

export type PluginBridges = SessionsBridge &
  WorkbenchBridge &
  ButlerBridge &
  InboxBridge &
  CronBridge &
  GithubBridge &
  DiscordBridge &
  SecretBridge

export type KoloftApi = CoreApi & PluginBridges

export const pluginBridges = (ipc: PreloadIpc): PluginBridges => ({
  ...sessions(ipc),
  ...workbench(ipc),
  ...butler(ipc),
  ...inbox(ipc),
  ...scheduledTasks(ipc),
  ...github(ipc),
  ...discord(ipc),
  ...passwords(ipc)
})
