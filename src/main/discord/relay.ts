import fs from 'fs'
import path from 'path'
import type { BackendId, SessionStatus } from '@shared/types'
import { BACKEND_LABEL, messagingOf } from '@shared/sessionBackend'
import type { Turn } from '@shared/turns'
import { newerSnowflake } from '@plugins/discord/shared/channels'
import { safeDownloadName } from '@shared/downloadName'
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
import { DISCORD_PREFIX } from '@plugins/discord/api'
import {
  MESSAGE_SOCKET_SHOWS_WITHIN_MS,
  crossSessionLine,
  fitsACrossSessionMessage,
  type ModeClass
} from '../crossSessionMessage'
import {
  ANSWER_NOT_TAKEN,
  askHow,
  claudeDialog,
  codexDialog,
  howToAnswer,
  type CodexApproval,
  type CodexQuestion,
  type DialogView
} from '@plugins/sessions/main/dialog'
import {
  answerKeysOf,
  CODEX_NEEDS_YES_OR_NO,
  type SessionAsks
} from '@plugins/sessions/main/sessionAsks'

export const OFFLINE_REPLY = 'Koloft was offline, this message was not delivered.'
export const butlerAsks = (name: string): string => `❓ **${name}** is waiting for you.`
const helperOf = (helper: string, butler: string): string => `${helper} (${butler}'s helper)`
export const unreadableInRoom = (butler: string, lobby: string | undefined): string =>
  `Koloft cannot read this question from here. Ask ${butler}${lobby ? ` in ${lobby}` : ''} to press its keys for you.`
export const answerItFirst = (name: string): string =>
  `${name} asked you the question above while you were at the Mac. Answer it first; this message was not delivered.`

const QUEUED = '⏳'
const DELIVERED = '✅'
const PAGE = 100
const PROMPT_SETTLES_AFTER_BIND_MS = 1000
const BUTLER_GETS_READY_WITHIN_MS = 10 * 60_000
// AGY§8
const FIRST_PROMPT_BINDS_WITHIN_MS = 10_000
export const HELD_ASKS_CHECKED_EVERY_MS = 30_000

export interface Destination {
  channelId: string
  name: string
  liveTab(): string | undefined
  open(): Promise<string>
  typeCommand(tab: string, command: string): Promise<void>
  seen(messageId: string): void
  ownerIsWhere?(): string
  ownerSpoke?(): void
}

export interface CaughtUpChannel {
  channelId: string
  lastMessageId?: string
  seen(messageId: string): void
  handsOverTo?: Destination
}

