import fs from 'fs'
import path from 'path'
import type { BackendId, SessionStatus } from '@shared/types'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import type { Turn } from '@shared/turns'
import { newerSnowflake } from '@plugins/discord/shared/channels'
import { safeDownloadName } from '@shared/downloadName'
import { errorText } from '@core/errorText'
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
import type { HandOver, HandingMarks, Recipient } from '@plugins/sessions/api'
import {
  ANSWER_NOT_TAKEN,
  askHow,
  claudeDialog,
  codexDialog,
  howToAnswer,
  REPLY_YES_OR_NO,
  type CodexApproval,
  type CodexQuestion,
  type DialogView
} from '@plugins/sessions/main/dialog'
import { answerKeysOf, type SessionAsks } from '@plugins/sessions/main/sessionAsks'

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
export const HELD_ASKS_CHECKED_EVERY_MS = 30_000

export interface Destination extends Recipient {
  channelId: string
  typeCommand(tab: string, command: string): Promise<void>
  seen(messageId: string): void
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
  pendingApproval(tabId: string): CodexApproval | undefined
  pendingQuestion(tabId: string): CodexQuestion | undefined
  asks: Pick<
    SessionAsks,
    | 'listen'
    | 'dialogOpen'
    | 'typable'
    | 'takesCommand'
    | 'askOf'
    | 'heldAsk'
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
  helperTitle(tabId: string): string | undefined
  inRoom(tabId: string): boolean
  withButtons(tabId: string, view: DialogView, card: Card): Card
  askPlaced(card: Card, at: PlacedAsk | undefined): void
  handOver: Pick<HandOver, 'hand' | 'delivering'>
  attachmentsDir: string
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
  private commands = 0
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
    const waits = !tab || this.d.handOver.delivering(dest.key) || !takes
    if (waits) this.react(m, QUEUED, true)
    const answer: DiscordAnswer = command === undefined ? 'message' : 'turn'
    const clientId = `koloft-discord-${m.id}`
    this.d.handOver.hand(dest, {
      clientId,
      text: command === undefined ? () => this.textOf(m) : async () => command,
      ...(command !== undefined && { typeAsCommand: (t, c) => dest.typeCommand(t, c) }),
      handing: (t) => this.answersDiscord(t, answer),
      notHanded: (t) => void this.answering.delete(t),
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
    this.d.handOver.hand(dest, {
      clientId: `koloft-command-${++this.commands}`,
      text: async () => command,
      typeAsCommand: (t, c) => dest.typeCommand(t, c),
      settle: (failed) => failed && this.say(channelId, `⚠ ${failed}`)
    })
  }

  readonly quietMarks: HandingMarks = {
    handing: (tab, said) => {
      this.quietTurns.add(tab)
      this.quietTexts.set(tab, [...(this.quietTexts.get(tab) ?? []), said])
    },
    notHanded: (tab, said) => {
      this.quietTurns.delete(tab)
      this.quietTexts.set(tab, withoutOne(this.quietTexts.get(tab) ?? [], said))
    }
  }

  quietTurn(tab: string): boolean {
    return this.quietTurns.has(tab)
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

  askerName(tab: string): string {
    const helper = this.d.helperTitle(tab)
    const butler = this.d.butlerName()
    return helper === undefined ? butler : this.d.inRoom(tab) ? helper : helperOf(helper, butler)
  }

  private askCard(tab: string, view: DialogView, how: string): Card {
    const card: Card = {
      accent: CONDUCTOR_ACCENT,
      header: butlerAsks(this.askerName(tab)),
      body: view.text,
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
        this.askCard(tab, claudeDialog(payload), askHow(payload, !!this.d.asks.heldAsk(tab))),
        stillAsked
      )
  }

  codexAsked(tab: string, a: CodexApproval | CodexQuestion): void {
    const channelId = this.d.askChannelOf(tab)
    if (!channelId || this.codexAsks.get(tab) === a.id || this.holds(tab)) return
    this.codexAsks.set(tab, a.id)
    const view = codexDialog(a, BACKEND_LABEL[this.d.backendOf(tab) ?? 'codex'])
    const how = 'questions' in a ? howToAnswer(a) : REPLY_YES_OR_NO
    this.postAsk(
      tab,
      channelId,
      this.askCard(tab, view, how),
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
    return this.d.asks.answerSession(tab, m.content, { toItsCard: true })
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
