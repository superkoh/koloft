// ADR-0051
import type { PreloadIpc } from '@core/ipc'
import type { CoreApi } from '@shared/types'
import { bridge as scheduledTasks, type CronBridge } from './scheduled-tasks/preload/bridge'
import { bridge as butler, type ButlerBridge } from './butler/preload/bridge'

export type PluginBridges = CronBridge & ButlerBridge

export type KoloftApi = CoreApi & PluginBridges

export const pluginBridges = (ipc: PreloadIpc): PluginBridges => ({
  ...scheduledTasks(ipc),
  ...butler(ipc)
})