export interface RelayDeps {
  backendOf(tabId: string): BackendId | undefined
  status(tabId: string): SessionStatus | undefined
  awaitsInput(tabId: string): boolean
  type(tabId: string, keys: string[], stillWanted?: () => boolean): Promise<boolean>
  pendingApproval(tabId: string): CodexApproval | undefined
  pendingQuestion(tabId: string): CodexQuestion | undefined
  asks: Pick<
    SessionAsks,
    | 'listen'
    | 'dialogOpen'
    | 'typable'
    | 'takesCommand'
    | 'askOf'
    | 'stillAsks'
    | 'claudeAskAnswerable'
    | 'dropClaudeAsk'
    | 'answerSession'
  >
  link: Pick<DiscordLink, 'post' | 'upload' | 'react' | 'messages' | 'card'>
  download(url: string): Promise<Buffer>
  owner(): string | undefined
  ownerAway(): boolean
  ownerWrote(): void
  butlerName(): string
  destinationOf(channelId: string): Destination | undefined
  channels(): CaughtUpChannel[]
  replyChannelOf(tabId: string): string | undefined
  askChannelOf(tabId: string): string | undefined
  lobbyLink(): string | undefined
  noteDiscordId(tabId: string, id: string): Promise<void>
  noteDiscordSaid(tabId: string, text: string): Promise<void>
  helperTitle(tabId: string): string | undefined
  inRoom(tabId: string): boolean
  withButtons(tabId: string, view: DialogView, card: Card): Card
  askPlaced(card: Card, at: PlacedAsk | undefined): void
  boundKey(tabId: string): string | undefined
  alive(tabId: string): boolean
  ready(tabId: string, ready: () => boolean, ms: number): Promise<boolean>
  queue(tabId: string, text: string, clientId: string): Promise<void>
  sendLine(tabId: string, line: string, ms: number): Promise<void>
  modeOf(tabId: string): ModeClass
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

type SendTo = (channelId: string) => Promise<void>

function slashTextOf(content: string): string | undefined {
  const text = content.trim()
  return text.startsWith('/') ? text : undefined
}

function withoutOne(texts: string[], text: string): string[] {
  const i = texts.indexOf(text)
  return i < 0 ? texts : [...texts.slice(0, i), ...texts.slice(i + 1)]
}

export class DiscordRelay {
  private queues = new Map<string, Inbound[]>()
  private told = 0
  private seenLive = new Set<string>()
  private codexAsks = new Map<string, string | number>()
  private quietTexts = new Map<string, string[]>()
  private quietTurns = new Set<string>()
  private answering = new Map<string, DiscordAnswer>()
  private held = new Set<string>()
  private unreadable = new Set<string>()
  private shownNotSent = new Map<string, SendTo[]>()
  private sending = new Map<string, Promise<void>>()
  private heldCheck: ReturnType<typeof setInterval> | undefined

  constructor(private d: RelayDeps) {
    d.asks.listen({
      asked: (tab, payload) => this.postClaudeAsk(tab, payload),
      answerGoingIn: (tab) => void this.codexAsks.delete(tab)
    })
  }

  answeringDiscord(tab: string): boolean {
    return this.answering.has(tab)
  }

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
    this.heldCheck ??= setInterval(() => this.checkHeld(), HELD_ASKS_CHECKED_EVERY_MS).unref()
    return true
  }

  checkHeld(): void {
    const away = this.d.ownerAway()
    for (const tab of [...this.held]) {
      if (!away && this.d.asks.dialogOpen(tab)) continue
      this.held.delete(tab)
      if (away) this.postOpenAsk(tab)
    }
    if (this.held.size) return
    clearInterval(this.heldCheck)
    this.heldCheck = undefined
  }

  roomOpened(tab: string): void {
    this.answersDiscord(tab, 'turn')
    this.held.delete(tab)
    this.postOpenAsk(tab)
  }

