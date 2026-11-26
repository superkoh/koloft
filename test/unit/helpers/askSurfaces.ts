import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import type { AttentionEvent, BackendId } from '@shared/types'
import type { AskPayload } from '@shared/sessionEvent'
import type { InboxCard, InboxSnapshot } from '@shared/inbox'
import {
  ATTENTION_CHANGED,
  Moments,
  QUESTION_ASKED,
  STATE_CHANGED,
  type StateChanged
} from '../../../src/core/moment'
import { Commands } from '../../../src/core/commands'
import type { MainIpc } from '../../../src/core/ipc'
import { PLUGINS } from '../../../src/plugins/list'
import { SessionRuntime } from '../../../src/core/agent/sessionRuntime'
import { SessionBackends, type SessionLifecycle } from '../../../src/core/agent/sessionBackends'
import { SessionAsks } from '../../../src/plugins/sessions/main/sessionAsks'
import {
  claudeDialog,
  codexDialog,
  isAskedCall,
  questionsOf
} from '../../../src/plugins/sessions/main/appHelpers'
import { followEachState, followEachTurn } from '../../../src/plugins/sessions/main/sessionHooks'
import { markAnswerable } from '../../../src/plugins/sessions/main/hooks'
import { HOOK_SCRIPT } from '../../../src/agents/claude/main/claudeHooks'
import { DiscordRelay, type Destination } from '../../../src/plugins/discord/main/relay'
import { AskButtons } from '../../../src/plugins/discord/main/buttons'
import type { Card } from '../../../src/plugins/discord/main/cards'
import type { DiscordInteraction, DiscordMessage } from '../../../src/plugins/discord/main/link'
import { discordFollowsEachTurn } from '../../../src/plugins/discord/main/sessionHooks'
import { start as startInbox } from '../../../src/plugins/inbox/main/start'
import { CHANNELS as INBOX_CHANNELS } from '../../../src/plugins/inbox/shared/ipc'
import { morningReport } from '../../../src/plugins/butler/main/ownerAsleep'
import { askWiring } from '../../../src/main/askWiring'
import type { World } from './agentTabs'

export const OWNER = 'owner-1'
export const CHANNEL = 'channel-1'
export const SESSION_TITLE = 'Fix the docs'
const ASKED_AT = 1_700_000_000_000

export interface Stored {
  readonly id: BackendId
  hasTab(tabId: string): boolean
  openApproval(tabId: string): ReturnType<SessionAsksDeps['pendingApproval']>
  openQuestion(tabId: string): ReturnType<SessionAsksDeps['pendingQuestion']>
  answer?(tabId: string, reply: string): ReturnType<SessionAsksDeps['answerInPlace']>
}

type SessionAsksDeps = ConstructorParameters<typeof SessionAsks>[0]

export class FakeTerminals extends EventEmitter {
  readonly reached: string[] = []
  readonly created: {
    id: string
    argv?: string[]
    processEnv?: NodeJS.ProcessEnv
    envSetForThisTab?: Record<string, string>
  }[] = []
  private live = new Map<string, string>()
  private ids = 0

  constructor(private readonly prefix: string) {
    super()
  }

  open(tabId: string, kind: string): void {
    this.live.set(tabId, kind)
  }

  nextId = (): string => `${this.prefix}-${++this.ids}`

  create = (args: {
    id?: string
    kind?: string
    argv?: string[]
    processEnv?: NodeJS.ProcessEnv
    envSetForThisTab?: Record<string, string>
  }): { id: string; startedAt: number } => {
    const id = args.id ?? this.nextId()
    this.live.set(id, args.kind ?? 'agent')
    this.created.push({ ...args, id })
    return { id, startedAt: 0 }
  }

  get = (tabId: string): { alive: boolean; kind: string } | undefined => {
    const kind = this.live.get(tabId)
    return kind ? { alive: true, kind } : undefined
  }

  pidOf = (): number => process.pid
  kill = (): void => {}
  wakeReady = (): void => {}
  clearResumeIntent = (): void => {}
  resize = (): void => {}

