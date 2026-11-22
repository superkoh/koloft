import { answered, refused, type AgentReply } from '@core/command'
import type { MadeLater, SessionStarted } from '@core/moment'
import type { BuildLater, PluginStart } from '@core/pluginStart'
import { quoteOf } from '@plugins/butler/api'
import type { PlacedRow } from '@plugins/sessions/api'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import { DISCORD_OFF } from '../shared/types'
import { DiscordBinding, type DiscordBindingDeps } from './binding'
import { ButlerTyping, type ButlerTypingDeps } from './butlerTyping'
import { AskButtons, type ButtonDeps } from './buttons'
import { accentOf } from './cards'
import { pushStatus, registerChannels, type ChannelDeps } from './channels'
import { copyEachOpenedFile } from './copyOnOpen'
import { registerDiscordCommand } from './discordVerb'
import { releaseLock, takeLock } from './instanceLock'
import {
  INSTRUCTIONS_ID_PREFIX,
  InstructionCards,
  type InstructionCardDeps
} from './instructionCards'
import { Interactions, SLASH_COMMANDS, type InteractionDeps } from './interactions'
import { DiscordLink, discordApiUrl, privately, type DiscordLinkDeps } from './link'
import { OldThreads, type OldThreadDeps } from './oldThreads'
import { machineOfShotPage, onShotPageGone, shootHtml, shootPage, shotSession } from './pageShot'
import { phoneCopier, type PhoneCopierDeps } from './phoneCopier'
import { DiscordRelay, type Destination, type RelayDeps } from './relay'
import { roomLink, Rooms, whereOf, type RoomDeps, type RoomSubject } from './rooms'
import { SECRET_ID_PREFIX, SecretCards, type SecretCardDeps } from './secretCards'
import {
  closeRoomsOfEndedTabs,
  discordFollowsEachTurn,
  giveEachStartedSessionARoom,
  withoutTheRelayTag
} from './sessionHooks'
import { setupStatusText } from './setupSteps'
import { toChannel } from './slash'
import {
  discordOn,
  DISCORD_TURNED_OFF,
  switchedOnOnceItHasABot,
  withDiscordAsBefore,
  withDiscordOn
} from './switchOn'
import { roomNote, tabChannels, type TabChannels } from './tabChannels'
import { inviteLink } from '../shared/channels'
import { reloadDiscordPage, saveTokenFromPage, type GuestPage } from './tokenFromPage'

type Switches = Record<string, boolean>
type SessionRow = PlacedRow['row']
type ButlerRecipient = Omit<Destination, 'channelId' | 'typeCommand' | 'seen' | 'ownerSpoke'>
type SlashTyping = (
  target: { name: string; tabId: string; overseer: boolean },
  command: string,
  to: ReturnType<typeof toChannel>
) => Promise<void>

const CARDS_IN_FLIGHT_LAND_WITHIN_MS = 10_000
const SET_UP_DISCORD_WORDS = 'Set up Discord for me.'
const SET_UP_DISCORD_HOW =
  '(Koloft: run koloft discord setup and follow those steps, then close yourself with koloft session close.)'
const NO_CHANNEL_BOUND = 'No Discord channel is bound.'
const LAST_WORDS_QUOTED = 600

export interface DiscordStartDeps {
  butlerSide(tabId: string): boolean
  copyToPhone: Omit<PhoneCopierDeps, 'relay' | 'channels' | 'butlerSide'>
  rooms: Omit<Parameters<typeof giveEachStartedSessionARoom>[1], 'roomFor'>
  eachTurn: Omit<
    Parameters<typeof discordFollowsEachTurn>[1],
    'relay' | 'typing' | 'rooms' | 'buttons' | 'askChannelOf'
  >
  stillStarting: string
  token: { read(): Promise<string | null>; write(token: string): Promise<boolean> }
  pluginsOn(): Switches
  setPluginsOn(pluginsOn: Switches): void
  syncAnswerable(): void
  rowsChanged(): void
  tabIds(): string[]
  askAHelper: (prompt: string, ownerWords: string) => ReturnType<ChannelDeps['setUpWithButler']>
  pages(tabId: string): GuestPage[]
  relayAttached(tabId: string): boolean
  butlerName(): string
  butlerRecipient(): ButlerRecipient
  typeWhenIdle: SlashTyping
  alive(tabId: string): boolean
  liveTabOfKeys(keys: string[]): string | undefined
  rowOfKey(key: string | undefined): SessionRow | undefined
  resume(row: SessionRow): Promise<string>
  findRow(ref: string): Promise<{ ok: true; value: PlacedRow } | { ok: false; error: string }>
  backendOf(tabId: string): RoomSubject['backend'] | undefined
  titleOf(tabId: string): string | undefined
  turns(key: string, n: number): Promise<{ reply: string }[]>
  status(tabId: string): string | undefined
  asksTheOwner(tabId: string): boolean
}

