// ADR-0051
import type { PreloadIpc } from '@core/ipc'
import type { CoreApi } from '@shared/types'
import { bridge as workbench, type WorkbenchBridge } from './workbench/preload/bridge'
import { bridge as inbox, type InboxBridge } from './inbox/preload/bridge'
import { bridge as scheduledTasks, type CronBridge } from './scheduled-tasks/preload/bridge'
import { bridge as github, type GithubBridge } from './github/preload/bridge'
import { bridge as passwords, type SecretBridge } from './passwords/preload/bridge'
import { bridge as butler, type ButlerBridge } from './butler/preload/bridge'

export type PluginBridges = WorkbenchBridge &
  InboxBridge &
  CronBridge &
  GithubBridge &
  SecretBridge &
  ButlerBridge

export type KoloftApi = CoreApi & PluginBridges

export const pluginBridges = (ipc: PreloadIpc): PluginBridges => ({
  ...workbench(ipc),
  ...inbox(ipc),
  ...scheduledTasks(ipc),
  ...github(ipc),
  ...passwords(ipc),
  ...butler(ipc)
})