  takes: ((tabId: string) => void) | undefined

  write = (tabId: string, data: string): void => {
    this.reached.push(`written to its terminal: ${JSON.stringify(data)}`)
    this.takes?.(tabId)
  }

  type = async (tabId: string, keys: string[]): Promise<boolean> => {
    this.reached.push(`keys pressed: ${keys.map((k) => JSON.stringify(k)).join(' ')}`)
    this.takes?.(tabId)
    return true
  }
}

export interface SurfacesOptions {
  backendOf: (tabId: string) => BackendId | undefined
  sessionIdOf: (tabId: string) => string | undefined
}

export class AskSurfaces {
  readonly runtime = new SessionRuntime()
  readonly moments = new Moments(PLUGINS)
  readonly terminals: FakeTerminals
  readonly stored: Stored[] = []
  readonly asks: SessionAsks
  readonly wiring: ReturnType<typeof askWiring>
  readonly backends: SessionBackends
  readonly relay: DiscordRelay
  readonly buttons: AskButtons
  readonly cards: Card[] = []
  readonly edits: Card[] = []
  readonly said: string[] = []
  readonly handedOver: string[] = []
  readonly timeline: string[] = []
  marks: AttentionEvent[] = []
  ownerTouchedTheTerminal = false
  askChannel: string | undefined = CHANNEL
  private ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
  private ipcListeners = new Map<string, (...args: unknown[]) => void>()
  private messages = 0

