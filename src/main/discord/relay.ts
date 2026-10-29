import fs from 'fs'
import path from 'path'
import type { BackendId, SessionStatus } from '@shared/types'
import { BACKEND_LABEL, messagingOf } from '@shared/sessionBackend'
import type { Turn } from '@shared/turns'
import { newerSnowflake } from '@shared/conductors'
import { safeDownloadName } from '@shared/downloadName'
import { watchJsonDrops, writeWholeBeforeVisible } from '../jsonDrops'
import { errorText } from '../agentRequests'
import { sleep } from '../codexTransport'
import {
  BYTES_PER_FILE,
  type DiscordAttachment,
  type DiscordFile,
  type DiscordLink,
  type DiscordMessage
} from './link'
import { splitForDiscord } from './split'
import { toDiscordMarkdown } from './markdown'
import { CONDUCTOR_ACCENT, type Card } from './cards'
import type { PlacedAsk } from './buttons'
import { didNotRun, slashCommandProblem, waitingForAnswer } from '@shared/slashCommands'
import type { AskPayload } from '@shared/sessionEvent'
import { DISCORD_PREFIX } from '@shared/agentGuide'
import type { ToolCall } from '../sessionTracker'
import {
  MESSAGE_SOCKET_SHOWS_WITHIN_MS,
  crossSessionLine,
  type ModeClass
} from '../crossSessionMessage'
import { discordIdsFile, noteDiscordSaid } from '../hooks'
import {
  answerKeys,
  ANSWER_KEYS,
  askHow,
  cannotAnswer,
  claudeDialog,
  claudeKeysFor,
  codexDialog,
  codexKeyFor,
  hookAnswer,
  howToAnswer,
  isAskedCall,
  questionAnswers,
  takesAnAnswer,
  type AnswerKeys,
  type CodexApproval,
  type CodexQuestion,
  type DialogView
} from './dialog'

export const OFFLINE_REPLY = 'Koloft was offline, this message was not delivered.'
export const CODEX_NEEDS_YES_OR_NO = 'Reply yes or no.'
export const SHOWS_NO_DIALOG = 'Koloft sees no question or approval in it right now.'
// MUSE§3
export const ASKS_WHAT_KOLOFT_CANNOT_SEE =
  'It is waiting for an answer Koloft cannot read from here. The butler can still answer it by pressing its keys.'
export const inputNotProbed = (label: string): string =>
  `${label} is asking something Koloft cannot answer from here: it answers a yes-or-no approval, or questions that each pick an option from a list. The butler can still answer this one by pressing its keys.`
export const butlerAsks = (name: string): string => `❓ **${name}** is waiting for you.`
const helperOf = (helper: string, butler: string): string => `${helper} (${butler}'s helper)`
export const answerItFirst = (name: string): string =>
  `${name} asked you the question above while you were at the Mac. Answer it first; this message was not delivered.`
const takesYesOrNo = (label: string): string => `a ${label} approval takes yes or no.`

const answerKeysOf = (backend: BackendId | undefined): AnswerKeys | undefined =>
  backend && ANSWER_KEYS[backend]

// MUSE§7 AGY§15
const TYPED_INTO_WHILE_WORKING: Record<BackendId, boolean> = {
  claude: true,
  codex: true,
  muse: false,
  agy: true
}
const typedIntoWhileWorking = (backend: BackendId | undefined): boolean =>
  !backend || TYPED_INTO_WHILE_WORKING[backend]
const ASK_SUFFIX = '.ask.json'
const ANSWER_SUFFIX = '.answer.json'
const QUEUED = '⏳'
const DELIVERED = '✅'
const PAGE = 100
const PROMPT_SETTLES_AFTER_BIND_MS = 1000
const BUTLER_GETS_READY_WITHIN_MS = 10 * 60_000
// AGY§8
const FIRST_PROMPT_BINDS_WITHIN_MS = 10_000
export const HELD_ASKS_CHECKED_EVERY_MS = 30_000

