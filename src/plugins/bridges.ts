// ADR-0051
import type { PreloadIpc } from '@core/ipc'
import type { CoreApi } from '@shared/types'
import { bridge as inbox, type InboxBridge } from './inbox/preload/bridge'
import { bridge as scheduledTasks, type CronBridge } from './scheduled-tasks/preload/bridge'
import { bridge as github, type GithubBridge } from './github/preload/bridge'

export type PluginBridges = InboxBridge & CronBridge & GithubBridge

export type KoloftApi = CoreApi & PluginBridges

export const pluginBridges = (ipc: PreloadIpc): PluginBridges => ({
  ...inbox(ipc),
  ...scheduledTasks(ipc),
  ...github(ipc)
})