type LinkBuildDeps = Omit<
  DiscordLinkDeps,
  | 'apiUrl'
  | 'readToken'
  | 'takeLock'
  | 'releaseLock'
  | 'push'
  | 'onMessage'
  | 'onInteraction'
  | 'onReady'
> & { lockFile: string; pidAlive(pid: number): boolean; openButler(): void }

export const start: PluginStart<
  DiscordStartDeps,
  {
    channels: TabChannels
    buildDiscordBinding: BuildLater<DiscordBindingDeps, DiscordBinding>
    buildDiscordLink: BuildLater<LinkBuildDeps, DiscordLink>
    buildRooms: BuildLater<Omit<RoomDeps, 'on'>, Rooms>
    buildOldThreads: BuildLater<OldThreadDeps, OldThreads>
    buildButlerTyping: BuildLater<ButlerTypingDeps, ButlerTyping>
    buildAskButtons: BuildLater<ButtonDeps, AskButtons>
    buildSecretCards: BuildLater<Omit<SecretCardDeps, 'cardWanted'>, SecretCards>
    buildInstructionCards: BuildLater<Omit<InstructionCardDeps, 'cardWanted'>, InstructionCards>
    buildInteractions: BuildLater<
      Omit<InteractionDeps, 'run' | 'press'> & {
        cards: SecretCards
        instructionCardsNow: InstructionCards
        buttons: AskButtons
      },
      Interactions
    >
    buildDiscordRelay: BuildLater<
      Omit<RelayDeps, 'destinationOf' | 'channels' | 'lobbyLink'>,
      DiscordRelay
    >
    discordOn: typeof discordOn
    startDiscord(): Promise<void>
    followDiscordSwitch(): void
    discordConnected(): boolean
    commandIntoButler(text: string): string
    roomNoteOfKey(key: string): string | undefined
    withoutTheRelayTag: typeof withoutTheRelayTag
    shotSession: typeof shotSession
    machineOfShotPage: typeof machineOfShotPage
    onShotPageGone: typeof onShotPageGone
    shootHtml: typeof shootHtml
  }
