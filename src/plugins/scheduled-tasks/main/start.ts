import type { PluginStart } from '@core/pluginStart'
import { pushRunStarted, registerChannels } from './channels'
import { registerCronCommand } from './cronVerb'
import { followEachRun } from './sessionHooks'

export interface ScheduledTasksStartDeps {
  command: Parameters<typeof registerCronCommand>[1]
  runner: Parameters<typeof followEachRun>[1]
  channels: Parameters<typeof registerChannels>[1]
}

export interface ScheduledRuns {
  runStartedIn(tabId: string): boolean
}

export const start: PluginStart<ScheduledTasksStartDeps, ScheduledRuns> = (
  { commands, moments, ipc },
  d
) => {
  registerCronCommand(commands, d.command)
  followEachRun(moments, d.runner, pushRunStarted(ipc))
  registerChannels(ipc, d.channels)
  return { runStartedIn: (tabId) => !!d.runner()?.runStartedIn(tabId) }
}
