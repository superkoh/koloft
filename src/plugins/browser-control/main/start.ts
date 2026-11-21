import type { PluginStart } from '@core/pluginStart'
import { registerChannels } from './channels'
import { closeEachStoppingTabsEndpoint } from './sessionHooks'

export interface BrowserControlStartDeps {
  channels: Parameters<typeof registerChannels>[1]
}

export const start: PluginStart<BrowserControlStartDeps> = ({ moments, ipc }, d) => {
  closeEachStoppingTabsEndpoint(moments)
  registerChannels(ipc, d.channels)
}
