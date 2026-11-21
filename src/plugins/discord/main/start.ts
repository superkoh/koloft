import type { PluginStart } from '@core/pluginStart'
import { registerChannels } from './channels'
import { copyEachOpenedFile } from './copyOnOpen'
import { registerDiscordCommand } from './discordVerb'
import {
  closeRoomsOfEndedTabs,
  discordFollowsEachTurn,
  discordTakesTheTurnsItCarries,
  giveEachStartedSessionARoom
} from './sessionHooks'

export interface DiscordStartDeps {
  copyToPhone: Parameters<typeof copyEachOpenedFile>[1]
  rooms: Parameters<typeof giveEachStartedSessionARoom>[1]
  eachTurn: Parameters<typeof discordFollowsEachTurn>[1]
  carriedTurns: Parameters<typeof discordTakesTheTurnsItCarries>[0]
  endedTabs: Parameters<typeof closeRoomsOfEndedTabs>[1]
  command: Parameters<typeof registerDiscordCommand>[1]
  channels: Parameters<typeof registerChannels>[1]
}

export const start: PluginStart<DiscordStartDeps> = ({ commands, moments, ipc }, d) => {
  copyEachOpenedFile(moments, d.copyToPhone)
  giveEachStartedSessionARoom(moments, d.rooms)
  discordFollowsEachTurn(moments, d.eachTurn)
  discordTakesTheTurnsItCarries(d.carriedTurns)
  closeRoomsOfEndedTabs(moments, d.endedTabs)
  registerDiscordCommand(commands, d.command)
  registerChannels(ipc, d.channels)
}