  private postOpenAsk(tab: string): void {
    const asked = this.d.asks.askOf(tab)
    if (asked) return this.postClaudeAsk(tab, asked)
    const open = this.d.pendingApproval(tab) ?? this.d.pendingQuestion(tab)
    if (open) return this.codexAsked(tab, open)
    if (this.d.status(tab) === 'approval' || this.d.awaitsInput(tab)) this.asksUnreadably(tab)
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

  send(channelId: string, files: DiscordFile[], text: string): Promise<void> {
    return this.sendParts(channelId, files, splitForDiscord(toDiscordMarkdown(text)))
  }

  async sendParts(channelId: string, files: DiscordFile[], parts: string[]): Promise<void> {
    const [first = '', ...more] = parts
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
    this.d.ownerWrote()
    this.seenLive.add(m.id)
    this.take(dest, m)
  }

  private take(dest: Destination, m: DiscordMessage): void {
    dest.ownerSpoke?.()
    const tab = dest.liveTab()
    if (tab && this.held.delete(tab) && this.d.asks.dialogOpen(tab)) {
      this.answersDiscord(tab, 'turn')
      this.postOpenAsk(tab)
      this.say(m.channelId, answerItFirst(dest.name), m.id)
      dest.seen(m.id)
      return
    }
    const command = m.attachments.length ? undefined : slashTextOf(m.content)
    const refusal = command === undefined ? undefined : this.commandRefusal(tab, command, dest.name)
    if (refusal) {
      this.say(m.channelId, refusal, m.id)
      dest.seen(m.id)
      return
    }
    const answering = command === undefined && tab ? this.answerDialog(tab, m) : undefined
    if (tab && answering) {
      void answering.catch(errorText).then((error) => {
        if (!error || error === ANSWER_NOT_TAKEN) this.answersDiscord(tab, 'turn')
        if (error) return this.say(m.channelId, error, m.id)
        this.react(m, DELIVERED, true)
      })
      dest.seen(m.id)
      return
    }
    const takes =
      command === undefined ? this.d.asks.typable(tab ?? '') : this.d.asks.takesCommand(tab ?? '')
    const waits = !tab || this.delivering(dest.channelId) || !takes
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

  private commandRefusal(
    tab: string | undefined,
    command: string,
    name: string
  ): string | undefined {
    if (tab && this.d.asks.dialogOpen(tab)) return waitingForAnswer(name, command)
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
    const waiting = this.queues.get(dest.channelId)
    if (waiting) return void waiting.push(item)
    const items = [item]
    this.queues.set(dest.channelId, items)
    void this.pump(dest, items)
  }

  private async pump(dest: Destination, items: Inbound[]): Promise<void> {
    try {
      while (items.length) {
        const item = items[0]
        const failed = await this.deliver(dest, item)
          .then(() => undefined)
          .catch(errorText)
        items.shift()
        item.settle(failed)
      }
    } finally {
      this.queues.delete(dest.channelId)
    }
  }

  private async deliver(dest: Destination, item: Inbound): Promise<void> {
    const tab = await this.readyTab(dest)
    const first = !this.d.boundKey(tab)
    const said = await item.text()
    const fromKoloft = !item.command && !item.fromDiscord
    const text = fromKoloft && dest.ownerIsWhere ? `${said} ${dest.ownerIsWhere()}` : said
    const answer = item.fromDiscord ? (item.command ? 'turn' : 'message') : undefined
    if (answer) this.answersDiscord(tab, answer)
    if (item.quiet) {
      this.quietTurns.add(tab)
      this.quietTexts.set(tab, [...(this.quietTexts.get(tab) ?? []), said])
    }
    try {
      await this.hand(dest, tab, item, text)
    } catch (error) {
      if (answer) this.answering.delete(tab)
      if (item.quiet) {
        this.quietTurns.delete(tab)
        this.quietTexts.set(tab, withoutOne(this.quietTexts.get(tab) ?? [], said))
      }
      throw error
    }
    // AGY§8
    if (first) await this.d.ready(tab, () => !!this.d.boundKey(tab), FIRST_PROMPT_BINDS_WITHIN_MS)
  }

  quietTurn(tab: string): boolean {
    return this.quietTurns.has(tab)
  }

  delivering(channelId: string): boolean {
    return this.queues.has(channelId)
  }

  private async hand(dest: Destination, tab: string, item: Inbound, text: string): Promise<void> {
    if (item.command) return dest.typeCommand(tab, text)
    const backend = this.d.backendOf(tab)
    const route = backend && messagingOf(backend, false)
    if (route === 'peerLine') return this.sendAsPeer(tab, text, item.clientId)
    // ADR-0028 AGY§16
    if (backend !== 'agy' && text.startsWith(DISCORD_PREFIX))
      await this.d.noteDiscordSaid(tab, text)
    if (route === 'queue') return this.d.queue(tab, text, item.clientId)
    await this.d.type(tab, [text, '\r'])
  }

  // CC§13 ADR-0028
  private async sendAsPeer(tab: string, text: string, id: string): Promise<void> {
    if (!fitsACrossSessionMessage(text))
      throw new Error('Koloft cannot hand over a message holding </cross-session-message>.')
    if (text.startsWith(DISCORD_PREFIX)) await this.d.noteDiscordId(tab, id)
    await this.d.sendLine(
      tab,
      crossSessionLine(this.d.modeOf(tab), text, id),
      MESSAGE_SOCKET_SHOWS_WITHIN_MS
    )
  }

  private async readyTab(dest: Destination): Promise<string> {
    const already = dest.liveTab()
    const tab = await dest.open()
    if (!(await this.d.ready(tab, () => this.d.asks.typable(tab), BUTLER_GETS_READY_WITHIN_MS)))
      throw new Error(
        this.d.alive(tab)
          ? `${dest.name} did not get ready in time.`
          : `${dest.name} closed before it was ready.`
      )
    if (tab !== already) await sleep(PROMPT_SETTLES_AFTER_BIND_MS)
    return tab
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
    return new Promise((resolve) => this.tell(dest, text, resolve, true))
  }

  turnEnded(tabId: string, turn: Turn): void {
    this.quietTurns.delete(tabId)
    this.shownNotSent.delete(tabId)
    const answers = turn.said.some((line) => line.text.startsWith(DISCORD_PREFIX))
    const reaches = answers || this.reaches(tabId)
    if (answers || this.answering.get(tabId) === 'turn') this.answering.delete(tabId)
    const left = [...(this.quietTexts.get(tabId) ?? [])]
    let quiet = turn.said.length > 0
    for (const line of turn.said) {
      const i = left.findIndex((t) => line.text.includes(t))
      if (i < 0) quiet = false
      else left.splice(i, 1)
    }
    this.quietTexts.set(tabId, left)
    if (quiet) return
    const channelId = this.d.replyChannelOf(tabId)
    if (channelId && reaches && turn.reply.trim()) this.say(channelId, turn.reply)
  }

  private askerName(tab: string): string {
    const helper = this.d.helperTitle(tab)
    const butler = this.d.butlerName()
    return helper === undefined ? butler : this.d.inRoom(tab) ? helper : helperOf(helper, butler)
  }

  private askCard(tab: string, view: DialogView, how: string, shown = view.text): Card {
    const card: Card = {
      accent: CONDUCTOR_ACCENT,
      header: butlerAsks(this.askerName(tab)),
      body: shown,
      footer: `-# ${how}`
    }
    return view.choices.length ? this.d.withButtons(tab, view, card) : card
  }

  asksUnreadably(tab: string): void {
    const channelId = this.d.askChannelOf(tab)
    if (
      !channelId ||
      !this.d.inRoom(tab) ||
      this.unreadable.has(tab) ||
      this.d.asks.dialogOpen(tab)
    )
      return
    if (this.holds(tab)) return
    this.unreadable.add(tab)
    const card: Card = {
      accent: CONDUCTOR_ACCENT,
      header: butlerAsks(this.askerName(tab)),
      body: unreadableInRoom(this.d.butlerName(), this.d.lobbyLink())
    }
    this.afterShownNotSent(
      tab,
      channelId,
      () => void this.card(channelId, card),
      () => this.unreadable.has(tab) && !this.d.asks.dialogOpen(tab)
    )
  }

  stoppedAsking(tab: string): void {
    this.unreadable.delete(tab)
  }

  sendWithNextAsk(tab: string, send: SendTo): void {
    this.shownNotSent.set(tab, [...(this.shownNotSent.get(tab) ?? []), send])
  }

  cardsWaitFor(tab: string, step: Promise<unknown>): void {
    const done: Promise<void> = Promise.allSettled([this.sending.get(tab), step]).then(() => {
      if (this.sending.get(tab) === done) this.sending.delete(tab)
    })
    this.sending.set(tab, done)
  }

  private afterShownNotSent(
    tab: string,
    channelId: string,
    post: () => void,
    stillAsked: () => boolean
  ): void {
    const sends = this.shownNotSent.get(tab) ?? []
    const before = this.sending.get(tab)
    if (!before && !sends.length) return post()
    this.shownNotSent.delete(tab)
    this.cardsWaitFor(
      tab,
      sends
        .reduce(
          (sent, send) => sent.then(() => send(channelId)).catch(() => undefined),
          before ?? Promise.resolve()
        )
        .then(() => {
          if (stillAsked()) post()
        })
    )
  }

  private postAsk(tab: string, channelId: string, card: Card, stillAsked: () => boolean): void {
    this.afterShownNotSent(
      tab,
      channelId,
      () => {
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
      },
      stillAsked
    )
  }

  private postClaudeAsk(tab: string, payload: AskPayload): void {
    const channelId = this.d.askChannelOf(tab)
    const stillAsked = this.d.asks.stillAsks(tab)
    if (channelId && !this.holds(tab))
      this.postAsk(
        tab,
        channelId,
        this.askCard(tab, claudeDialog(payload), askHow(payload)),
        stillAsked
      )
  }

  codexAsked(tab: string, a: CodexApproval | CodexQuestion): void {
    const channelId = this.d.askChannelOf(tab)
    if (!channelId || this.codexAsks.get(tab) === a.id || this.holds(tab)) return
    this.codexAsks.set(tab, a.id)
    const view = codexDialog(a)
    const question = 'questions' in a
    const how = question ? howToAnswer(a) : CODEX_NEEDS_YES_OR_NO
    const label = BACKEND_LABEL[this.d.backendOf(tab) ?? 'codex']
    const shown =
      question || a.plan ? view.text : `${label} asks to run: ${view.text || 'a command'}`
    this.postAsk(
      tab,
      channelId,
      this.askCard(tab, view, how, shown),
      () => (this.d.pendingApproval(tab) ?? this.d.pendingQuestion(tab))?.id === a.id
    )
  }

  private answerDialog(tab: string, m: DiscordMessage): Promise<string | undefined> | undefined {
    if (this.d.asks.claudeAskAnswerable(tab)) return this.d.asks.answerSession(tab, m.content)
    this.d.asks.dropClaudeAsk(tab)
    const asked = this.codexAsks.get(tab)
    if (asked === undefined) return undefined
    const open = this.d.pendingApproval(tab) ?? this.d.pendingQuestion(tab)
    if (!open || open.id !== asked || !answerKeysOf(this.d.backendOf(tab))) {
      this.codexAsks.delete(tab)
      return undefined
    }
    return this.d.asks.answerSession(tab, m.content, true)
  }

  forget(tab: string): void {
    this.codexAsks.delete(tab)
    this.answering.delete(tab)
    this.held.delete(tab)
    this.unreadable.delete(tab)
    this.quietTurns.delete(tab)
    this.quietTexts.delete(tab)
    this.shownNotSent.delete(tab)
    this.sending.delete(tab)
  }

  // PLATFORM§39
  private missed(c: CaughtUpChannel, m: DiscordMessage): boolean {
    if (!c.handsOverTo) {
      this.say(c.channelId, OFFLINE_REPLY, m.id)
      return false
    }
    this.seenLive.add(m.id)
    this.take(c.handsOverTo, m)
    return true
  }

  private async catchUpOn(c: CaughtUpChannel, owner: string | undefined): Promise<void> {
    if (!c.lastMessageId) {
      const [latest] = await this.d.link.messages(c.channelId, undefined, 1)
      if (latest) c.seen(latest.id)
      return
    }
    let after = c.lastMessageId
    let handedOver = false
    for (;;) {
      const page = await this.d.link.messages(c.channelId, after, PAGE)
      for (const m of page.sort((x, y) => (newerSnowflake(x.id, y.id) ? 1 : -1))) {
        if (!m.bot && m.authorId === owner && !this.seenLive.has(m.id))
          handedOver = this.missed(c, m) || handedOver
        after = m.id
      }
      if (page.length < PAGE) break
    }
    if (!handedOver) c.seen(after)
  }

  async catchUp(): Promise<void> {
    const owner = this.d.owner()
    await Promise.allSettled(this.d.channels().map((c) => this.catchUpOn(c, owner)))
  }
}