export interface Destination {
  name: string
  liveTab(): string | undefined
  open(): Promise<string>
  typeCommand(tab: string, command: string): Promise<void>
  seen(messageId: string): void
}

export interface CaughtUpChannel {
  channelId: string
  lastMessageId?: string
  seen(messageId: string): void
}

export interface RelayDeps {
  link: Pick<DiscordLink, 'post' | 'upload' | 'react' | 'messages' | 'card'>
  download(url: string): Promise<Buffer>
  owner(): string | undefined
  ownerAway(): boolean
  butlerName(): string
  destinationOf(channelId: string): Destination | undefined
  channels(): CaughtUpChannel[]
  butlerChannelOf(tabId: string): string | undefined
  askChannelOf(tabId: string): string | undefined
  helperTitle(tabId: string): string | undefined
  withButtons(tabId: string, view: DialogView, card: Card): Card
  askPlaced(card: Card, at: PlacedAsk | undefined): void
  answered(tabId: string, reply: string): void
  backendOf(tabId: string): BackendId | undefined
  boundKey(tabId: string): string | undefined
  showsPromptBeforeBind(tabId: string): boolean
  status(tabId: string): SessionStatus | undefined
  awaitsInput(tabId: string): boolean
  turnOver(tabId: string): boolean
  alive(tabId: string): boolean
  ready(tabId: string, ready: () => boolean, ms: number): Promise<boolean>
  asksChanged(tabId: string): void
  type(tabId: string, keys: string[]): Promise<void>
  queueDrained(tabId: string): boolean
  queue(tabId: string, text: string, clientId: string): Promise<void>
  sendLine(tabId: string, line: string, ms: number): Promise<void>
  modeOf(tabId: string): ModeClass
  pendingApproval(tabId: string): CodexApproval | undefined
  pendingQuestion(tabId: string): CodexQuestion | undefined
  answerable(tabId: string): Promise<void>
  answerInPlace(tabId: string, reply: string): Promise<string | undefined | false>
  regDir: string
  attachmentsDir: string
}

interface Inbound {
  clientId: string
  text(): Promise<string>
  command?: boolean
  fromDiscord?: boolean
  quiet?: boolean
  settle(failed?: string): void
}

type DiscordAnswer = 'message' | 'turn'

function slashTextOf(content: string): string | undefined {
  const text = content.trim()
  return text.startsWith('/') ? text : undefined
}

export class DiscordRelay {
  private inbox: Inbound[] = []
  private told = 0
  private pumping = false
  private seenLive = new Set<string>()
  private asks = new Map<string, { payload: AskPayload; hook?: string; raw: string }>()
  private askHooks = new Map<string, Set<string>>()
  private codexAsks = new Map<string, string | number>()
  private cardOrder = new Set<string>()
  private quietReplies = new Set<string>()
  private quietTurns = new Set<string>()
  private answering = new Map<string, DiscordAnswer>()
  private held = new Set<string>()
  private heldCheck: ReturnType<typeof setInterval> | undefined

  constructor(private d: RelayDeps) {}

  reaches(tab: string): boolean {
    return this.answering.has(tab) || this.d.ownerAway()
  }

  private answersDiscord(tab: string, answer: DiscordAnswer): void {
    if (this.answering.get(tab) !== 'message') this.answering.set(tab, answer)
  }

  private holds(tab: string): boolean {
    if (this.reaches(tab)) {
      this.held.delete(tab)
      return false
    }
    this.held.add(tab)
    this.cardOrder.delete(tab)
    this.heldCheck ??= setInterval(() => this.checkHeld(), HELD_ASKS_CHECKED_EVERY_MS).unref()
    return true
  }

  checkHeld(): void {
    const away = this.d.ownerAway()
    for (const tab of [...this.held]) {
      if (!away && this.dialogOpen(tab)) continue
      this.held.delete(tab)
      if (away) this.postOpenAsk(tab)
    }
    if (this.held.size) return
    clearInterval(this.heldCheck)
    this.heldCheck = undefined
  }

