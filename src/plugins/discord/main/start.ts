import type { MadeLater } from '@core/moment'
import type { BuildLater, PluginStart } from '@core/pluginStart'
import { DiscordBinding, type DiscordBindingDeps } from './binding'
import { ButlerTyping, type ButlerTypingDeps } from './butlerTyping'
import { AskButtons, type ButtonDeps } from './buttons'
import { registerChannels } from './channels'
import { copyEachOpenedFile } from './copyOnOpen'
import { registerDiscordCommand } from './discordVerb'
import { InstructionCards, type InstructionCardDeps } from './instructionCards'
import { Interactions, type InteractionDeps } from './interactions'
import { DiscordLink, type DiscordLinkDeps } from './link'
import { OldThreads, type OldThreadDeps } from './oldThreads'
import { phoneCopier } from './phoneCopier'
import { DiscordRelay, type RelayDeps } from './relay'
import { Rooms, type RoomDeps } from './rooms'
import { SecretCards, type SecretCardDeps } from './secretCards'
import {
  closeRoomsOfEndedTabs,
  discordFollowsEachTurn,
  giveEachStartedSessionARoom
} from './sessionHooks'
import { discordOn } from './switchOn'
import { tabChannels } from './tabChannels'

type PhoneCopierDeps = Parameters<typeof phoneCopier>[0]

export interface DiscordStartDeps {
  butlerSide(tabId: string): boolean
  copyToPhone: Omit<PhoneCopierDeps, 'relay' | 'channels' | 'butlerSide'>
  rooms: Parameters<typeof giveEachStartedSessionARoom>[1]
  eachTurn: Omit<
    Parameters<typeof discordFollowsEachTurn>[1],
    'relay' | 'typing' | 'rooms' | 'buttons' | 'askChannelOf'
  >
  command: Parameters<typeof registerDiscordCommand>[1]
  channels: Parameters<typeof registerChannels>[1]
}

export const start: PluginStart<
  DiscordStartDeps,
  {
    channels: ReturnType<typeof tabChannels>
    buildBinding: BuildLater<DiscordBindingDeps, DiscordBinding>
    buildLink: BuildLater<DiscordLinkDeps, DiscordLink>
    buildRooms: BuildLater<RoomDeps, Rooms>
    buildOldThreads: BuildLater<OldThreadDeps, OldThreads>
    buildTyping: BuildLater<ButlerTypingDeps, ButlerTyping>
    buildButtons: BuildLater<ButtonDeps, AskButtons>
    buildSecretCards: BuildLater<SecretCardDeps, SecretCards>
    buildInstructionCards: BuildLater<InstructionCardDeps, InstructionCards>
    buildInteractions: BuildLater<InteractionDeps, Interactions>
    buildRelay: BuildLater<RelayDeps, DiscordRelay>
  }
> = ({ commands, moments, ipc }, d) => {
  let binding: DiscordBinding | null = null
  let relay: DiscordRelay | null = null
  let typing: ButlerTyping | null = null
  let rooms: Rooms | null = null
  let buttons: AskButtons | null = null
  const relayBuilt: MadeLater<DiscordRelay> = () => relay
  const typingBuilt: MadeLater<ButlerTyping> = () => typing
  const roomsBuilt: MadeLater<Rooms> = () => rooms
  const buttonsBuilt: MadeLater<AskButtons> = () => buttons
  const channels = tabChannels({
    butlerSide: d.butlerSide,
    lobby: () => binding?.channel()?.channelId,
    boundChannelOf: (tabId) => binding?.channelOfTab(tabId),
    roomCarrying: (tabId) => (discordOn() ? rooms?.carried(tabId) : undefined),
    reaches: (tabId) => !!relay?.reaches(tabId)
  })
  const copyToPhone = phoneCopier({
    ...d.copyToPhone,
    relay: relayBuilt,
    channels,
    butlerSide: d.butlerSide
  })
  copyEachOpenedFile(moments, (o) => copyToPhone(o.tabId, o.target, o.view))
  giveEachStartedSessionARoom(moments, d.rooms)
  discordFollowsEachTurn(moments, {
    ...d.eachTurn,
    relay: relayBuilt,
    typing: typingBuilt,
    rooms: roomsBuilt,
    buttons: buttonsBuilt,
    askChannelOf: channels.askChannelOf
  })
  closeRoomsOfEndedTabs(moments, {
    typing: typingBuilt,
    relay: relayBuilt,
    buttons: buttonsBuilt,
    rooms: roomsBuilt
  })
  registerDiscordCommand(commands, d.command)
  registerChannels(ipc, d.channels)
  return {
    channels,
    buildBinding: (deps) => (binding = new DiscordBinding(deps)),
    buildLink: (deps) => new DiscordLink(deps),
    buildRooms: (deps) => (rooms = new Rooms(deps)),
    buildOldThreads: (deps) => new OldThreads(deps),
    buildTyping: (deps) => (typing = new ButlerTyping(deps)),
    buildButtons: (deps) => (buttons = new AskButtons(deps)),
    buildSecretCards: (deps) => new SecretCards(deps),
    buildInstructionCards: (deps) => new InstructionCards(deps),
    buildInteractions: (deps) => new Interactions(deps),
    buildRelay: (deps) => (relay = new DiscordRelay(deps))
  }
}
