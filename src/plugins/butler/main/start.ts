import type { PluginStart } from '@core/pluginStart'
import { registerChannels } from './channels'
import {
  butlerFollowsEachTurn,
  butlerLetsGoOfEndedTabs,
  tellEachHelperItsRole
} from './sessionHooks'

export interface ButlerStartDeps {
  helperRole: Parameters<typeof tellEachHelperItsRole>[1]
  eachTurn: Parameters<typeof butlerFollowsEachTurn>[1]
  endedTabs: Parameters<typeof butlerLetsGoOfEndedTabs>[1]
  channels: Parameters<typeof registerChannels>[1]
}

export const start: PluginStart<ButlerStartDeps> = ({ moments, ipc }, d) => {
  tellEachHelperItsRole(moments, d.helperRole)
  butlerFollowsEachTurn(moments, d.eachTurn)
  butlerLetsGoOfEndedTabs(moments, d.endedTabs)
  registerChannels(ipc, d.channels)
}