  private postOpenAsk(tab: string): void {
    const ask = this.openAsk(tab)
    if (ask) return this.postClaudeAsk(tab, ask.payload)
    const open = this.d.pendingApproval(tab) ?? this.d.pendingQuestion(tab)
    if (open) this.codexAsked(tab, open)
  }

  say(channelId: string, text: string, replyTo?: string): void {
    for (const part of splitForDiscord(toDiscordMarkdown(text)))
      void this.d.link.post(channelId, part, replyTo).catch(() => undefined)
  }

  card(channelId: string, card: Card): Promise<void> {
    return this.d.link.card(channelId, card).then(
      () => undefined,
      () => undefined
    )
  }

  async send(channelId: string, files: DiscordFile[], text: string): Promise<void> {
    const [first = '', ...more] = splitForDiscord(toDiscordMarkdown(text))
    await (files.length
      ? this.d.link.upload(channelId, files, first)
      : this.d.link.post(channelId, first))
    for (const part of more) await this.d.link.post(channelId, part)
  }

  private react(m: DiscordMessage, emoji: string, on: boolean): void {
    void this.d.link.react(m.channelId, m.id, emoji, on).catch(() => undefined)
  }

  onMessage(m: DiscordMessage): void {
    if (m.authorId !== this.d.owner()) return
    const dest = this.d.destinationOf(m.channelId)
    if (!dest) return
    this.seenLive.add(m.id)
    const butlerTab = dest.liveTab()
    if (butlerTab && this.held.delete(butlerTab) && this.dialogOpen(butlerTab)) {
      this.answersDiscord(butlerTab, 'turn')
      this.postOpenAsk(butlerTab)
      this.say(m.channelId, answerItFirst(dest.name), m.id)
      dest.seen(m.id)
      return
    }
    const command = m.attachments.length ? undefined : slashTextOf(m.content)
    const tab = command === undefined ? (this.newestCardWaiting() ?? butlerTab) : butlerTab
    const refusal =
      command === undefined ? undefined : this.commandRefusal(butlerTab, command, dest.name)
    if (
      !refusal &&
      command === undefined &&
      tab &&
      this.heldInTerminal(tab) &&
      this.dialogOpen(tab)
    ) {
      void this.answerSession(tab, m.content).then((error) => {
        if (error) return this.say(m.channelId, error, m.id)
        this.answersDiscord(tab, 'turn')
        this.react(m, DELIVERED, true)
      })
      dest.seen(m.id)
      return
    }
    const answered = command === undefined && !!tab && this.answerDialog(tab, m)
    if (refusal || answered) {
      if (refusal) this.say(m.channelId, refusal, m.id)
      else {
        if (tab) this.answersDiscord(tab, 'turn')
        this.react(m, DELIVERED, true)
      }
      dest.seen(m.id)
      return
    }
    const takes =
      command === undefined ? this.typable(butlerTab ?? '') : this.takesCommand(butlerTab ?? '')
    const waits = !butlerTab || this.pumping || !takes
    if (waits) this.react(m, QUEUED, true)
    this.enqueue(dest, {
      clientId: `koloft-discord-${m.id}`,
      text: command === undefined ? () => this.textOf(m) : async () => command,
      command: command !== undefined,
      fromDiscord: true,
      settle: (failed) => {
        if (waits) this.react(m, QUEUED, false)
        if (failed)
          this.say(
            m.channelId,
            command === undefined ? `${failed} This message was not delivered.` : `⚠ ${failed}`,
            m.id
          )
        else this.react(m, DELIVERED, true)
        dest.seen(m.id)
      }
    })
  }

  private newestCardWaiting(): string | undefined {
    return [...this.cardOrder].reverse().find((tab) => this.dialogOpen(tab))
  }

  private commandRefusal(
    tab: string | undefined,
    command: string,
    name: string
  ): string | undefined {
    if (tab && this.dialogOpen(tab)) return waitingForAnswer(name, command)
    const problem = slashCommandProblem(command)
    return problem && didNotRun(problem)
  }

