import type { PluginStart } from '@core/pluginStart'
import { registerChannels } from './channels'
import { registerPageChannels } from './pageChannels'
import { pickDocsOfEachTurn } from './sessionHooks'
import { registerWorkbenchCommands } from './workbenchVerbs'

export interface WorkbenchStartDeps {
  commands: Parameters<typeof registerWorkbenchCommands>[1]
  readerDocs: Parameters<typeof pickDocsOfEachTurn>[1]
  pageChannels: Parameters<typeof registerPageChannels>[1]
  channels: Parameters<typeof registerChannels>[1]
}

export const start: PluginStart<WorkbenchStartDeps> = ({ commands, moments, ipc }, d) => {
  registerWorkbenchCommands(commands, d.commands)
  pickDocsOfEachTurn(moments, d.readerDocs)
  registerPageChannels(ipc, d.pageChannels)
  registerChannels(ipc, d.channels)
}
