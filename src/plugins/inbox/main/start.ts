import type { PluginStart } from '@core/pluginStart'
import { registerChannels } from './channels'
import { registerInboxCommand } from './inboxVerb'
import { cardEachTurnAndQuestion } from './sessionHooks'

export interface InboxStartDeps {
  eachTurn: Parameters<typeof cardEachTurnAndQuestion>[1]
  command: Parameters<typeof registerInboxCommand>[1]
  channels: Parameters<typeof registerChannels>[1]
}

export const start: PluginStart<InboxStartDeps> = ({ commands, moments, ipc }, d) => {
  cardEachTurnAndQuestion(moments, d.eachTurn)
  registerInboxCommand(commands, d.command)
  registerChannels(ipc, d.channels)
}