  command(dest: Destination, command: string, channelId: string): void {
    this.enqueue(dest, {
      clientId: `koloft-command-${++this.told}`,
      text: async () => command,
      command: true,
      settle: (failed) => failed && this.say(channelId, `⚠ ${failed}`)
    })
  }

  tell(
    dest: Destination,
    text: string,
    delivered: (ok: boolean) => void = () => undefined,
    quiet = false
  ): void {
    this.enqueue(dest, {
      clientId: `koloft-notice-${++this.told}`,
      text: async () => text,
      quiet,
      settle: (failed) => delivered(!failed)
    })
  }

  private enqueue(dest: Destination, item: Inbound): void {
    this.inbox.push(item)
    void this.pump(dest)
  }

  private async pump(dest: Destination): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.inbox.length) {
        const item = this.inbox[0]
        const failed = await this.deliver(dest, item)
          .then(() => undefined)
          .catch(errorText)
        this.inbox.shift()
        item.settle(failed)
      }
    } finally {
      this.pumping = false
    }
  }

  private async deliver(dest: Destination, item: Inbound): Promise<void> {
    const tab = await this.readyTab(dest)
    const first = !this.d.boundKey(tab)
    const text = await item.text()
    const answer = item.fromDiscord ? (item.command ? 'turn' : 'message') : undefined
    if (answer) this.answersDiscord(tab, answer)
    if (item.quiet) this.quietTurns.add(tab)
    try {
      await this.hand(dest, tab, item, text)
    } catch (error) {
      if (answer) this.answering.delete(tab)
      if (item.quiet) this.quietTurns.delete(tab)
      throw error
    }
    // AGY§8
    if (first) await this.d.ready(tab, () => !!this.d.boundKey(tab), FIRST_PROMPT_BINDS_WITHIN_MS)
  }

  quietTurn(tab: string): boolean {
    return this.quietTurns.has(tab)
  }

  delivering(): boolean {
    return this.pumping || this.inbox.length > 0
  }

  private async hand(dest: Destination, tab: string, item: Inbound, text: string): Promise<void> {
    if (item.command) return dest.typeCommand(tab, text)
    const backend = this.d.backendOf(tab)
    const route = backend && messagingOf(backend, false)
    if (route === 'peerLine') return this.sendAsPeer(tab, text, item.clientId)
    // ADR-0028 AGY§16
    if (backend !== 'agy' && text.startsWith(DISCORD_PREFIX))
      noteDiscordSaid(this.d.regDir, tab, text)
    if (route === 'queue') return this.d.queue(tab, text, item.clientId)
    await this.d.type(tab, [text, '\r'])
  }

  // CC§13 ADR-0028
  private async sendAsPeer(tab: string, text: string, id: string): Promise<void> {
    const line = crossSessionLine(this.d.modeOf(tab), text, id)
    if (line === null)
      throw new Error('The butler cannot take a message holding </cross-session-message>.')
    if (text.startsWith(DISCORD_PREFIX))
      fs.appendFileSync(discordIdsFile(this.d.regDir, tab), `${id}\n`)
    await this.d.sendLine(tab, line, MESSAGE_SOCKET_SHOWS_WITHIN_MS)
  }

  private async readyTab(dest: Destination): Promise<string> {
    const already = dest.liveTab()
    const tab = await dest.open()
    if (!(await this.d.ready(tab, () => this.typable(tab), BUTLER_GETS_READY_WITHIN_MS)))
      throw new Error(
        this.d.alive(tab)
          ? `${dest.name} did not get ready in time.`
          : `${dest.name} closed before it was ready.`
      )
    if (tab !== already) await sleep(PROMPT_SETTLES_AFTER_BIND_MS)
    return tab
  }

  // AGY§8
  private typable(tab: string): boolean {
    if (this.d.showsPromptBeforeBind(tab)) return true
    const status = this.d.status(tab)
    return (
      !!this.d.boundKey(tab) &&
      status !== undefined &&
      status !== 'approval' &&
      !(status === 'working' && !typedIntoWhileWorking(this.d.backendOf(tab))) &&
      !this.hookWaits(tab)
    )
  }

  // AGY§8
  takesCommand(tab: string): boolean {
    return (
      this.d.showsPromptBeforeBind(tab) ||
      (this.typable(tab) &&
        this.d.turnOver(tab) &&
        !this.dialogOpen(tab) &&
        this.d.queueDrained(tab))
    )
  }

  dialogOpen(tab: string): boolean {
    return !!this.openAsk(tab) || !!this.d.pendingApproval(tab) || !!this.d.pendingQuestion(tab)
  }

  private hookWaits(tab: string): boolean {
    const hooks = this.askHooks.get(tab)
    if (!hooks) return false
    for (const hook of hooks)
      if (!fs.existsSync(this.hookFile(tab, hook, ASK_SUFFIX))) hooks.delete(hook)
    return hooks.size > 0
  }

  private async textOf(m: DiscordMessage): Promise<string> {
    const notes = await Promise.all(m.attachments.map((a) => this.fetchAttachment(m.id, a)))
    return [DISCORD_PREFIX, m.content, ...notes].filter(Boolean).join(' ')
  }

  private async fetchAttachment(messageId: string, a: DiscordAttachment): Promise<string> {
    if (a.size > BYTES_PER_FILE)
      return `(${a.filename} was not passed in: it is larger than 20 MB.)`
    const dir = path.join(this.d.attachmentsDir, messageId)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, safeDownloadName(a.filename))
    fs.writeFileSync(file, await this.d.download(a.url))
    return `(attached file: ${JSON.stringify(file)})`
  }

  tellQuietly(dest: Destination, text: string): Promise<boolean> {
    this.quietReplies.add(text)
    return new Promise((resolve) =>
      this.tell(
        dest,
        text,
        (told) => {
          if (!told) this.quietReplies.delete(text)
          resolve(told)
        },
        true
      )
    )
  }

  turnEnded(tabId: string, turn: Turn): void {
    this.quietTurns.delete(tabId)
    const answers = turn.said.some((line) => line.text.startsWith(DISCORD_PREFIX))
    const reaches = answers || this.reaches(tabId)
    if (answers || this.answering.get(tabId) === 'turn') this.answering.delete(tabId)
    const quiet = [...this.quietReplies].find(
      (q) => turn.said.length > 0 && turn.said.every((l) => l.text.includes(q))
    )
    if (quiet !== undefined) {
      this.quietReplies.delete(quiet)
      return
    }
    const channelId = this.d.butlerChannelOf(tabId)
    if (channelId && reaches && turn.reply.trim()) this.say(channelId, turn.reply)
  }

  private hookFile(tab: string, hook: string, suffix: string): string {
    return path.join(this.d.regDir, `${tab}.${hook}${suffix}`)
  }

  private openAsk(tab: string): { payload: AskPayload; hook?: string } | undefined {
    const ask = this.asks.get(tab)
    if (!ask?.hook) return ask
    return fs.existsSync(this.hookFile(tab, ask.hook, ASK_SUFFIX)) ? ask : undefined
  }

  // CC§14
  watchAsks(): fs.FSWatcher | null {
    return watchJsonDrops(this.d.regDir, (name) => {
      if (!name.endsWith(ASK_SUFFIX)) return null
      const [tab, hook] = name.slice(0, -ASK_SUFFIX.length).split('.')
      if (!hook) return null
      if (fs.existsSync(path.join(this.d.regDir, name)))
        return (obj): void => this.onAsk(tab, obj as AskPayload, hook)
      if (this.askHooks.get(tab)?.delete(hook)) this.d.asksChanged(tab)
      return null
    })
  }

  private askCard(tab: string, view: DialogView, how: string, shown = view.text): Card {
    const helper = this.d.helperTitle(tab)
    const butler = this.d.butlerName()
    const card: Card = {
      accent: CONDUCTOR_ACCENT,
      header: butlerAsks(helper === undefined ? butler : helperOf(helper, butler)),
      body: shown,
      footer: `-# ${how}`
    }
    return view.choices.length ? this.d.withButtons(tab, view, card) : card
  }

  private postAsk(tab: string, channelId: string, card: Card): void {
    this.cardOrder.delete(tab)
    this.cardOrder.add(tab)
    void this.d.link
      .card(channelId, card)
      .then(
        (ids) => ids.at(-1),
        () => undefined
      )
      .then((messageId) => {
        if (card.buttons?.length)
          this.d.askPlaced(card, messageId ? { channelId, messageId } : undefined)
      })
  }

  onAsk(tab: string, payload: AskPayload, hook?: string): void {
    const raw = JSON.stringify(payload)
    const before = this.asks.get(tab)
    if (before && before.hook === hook && before.raw === raw) return
    if (before?.hook && before.hook !== hook) this.release(tab, before.hook)
    this.asks.set(tab, { payload, hook, raw })
    if (hook) this.askHooks.set(tab, (this.askHooks.get(tab) ?? new Set()).add(hook))
    this.d.asksChanged(tab)
    this.postClaudeAsk(tab, payload)
  }

  private postClaudeAsk(tab: string, payload: AskPayload): void {
    const channelId = this.d.askChannelOf(tab)
    if (channelId && !this.holds(tab))
      this.postAsk(tab, channelId, this.askCard(tab, claudeDialog(payload), askHow(payload)))
  }

  dialog(tab: string): DialogView | undefined {
    const ask = this.openAsk(tab)
    return ask && claudeDialog(ask.payload)
  }

  private release(tab: string, hook: string, output: unknown = {}): void {
    if (!fs.existsSync(this.hookFile(tab, hook, ASK_SUFFIX))) return
    try {
      writeWholeBeforeVisible(this.hookFile(tab, hook, ANSWER_SUFFIX), JSON.stringify(output))
    } catch {}
  }

  private answer(tab: string, output: unknown): void {
    const hook = this.asks.get(tab)?.hook
    this.asks.delete(tab)
    if (hook) this.release(tab, hook, output)
  }

  // CC§14
  toolDone(tab: string, call: ToolCall): void {
    const ask = this.asks.get(tab)
    if (ask && isAskedCall(ask.payload, call)) this.answer(tab, {})
  }

  private async press(tab: string, keys: string[]): Promise<void> {
    this.codexAsks.delete(tab)
    await this.d.answerable(tab)
    await this.d.type(tab, keys)
  }

  async answerSession(tab: string, reply: string): Promise<string | undefined> {
    const error = await this.answerNow(tab, reply)
    if (error === undefined) this.d.answered(tab, reply)
    return error
  }

  private async answerNow(tab: string, reply: string): Promise<string | undefined> {
    const backend = this.d.backendOf(tab)
    const answerKeysFor = answerKeysOf(backend)
    if (backend && answerKeysFor) {
      const inPlace = await this.d.answerInPlace(tab, reply)
      if (inPlace !== false) {
        this.codexAsks.delete(tab)
        return inPlace
      }
      const label = BACKEND_LABEL[backend]
      if (this.d.pendingApproval(tab)) {
        const key = codexKeyFor(reply)
        if (!key) return takesYesOrNo(label)
        await this.press(tab, [key])
        return undefined
      }
      const question = this.d.pendingQuestion(tab)
      if (!question) return this.d.awaitsInput(tab) ? inputNotProbed(label) : SHOWS_NO_DIALOG
      const answers = questionAnswers(question, reply)
      if (!answers) return takesAnAnswer(label, question)
      await this.press(tab, answerKeys(answerKeysFor, question, answers))
      return undefined
    }
    const ask = this.openAsk(tab)
    if (!ask)
      return this.d.status(tab) === 'approval' || this.d.awaitsInput(tab)
        ? ASKS_WHAT_KOLOFT_CANNOT_SEE
        : SHOWS_NO_DIALOG
    if (ask.hook) {
      this.answer(tab, hookAnswer(ask.payload, reply))
      return undefined
    }
    if (this.d.turnOver(tab) && !this.d.awaitsInput(tab)) return SHOWS_NO_DIALOG
    const keys = claudeKeysFor(ask.payload, reply)
    if (!keys.ok) return keys.error
    this.asks.delete(tab)
    await this.d.type(tab, keys.value)
    return undefined
  }

  codexAsked(tab: string, a: CodexApproval | CodexQuestion): void {
    const channelId = this.d.askChannelOf(tab)
    if (!channelId || this.codexAsks.get(tab) === a.id || this.holds(tab)) return
    this.codexAsks.set(tab, a.id)
    const view = codexDialog(a)
    const question = 'questions' in a
    const how = question ? howToAnswer(a) : CODEX_NEEDS_YES_OR_NO
    const label = BACKEND_LABEL[this.d.backendOf(tab) ?? 'codex']
    const shown = question ? view.text : `${label} asks to run: ${view.text || 'a command'}`
    this.postAsk(tab, channelId, this.askCard(tab, view, how, shown))
  }

  // CC§14
  private heldInTerminal(tab: string): boolean {
    const ask = this.openAsk(tab)
    return !!ask && !ask.hook && !(this.d.turnOver(tab) && !this.d.awaitsInput(tab))
  }

  private answerDialog(tab: string, m: DiscordMessage): boolean {
    const ask = this.openAsk(tab)
    if (ask?.hook) {
      this.answer(tab, hookAnswer(ask.payload, m.content))
      this.d.answered(tab, m.content)
      return true
    }
    this.asks.delete(tab)
    const asked = this.codexAsks.get(tab)
    if (asked === undefined) return false
    const open = this.d.pendingApproval(tab) ?? this.d.pendingQuestion(tab)
    const keys = answerKeysOf(this.d.backendOf(tab))
    if (!open || open.id !== asked || !keys) {
      this.codexAsks.delete(tab)
      return false
    }
    void this.d.answerInPlace(tab, m.content).then((inPlace) => {
      if (inPlace === false) return this.answerOpenByKeys(tab, m, open, keys)
      this.codexAsks.delete(tab)
      if (inPlace) this.say(m.channelId, 'questions' in open ? cannotAnswer(open) : inPlace, m.id)
      else this.d.answered(tab, m.content)
    })
    return true
  }

  private answerOpenByKeys(
    tab: string,
    m: DiscordMessage,
    open: CodexApproval | CodexQuestion,
    keys: AnswerKeys
  ): void {
    if ('questions' in open) {
      const answers = questionAnswers(open, m.content)
      if (answers)
        void this.press(tab, answerKeys(keys, open, answers)).then(() =>
          this.d.answered(tab, m.content)
        )
      else this.say(m.channelId, cannotAnswer(open), m.id)
      return
    }
    const key = codexKeyFor(m.content)
    if (key) void this.press(tab, [key]).then(() => this.d.answered(tab, m.content))
    else this.say(m.channelId, CODEX_NEEDS_YES_OR_NO, m.id)
  }

  forget(tab: string): void {
    this.answer(tab, {})
    this.codexAsks.delete(tab)
    this.askHooks.delete(tab)
    this.cardOrder.delete(tab)
    this.answering.delete(tab)
    this.held.delete(tab)
    this.quietTurns.delete(tab)
  }

  async catchUp(): Promise<void> {
    const owner = this.d.owner()
    for (const c of this.d.channels()) {
      const channelId = c.channelId
      try {
        if (!c.lastMessageId) {
          const [latest] = await this.d.link.messages(channelId, undefined, 1)
          if (latest) c.seen(latest.id)
          continue
        }
        let after = c.lastMessageId
        for (;;) {
          const page = await this.d.link.messages(channelId, after, PAGE)
          for (const m of page.sort((x, y) => (newerSnowflake(x.id, y.id) ? 1 : -1))) {
            if (!m.bot && m.authorId === owner && !this.seenLive.has(m.id))
              this.say(channelId, OFFLINE_REPLY, m.id)
            after = m.id
          }
          if (page.length < PAGE) break
        }
        c.seen(after)
      } catch {}
    }
  }
}