  constructor(
    readonly world: World,
    private readonly o: SurfacesOptions
  ) {
    this.terminals = new FakeTerminals('pty')
    const storedOwnerOf = (tabId: string): Stored | undefined =>
      this.stored.find((s) => s.hasTab(tabId))
    const lifecycle: SessionLifecycle = {
      prompted: (tabId) => this.wiring.forgetClaudeAsk(tabId),
      bound: (tabId) => this.wiring.forgetClaudeAsk(tabId),
      exited: () => {},
      clearAttention: () => {},
      open: () => {},
      turnEnded: () => {},
      asked: (tabId, ask, id) => {
        this.timeline.push(`Claude Code's hook reported an ask (id ${id})`)
        this.wiring.claudeAsked(tabId, ask, id)
      }
    }
    this.backends = new SessionBackends(lifecycle)
    this.wiring = askWiring({
      runtime: () => this.runtime,
      storedOwnerOf,
      sessionAsks: () => this.asks,
      readers: () => ({ claudeDialog, codexDialog, questionsOf, isAskedCall }),
      questionAsked: (asked) => void this.moments.announce(QUESTION_ASKED, asked)
    })
    this.asks = new SessionAsks({
      showsPromptBeforeBind: () => false,
      boundKey: (tabId) => o.sessionIdOf(tabId),
      queueDrained: () => true,
      backendOf: o.backendOf,
      status: (tabId) => this.runtime.statusOf(tabId),
      awaitsInput: (tabId) => this.runtime.awaitsInput(tabId),
      turnOver: (tabId) => this.runtime.turnOver(tabId),
      type: (tabId, keys) => this.terminals.type(tabId, keys),
      touchedSinceAsked: () => this.ownerTouchedTheTerminal,
      ownerTouchedSince: () => this.ownerTouchedTheTerminal,
      pendingApproval: (tabId) => storedOwnerOf(tabId)?.openApproval(tabId),
      pendingQuestion: (tabId) => storedOwnerOf(tabId)?.openQuestion(tabId),
      answerable: async () => {},
      answerInPlace: async (tabId, reply) => storedOwnerOf(tabId)?.answer?.(tabId, reply) ?? false,
      showsDialogsClosing: () => false,
      regDir: world.regDir
    })
    this.runtime.on('status', (t: StateChanged) => {
      if (t.prev === 'approval') this.wiring.forgetClaudeAsk(t.tabId)
      this.timeline.push(`its state went ${t.prev ?? 'nowhere'} → ${t.next ?? 'nowhere'}`)
      void this.moments.announce(STATE_CHANGED, t)
    })
    followEachTurn(this.moments, {
      judge: { prompted: () => {}, turnEnded: () => {} },
      slash: { turnEnded: () => {}, bound: () => {} },
      replies: { turnEnded: () => false },
      asks: () => this.asks,
      askBeforeAsksAreMade: () => {},
      askAsItsAgentGaveIt: this.wiring.claudeAskOf
    })
    followEachState(this.moments, {
      asks: () => this.asks,
      slash: { turnOver: () => {} },
      attention: { stateChanged: () => {} }
    })
    this.buttons = new AskButtons({
      owner: () => OWNER,
      dialogText: async (tabId) => (await this.wiring.dialogOf(tabId))?.text,
      answer: (tabId, reply) => this.asks.answerSession(tabId, reply),
      respond: async (_i, body) => {
        const text = (body as { data?: { content?: string } }).data?.content
        if (text) this.said.push(`privately, under the button: ${text}`)
      },
      followUp: async (_i, text) => void this.said.push(`privately, after the button: ${text}`),
      edit: async (_placed, card) => void this.edits.push(card)
    })
    this.asks.listen({
      asked: () => void this.timeline.push("Koloft's list of open asks took it"),
      asksChanged: (tabId) => void this.buttons.check(tabId),
      answered: (tabId, reply) => this.buttons.answered(tabId, reply)
    })
    const destination: Destination = {
      key: 'the-session',
      name: SESSION_TITLE,
      channelId: CHANNEL,
      liveTab: () => this.liveTab,
      open: async () => this.liveTab ?? '',
      typeCommand: async () => {},
      seen: () => {}
    }
    this.relay = new DiscordRelay({
      backendOf: o.backendOf,
      status: (tabId) => this.runtime.statusOf(tabId),
      awaitsInput: (tabId) => this.runtime.awaitsInput(tabId),
      pendingApproval: (tabId) => storedOwnerOf(tabId)?.openApproval(tabId),
      pendingQuestion: (tabId) => storedOwnerOf(tabId)?.openQuestion(tabId),
      asks: this.asks,
      link: {
        post: async (_channelId: string, text: string) => {
          this.said.push(`under the message: ${text}`)
          return [`posted-${++this.messages}`]
        },
        upload: async () => [],
        react: async (_c: string, _m: string, emoji: string, on: boolean) => {
          if (on) this.said.push(`reacted ${emoji}`)
        },
        messages: async () => [],
        card: async (_channelId: string, card: Card) => {
          this.cards.push(card)
          this.timeline.push(`a Discord card was posted`)
          return [`card-${this.cards.length}`]
        }
      } as never,
      download: async () => Buffer.from(''),
      owner: () => OWNER,
      ownerAway: () => true,
      ownerWrote: () => {},
      butlerName: () => 'Alfred',
      destinationOf: (channelId) => (channelId === CHANNEL ? destination : undefined),
      channels: () => [],
      replyChannelOf: () => CHANNEL,
      askChannelOf: () => this.askChannel,
      lobbyLink: () => undefined,
      helperTitle: () => SESSION_TITLE,
      inRoom: () => true,
      withButtons: (tabId, view, card) => this.buttons.attach(tabId, view, card),
      askPlaced: (card, at) => this.buttons.placed(card, at),
      handOver: {
        hand: (_dest, handing) => {
          void handing.text().then((text) => this.handedOver.push(text))
        },
        delivering: () => false
      },
      attachmentsDir: path.join(world.home, 'discord-attachments')
    })
    discordFollowsEachTurn(this.moments, {
      relay: () => this.relay,
      typing: () => ({ refresh: () => {} }),
      rooms: () => ({ bound: async () => {} }),
      buttons: () => this.buttons,
      noTurnsYet: async () => false,
      askChannelOf: () => this.askChannel,
      pendingAskOf: this.wiring.pendingAskOf,
      askUnreadablySoon: (tabId) => this.relay.asksUnreadably(tabId)
    })
    const ipc = {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        void this.ipcHandlers.set(channel, handler),
      on: (channel: string, listener: (...args: unknown[]) => void) =>
        void this.ipcListeners.set(channel, listener),
      onEvent: () => {},
      push: () => true
    } as unknown as MainIpc
    startInbox(
      { commands: new Commands(PLUGINS), moments: this.moments, ipc },
      {
        cards: {
          now: () => ASKED_AT,
          startSession: async () => ({ ok: true }) as never,
          sendFrom: async () => undefined as never,
          quitting: () => true
        },
        koloft: {
          marks: () => this.marks,
          sessionOfTab: (tabId) =>
            o.backendOf(tabId)
              ? {
                  sessionId: o.sessionIdOf(tabId) ?? tabId,
                  title: SESSION_TITLE,
                  backend: o.backendOf(tabId)!
                }
              : undefined,
          liveTabOf: (ref) => {
            const tabId = this.liveTab
            return tabId && (o.sessionIdOf(tabId) ?? tabId) === ref
              ? { tabId, backend: o.backendOf(tabId)! }
              : undefined
          },
          claudeAskOf: this.wiring.claudeAskOf,
          pendingAskOf: this.wiring.pendingAskOf,
          answer: (tabId, reply) => this.asks.answerSession(tabId, reply),
          butlerSide: () => false,
          watching: () => null
        },
        tookTheTurn: () => false,
        toast: () => {}
      }
    )
    this.watcher = this.asks.watchAsks()
  }

