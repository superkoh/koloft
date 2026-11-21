import type { PluginStart } from '@core/pluginStart'
import { pushRunStarted, registerChannels } from './channels'
import { registerCronCommand } from './cronVerb'
import { followEachRun } from './sessionHooks'

export interface ScheduledTasksStartDeps {
  command: Parameters<typeof registerCronCommand>[1]
  runner: Parameters<typeof followEachRun>[1]
  channels: Parameters<typeof registerChannels>[1]
}

export const start: PluginStart<ScheduledTasksStartDeps> = ({ commands, moments, ipc }, d) => {
  registerCronCommand(commands, d.command)
  followEachRun(moments, d.runner, pushRunStarted(ipc))
  registerChannels(ipc, d.channels)
}
