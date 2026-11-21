import type { PluginStart } from '@core/pluginStart'
import { registerChannels } from './channels'
import type { MorningLines, OwnerAsleep } from './ownerAsleep'
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
  morning: Pick<OwnerAsleep, 'addToMorningReport'>
}

export interface ButlerStarted {
  addToMorningReport(lines: MorningLines): void
}

export const start: PluginStart<ButlerStartDeps, ButlerStarted> = ({ moments, ipc }, d) => {
  tellEachHelperItsRole(moments, d.helperRole)
  butlerFollowsEachTurn(moments, d.eachTurn)
  butlerLetsGoOfEndedTabs(moments, d.endedTabs)
  registerChannels(ipc, d.channels)
  return { addToMorningReport: (lines) => d.morning.addToMorningReport(lines) }
}
