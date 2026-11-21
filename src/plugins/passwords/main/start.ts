import type { PluginStart } from '@core/pluginStart'
import { registerChannels } from './channels'
import { registerPageCommand } from './pageVerb'
import { registerSecretCommand } from './secretVerb'
import { forgetSecretAsksOfEndedTabs } from './sessionHooks'

export interface PasswordsStartDeps {
  secretCommand: Parameters<typeof registerSecretCommand>[1]
  pageCommand: Parameters<typeof registerPageCommand>[1]
  endedTabs: Parameters<typeof forgetSecretAsksOfEndedTabs>[1]
  channels: Parameters<typeof registerChannels>[1]
}

export const start: PluginStart<PasswordsStartDeps> = ({ commands, moments, ipc }, d) => {
  registerSecretCommand(commands, d.secretCommand)
  registerPageCommand(commands, d.pageCommand)
  forgetSecretAsksOfEndedTabs(moments, d.endedTabs)
  registerChannels(ipc, d.channels)
}
