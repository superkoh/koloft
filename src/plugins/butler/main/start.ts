import type { PluginStart } from '@core/pluginStart'
import { registerChannels } from './channels'
import type { OwnerAsleep } from './ownerAsleep'
import {
  butlerFollowsEachTurn,
  butlerLetsGoOfEndedTabs,
  tellEachHelperItsRole
} from './sessionHooks'

export type ButlerStarted = Pick<OwnerAsleep, 'addToMorningReport'>

export interface ButlerStartDeps {
  helperRole: Parameters<typeof tellEachHelperItsRole>[1]
  eachTurn: Parameters<typeof butlerFollowsEachTurn>[1]
  endedTabs: Parameters<typeof butlerLetsGoOfEndedTabs>[1]
  channels: Parameters<typeof registerChannels>[1]
  morning: ButlerStarted
}

export const start: PluginStart<ButlerStartDeps, ButlerStarted> = ({ moments, ipc }, d) => {
  tellEachHelperItsRole(moments, d.helperRole)
  butlerFollowsEachTurn(moments, d.eachTurn)
  butlerLetsGoOfEndedTabs(moments, d.endedTabs)
  registerChannels(ipc, d.channels)
  return d.morning
}
