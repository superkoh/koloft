import type { PluginStart } from '@core/pluginStart'
import { registerChannels } from './channels'
import { followEachState, followEachTurn, forgetAsksOfEndedTabs } from './sessionHooks'
import { registerSessionCommands } from './sessionVerbs'
import type { SessionTabs } from './sessionTabs'

export interface SessionsStartDeps {
  eachTurn: Parameters<typeof followEachTurn>[1]
  commands: Parameters<typeof registerSessionCommands>[1]
  endedTabs: Parameters<typeof forgetAsksOfEndedTabs>[1]
  eachState: Parameters<typeof followEachState>[1]
  channels: Parameters<typeof registerChannels>[1]
  tabs: SessionTabs
}

export type SessionsStarted = ReturnType<typeof followEachTurn> & SessionTabs

export const start: PluginStart<SessionsStartDeps, SessionsStarted> = (
  { commands, moments, ipc },
  d
) => {
  const turnsTaken = followEachTurn(moments, d.eachTurn)
  registerSessionCommands(commands, d.commands)
  forgetAsksOfEndedTabs(moments, d.endedTabs)
  followEachState(moments, d.eachState)
  registerChannels(ipc, d.channels)
  return { ...turnsTaken, ...d.tabs }
}