  private watcher: fs.FSWatcher | null
  liveTab: string | undefined

  close(): void {
    this.watcher?.close()
  }

  markAsking(tabId: string): void {
    this.marks = [
      {
        tabId,
        kind: 'approval',
        at: ASKED_AT,
        sessionId: this.o.sessionIdOf(tabId) ?? tabId,
        title: SESSION_TITLE
      }
    ]
    void this.moments.announce(ATTENTION_CHANGED, this.marks)
  }

  inboxCards(): InboxCard[] {
    const list = this.ipcHandlers.get(INBOX_CHANNELS.list)
    return (list?.() as InboxSnapshot | undefined)?.cards ?? []
  }

  async pressButton(card: Card, n: number, userId = OWNER): Promise<void> {
    const customId = card.buttons?.[n]?.id
    const i = {
      id: 'interaction',
      applicationId: 'app',
      token: 'token',
      type: 3,
      channelId: CHANNEL,
      userId,
      command: '',
      options: {},
      customId
    } satisfies DiscordInteraction
    await this.buttons.press(i)
  }

  message(content: string): DiscordMessage {
    const m: DiscordMessage = {
      id: `owner-message-${++this.messages}`,
      channelId: CHANNEL,
      authorId: OWNER,
      bot: false,
      content,
      attachments: []
    }
    this.relay.onMessage(m)
    return m
  }

  async ownerAsleepReport(tabId: string): Promise<string | undefined> {
    const asked = await this.wiring.ownerAsleepAsked(tabId)
    if (!asked) return undefined
    return morningReport(60_000, [], [{ title: SESSION_TITLE, asked }])
  }
}

export interface HookRun {
  child: ChildProcess
  printed: Promise<string>
}

export function writeHookScript(world: World): string {
  const file = path.join(world.home, 'koloft-hook.sh')
  fs.writeFileSync(file, HOOK_SCRIPT, { mode: 0o755 })
  return file
}

export function holdAsksOf(world: World, tabId: string, on: boolean): void {
  markAnswerable(world.regDir, tabId, on)
}

export function runAskHook(
  script: string,
  world: World,
  tabId: string,
  payload: AskPayload & { session_id: string }
): HookRun {
  const child = spawn('/bin/bash', [script, world.regDir, tabId, 'ask'], {
    env: { HOME: world.home, PATH: process.env.PATH },
    stdio: ['pipe', 'pipe', 'ignore']
  })
  let out = ''
  child.stdout!.on('data', (d: Buffer) => (out += String(d)))
  const printed = new Promise<string>((resolve) => child.on('close', () => resolve(out)))
  child.stdin!.end(JSON.stringify({ hook_event_name: 'PermissionRequest', ...payload }))
  return { child, printed }
}