> = ({ commands, moments, ipc }, d) => {
  let binding: DiscordBinding | null = null
  let discordLink: DiscordLink | null = null
  let relay: DiscordRelay | null = null
  let typing: ButlerTyping | null = null
  let rooms: Rooms | null = null
  let oldThreads: OldThreads | null = null
  let buttons: AskButtons | null = null
  let secretCards: SecretCards | null = null
  let instructionCards: InstructionCards | null = null
  let interactions: Interactions | null = null
  let discordRunning = false
  let discordEnding: Promise<unknown> = Promise.resolve()
  let discordConnected = false
  const pushDiscordStatus = pushStatus(ipc)
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

  function registerSlashCommands(): void {
    const guildId = binding?.channel()?.guildId
    if (guildId) void discordLink?.registerCommands([guildId], SLASH_COMMANDS)
  }

  async function startDiscord(): Promise<void> {
    const hasABot = async (): Promise<boolean> => !!(await d.token.read())
    if (await switchedOnOnceItHasABot(d.pluginsOn(), hasABot))
      d.setPluginsOn(withDiscordOn(d.pluginsOn()))
    followDiscordSwitch()
  }

  function followDiscordSwitch(): void {
    const link = discordLink
    if (!link || discordOn() === discordRunning) return
    discordRunning = !discordRunning
    d.rowsChanged()
    d.syncAnswerable()
    if (discordRunning) {
      void discordEnding.then(() => {
        if (discordRunning) void link.connect()
      })
      return
    }
    for (const id of d.tabIds()) {
      relay?.forget(id)
      typing?.forget(id)
    }
    discordEnding = Promise.all([
      buttons?.endAll(DISCORD_TURNED_OFF),
      secretCards?.endAll(DISCORD_TURNED_OFF),
      instructionCards?.endAll(DISCORD_TURNED_OFF)
    ])
      .then(() => link.quiet(CARDS_IN_FLIGHT_LAND_WITHIN_MS))
      .finally(() => {
        if (!discordRunning) link.stop()
      })
  }

  async function saveDiscordToken(token: string): Promise<boolean> {
    const saved = await d.token.write(token)
    if (saved && discordRunning) void discordLink?.connect()
    return saved
  }

  async function setUpDiscordWithButler(
    ownerWords?: string
  ): ReturnType<ChannelDeps['setUpWithButler']> {
    const before = d.pluginsOn()
    const turnsItOn = !discordOn()
    if (turnsItOn) d.setPluginsOn(withDiscordOn(before))
    const words = ownerWords ?? SET_UP_DISCORD_WORDS
    const started = await d.askAHelper(`The owner asked: ${words} ${SET_UP_DISCORD_HOW}`, words)
    if (!started.ok && turnsItOn) d.setPluginsOn(withDiscordAsBefore(d.pluginsOn(), before))
    return started
  }

  async function bindWithNewChannel(): ReturnType<ChannelDeps['bindNewChannel']> {
    const link = discordLink
    const bound = binding
    if (!bound || !link) return { ok: false, error: d.stillStarting }
    const saved = await bound.bindNewChannel((category) =>
      link.newChannel(bound.channel(), category)
    )
    if (saved.ok) registerSlashCommands()
    return saved
  }

  function liveTabOfRoom(threadId: string, keys: string[]): string | undefined {
    const tab = rooms?.tabOfThread(threadId)
    if (tab && d.alive(tab)) return tab
    return d.liveTabOfKeys(keys)
  }

  function roomDestination(threadId: string): Destination | undefined {
    const room = rooms?.ofThread(threadId)
    if (!room) return undefined
    const liveTab = (): string | undefined => liveTabOfRoom(threadId, room.keys)
    return {
      key: threadId,
      channelId: threadId,
      name: room.name,
      liveTab,
      open: async () => {
        const live = liveTab()
        if (live) return live
        const row = d.rowOfKey(room.keys.at(-1))
        if (!row)
          throw new Error(`${room.name} is no longer in Koloft's sidebar, so it cannot be resumed.`)
        return d.resume(row)
      },
      typeCommand: async (tabId, command) => {
        await d.typeWhenIdle(
          { name: room.name, tabId, overseer: false },
          command,
          toChannel(threadId, () => relay)
        )
      },
      seen: (id) => rooms?.seen(threadId, id),
      ownerSpoke: () => rooms?.ownerSpoke(threadId)
    }
  }

  function commandInto(dest: Destination | undefined, text: string): string {
    if (!relay || !dest) throw new Error(d.stillStarting)
    if (!dest.channelId) throw new Error(NO_CHANNEL_BOUND)
    relay.command(dest, text, dest.channelId)
    return `Koloft will type ${text} into ${dest.name} once its turn ends, and post what it prints in Discord.`
  }

  async function openRoomFor(p: PlacedRow): Promise<string> {
    const r = rooms
    if (!r) throw new Error(d.stillStarting)
    const tabId = p.live?.tabId ?? (await d.resume(p.row))
    const subject: RoomSubject = {
      tabId,
      key: p.row.id,
      name: p.title,
      backend: p.row.backendId,
      workspace: p.workspace
    }
    return r.open(subject, (threadId) => showWhereItIs(threadId, subject))
  }

  function stateWords(tabId: string | undefined): string {
    if (!tabId || d.status(tabId) === undefined) return 'It is starting up.'
    if (d.asksTheOwner(tabId)) return 'It is waiting for you: its question is below.'
    return d.status(tabId) === 'working' ? 'It is working.' : 'It finished its turn.'
  }

  async function showWhereItIs(threadId: string, s: RoomSubject): Promise<void> {
    const [turn] = s.key ? await d.turns(s.key, 1).catch(() => []) : []
    const said = turn?.reply.trim()
      ? `It last said: “${quoteOf(turn.reply, LAST_WORDS_QUOTED)}”`
      : ''
    const body = [`-# ${whereOf(s)}`, stateWords(s.tabId), said].filter(Boolean).join('\n\n')
    await discordLink
      ?.card(threadId, { accent: accentOf(s.name), header: `📍 **${s.name}**: where it is`, body })
      .catch(() => undefined)
    if (s.tabId) relay?.roomOpened(s.tabId)
  }

  async function openRoomByRef(ref: string): Promise<AgentReply> {
    const found = await d.findRow(ref)
    if (!found.ok) return refused(`koloft discord thread open: ${found.error}`)
    if (found.value.workspace === d.rooms.butlerFolder())
      return refused(
        'koloft discord thread open: a helper in your own folder gets no room; its questions already come to your channel.'
      )
    const threadId = await openRoomFor(found.value)
    return answered(
      `Opened the room of ${found.value.title}: ${roomLink(threadId)}. Give the owner that link exactly as written; Discord shows it as a link to the room.`
    )
  }

  async function roomForNew({
    by,
    tabId,
    workspace,
    name
  }: SessionStarted): Promise<string | undefined> {
    if (!rooms || !relay?.answeringDiscord(by)) return undefined
    const backend = d.backendOf(tabId)
    if (!backend) return undefined
    const subject: RoomSubject = {
      tabId,
      name: name || d.titleOf(tabId) || `${BACKEND_LABEL[backend]} session`,
      backend,
      workspace
    }
    const threadId = await rooms
      .open(subject, (id) => showWhereItIs(id, subject))
      .catch(() => undefined)
    return threadId && roomLink(threadId)
  }

  function butlerDestination(): Destination {
    return {
      ...d.butlerRecipient(),
      channelId: binding?.channel()?.channelId ?? '',
      typeCommand: async (tabId, command) => {
        const channelId = binding?.channel()?.channelId
        if (!channelId) throw new Error(NO_CHANNEL_BOUND)
        await d.typeWhenIdle(
          { name: d.butlerName(), tabId, overseer: true },
          command,
          toChannel(channelId, () => relay)
        )
      },
      seen: (id) => binding?.setLastMessage(id)
    }
  }

  function commandIntoButler(text: string): string {
    return commandInto(butlerDestination(), text)
  }

  copyEachOpenedFile(moments, (o) => copyToPhone(o.tabId, o.target, o.view))
  giveEachStartedSessionARoom(moments, { ...d.rooms, roomFor: roomForNew })
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
  registerDiscordCommand(commands, {
    channelOf: (tabId) => binding?.channelOfTab(tabId),
    quiet: (tabId) => !!relay && !relay.reaches(tabId),
    send: async (channelId, files, text) => {
      if (!relay) throw new Error(d.stillStarting)
      await relay.send(channelId, files, text)
    },
    shoot: shootPage,
    status: () => setupStatusText(discordLink?.status() ?? DISCORD_OFF, binding?.settings() ?? {}),
    tokenFromPage: (tabId) =>
      saveTokenFromPage(d.pages(tabId), d.relayAttached(tabId), saveDiscordToken),
    reload: (tabId) => reloadDiscordPage(d.pages(tabId), d.relayAttached(tabId)),
    invite: () => {
      const appId = discordLink?.status().applicationId
      return appId ? inviteLink(appId) : null
    },
    bindNewChannel: bindWithNewChannel,
    openRoom: openRoomByRef
  })
  registerChannels(ipc, {
    bind: (channel) => {
      const saved = binding?.bind(channel) ?? { ok: false, error: d.stillStarting }
      if (saved.ok) registerSlashCommands()
      return saved
    },
    bindNewChannel: bindWithNewChannel,
    unbind: () => {
      binding?.unbind()
      d.syncAnswerable()
    },
    status: () => discordLink?.status() ?? DISCORD_OFF,
    pair: (isMe) => {
      const owner = discordLink?.pair(isMe)
      if (owner) binding?.setOwner(owner)
    },
    channels: () => discordLink?.channels() ?? Promise.resolve([]),
    setUpWithButler: setUpDiscordWithButler
  })
  return {
    channels,
    buildDiscordBinding: (deps) => (binding = new DiscordBinding(deps)),
    buildDiscordLink: ({ lockFile, pidAlive, openButler, ...deps }) => {
      const link = new DiscordLink({
        ...deps,
        apiUrl: discordApiUrl(),
        readToken: d.token.read,
        takeLock: () => takeLock(lockFile, pidAlive),
        releaseLock: () => releaseLock(lockFile),
        push: (status) => {
          pushDiscordStatus(status)
          discordConnected = status.phase === 'connected'
          d.syncAnswerable()
        },
        onMessage: (m) => {
          if (!discordRunning) return
          if (binding?.isButlerChannel(m.channelId) || rooms?.ofThread(m.channelId))
            relay?.onMessage(m)
          else void oldThreads?.onMessage(m)
        },
        onInteraction: (i) => {
          if (!discordRunning) {
            void link.respond(i, privately(DISCORD_TURNED_OFF)).catch(() => undefined)
            return
          }
          void (binding?.isButlerChannel(i.channelId) || rooms?.ofThread(i.channelId)
            ? interactions?.handle(i)
            : oldThreads?.onInteraction(i))
        },
        onReady: () => {
          if (binding?.channel()) openButler()
          void relay?.catchUp()
          void oldThreads?.archiveOnce()
          registerSlashCommands()
        }
      })
      discordLink = link
      return link
    },
    buildRooms: (deps) => (rooms = new Rooms({ ...deps, on: discordOn })),
    buildOldThreads: (deps) => (oldThreads = new OldThreads(deps)),
    buildButlerTyping: (deps) => (typing = new ButlerTyping(deps)),
    buildAskButtons: (deps) => (buttons = new AskButtons(deps)),
    buildSecretCards: (deps) =>
      (secretCards = new SecretCards({
        ...deps,
        cardWanted: (tabId) => discordOn() && !!relay?.reaches(tabId)
      })),
    buildInstructionCards: (deps) =>
      (instructionCards = new InstructionCards({
        ...deps,
        cardWanted: (tabId) => discordConnected && discordOn() && !!relay?.reaches(tabId)
      })),
    buildInteractions: ({ cards, instructionCardsNow, buttons: buttonsNow, ...deps }) =>
      (interactions = new Interactions({
        ...deps,
        run: async (text, channelId) =>
          commandInto(
            binding?.isButlerChannel(channelId) ? butlerDestination() : roomDestination(channelId),
            text
          ),
        press: (i) =>
          i.customId?.startsWith(SECRET_ID_PREFIX)
            ? cards.press(i)
            : i.customId?.startsWith(INSTRUCTIONS_ID_PREFIX)
              ? instructionCardsNow.press(i)
              : buttonsNow.press(i)
      })),
    buildDiscordRelay: (deps) =>
      (relay = new DiscordRelay({
        ...deps,
        destinationOf: (channelId) =>
          binding?.isButlerChannel(channelId) ? butlerDestination() : roomDestination(channelId),
        channels: () => {
          const channel = binding?.channel()
          if (!channel) return []
          return [
            {
              channelId: channel.channelId,
              lastMessageId: binding?.lastMessageId(),
              seen: (id: string) => binding?.setLastMessage(id)
            },
            ...(binding?.rooms() ?? []).flatMap((r) => {
              const dest = roomDestination(r.threadId)
              return dest && r.keys.some((k) => d.rowOfKey(k))
                ? [
                    {
                      channelId: r.threadId,
                      lastMessageId: r.lastMessageId,
                      seen: (id: string) => rooms?.seen(r.threadId, id),
                      handsOverTo: dest
                    }
                  ]
                : []
            })
          ]
        },
        lobbyLink: () => {
          const lobby = binding?.channel()
          return lobby && roomLink(lobby.channelId)
        }
      })),
    discordOn,
    startDiscord,
    followDiscordSwitch,
    discordConnected: () => discordConnected,
    commandIntoButler,
    roomNoteOfKey: (key) => {
      const room = discordOn() ? rooms?.ofKey(key) : undefined
      return room && roomNote(room)
    },
    withoutTheRelayTag,
    shotSession,
    machineOfShotPage,
    onShotPageGone,
    shootHtml
  }
}
