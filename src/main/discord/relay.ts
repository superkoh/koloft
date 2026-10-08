import fs from 'fs'
import path from 'path'
import type { BackendId, SessionStatus } from '@shared/types'
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
import { didNotRun, slashCommandProblem, waitingForAnswer } from '@shared/slashCommands'
import type { AskPayload } from '@shared/sessionEvent'
import type { ToolCall } from '../sessionTracker'
import {
  askHow,
  claudeDialog,
  claudeKeysFor,
  codexDialog,
  codexKeyFor,
  codexOptionKey,
  hookAnswer,
  isAskedCall,
  PICK_ONE_OPTION,
  type CodexApproval,
  type CodexQuestion,
  type DialogView
} from './dialog'

export const OFFLINE_REPLY = 'Koloft was offline, this message was not delivered.'
export const CODEX_NEEDS_YES_OR_NO = 'Reply yes or no.'
export const SHOWS_NO_DIALOG = 'it shows no question or approval right now.'
export const CODEX_INPUT_NOT_PROBED =
  'Codex is asking something Koloft cannot answer from here: it answers a yes-or-no approval, or one question that picks one option from a list. Answer this one at the Mac.'
export const CONDUCTOR_ASKS = '❓ **The conductor** is waiting for you.'
const CODEX_TAKES_YES_OR_NO = 'a Codex approval takes yes or no.'
const CODEX_TAKES_AN_OPTION = 'this Codex question takes the number or the name of one option.'
const ASK_SUFFIX = '.ask.json'
const ANSWER_SUFFIX = '.answer.json'
const QUEUED = '⏳'
const DELIVERED = '✅'
const PAGE = 100
const PROMPT_SETTLES_AFTER_BIND_MS = 1000
const CONDUCTOR_GETS_READY_WITHIN_MS = 10 * 60_000

export interface Destination {
  id: string
  name: string
  conductor: boolean
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
  destinationOf(channelId: string): Destination | undefined
  channels(): CaughtUpChannel[]
  conductorChannelOf(tabId: string): string | undefined
  withButtons(tabId: string, view: DialogView, card: Card): Card
  backendOf(tabId: string): BackendId | undefined
  remote(tabId: string): boolean
  boundKey(tabId: string): string | undefined
  status(tabId: string): SessionStatus | undefined
  awaitsInput(tabId: string): boolean
  turnOver(tabId: string): boolean
  waiting(tabId: string): void
  alive(tabId: string): boolean
  ready(tabId: string, ready: () => boolean, ms: number): Promise<boolean>
  asksChanged(tabId: string): void
  type(tabId: string, keys: string[]): Promise<void>
  queueDrained(tabId: string): boolean
  queue(tabId: string, text: string, clientId: string): Promise<void>
  codexApproval(tabId: string): CodexApproval | undefined
  codexQuestion(tabId: string): CodexQuestion | undefined
  regDir: string
  attachmentsDir: string
}

interface Inbound {
  clientId: string
  text(tab: string): Promise<string>
  command?: boolean
  settle(failed?: string): void
}

function slashTextOf(content: string): string | undefined {
  const text = content.trim()
  return text.startsWith('/') ? text : undefined
}

export class DiscordRelay {
  private inbox = new Map<string, Inbound[]>()
  private told = 0
  private pumping = new Set<string>()
  private seenLive = new Set<string>()
  private asks = new Map<string, { payload: AskPayload; hook?: string; raw: string }>()
  private askHooks = new Map<string, Set<string>>()
  private codexAsks = new Map<string, string | number>()

  constructor(private d: RelayDeps) {}

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
    const tab = dest.liveTab()
    const command = m.attachments.length ? undefined : slashTextOf(m.content)
    const refusal = command === undefined ? undefined : this.commandRefusal(tab, command, dest.name)
    if (!refusal && command === undefined && tab && !dest.conductor && this.dialogOpen(tab)) {
      void this.answerSession(tab, m.content).then((error) =>
        error ? this.say(m.channelId, error, m.id) : this.react(m, DELIVERED, true)
      )
      dest.seen(m.id)
      return
    }
    const answered = command === undefined && !!tab && dest.conductor && this.answerDialog(tab, m)
    if (refusal || answered) {
      if (refusal) this.say(m.channelId, refusal, m.id)
      else this.react(m, DELIVERED, true)
      dest.seen(m.id)
      return
    }
    const takes = command === undefined ? this.typable(tab ?? '') : this.takesCommand(tab ?? '')
    const waits = !tab || this.pumping.has(dest.id) || !takes
    if (waits) this.react(m, QUEUED, true)
    this.enqueue(dest, {
      clientId: `koloft-discord-${m.id}`,
      text: command === undefined ? (tab) => this.textOf(m, dest, tab) : async () => command,
      command: command !== undefined,
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

  tell(dest: Destination, text: string): void {
    this.enqueue(dest, {
      clientId: `koloft-notice-${++this.told}`,
      text: async () => text,
      settle: () => undefined
    })
  }

  private enqueue(dest: Destination, item: Inbound): void {
    const queued = this.inbox.get(dest.id) ?? []
    queued.push(item)
    this.inbox.set(dest.id, queued)
    void this.pump(dest)
  }

  private async pump(dest: Destination): Promise<void> {
    if (this.pumping.has(dest.id)) return
    this.pumping.add(dest.id)
    try {
      const queued = this.inbox.get(dest.id) ?? []
      while (queued.length) {
        const item = queued[0]
        const failed = await this.deliver(dest, item)
          .then(() => undefined)
          .catch(errorText)
        queued.shift()
        item.settle(failed)
      }
    } finally {
      this.pumping.delete(dest.id)
    }
  }

  private async deliver(dest: Destination, item: Inbound): Promise<void> {
    const tab = await this.readyTab(dest)
    const text = await item.text(tab)
    if (item.command) return dest.typeCommand(tab, text)
    if (this.d.backendOf(tab) === 'codex') {
      await this.d.queue(tab, text, item.clientId)
      return
    }
    await this.d.type(tab, [text, '\r'])
  }

  private async readyTab(dest: Destination): Promise<string> {
    const already = dest.liveTab()
    const tab = await dest.open()
    if (!(await this.d.ready(tab, () => this.typable(tab), CONDUCTOR_GETS_READY_WITHIN_MS)))
      throw new Error(
        this.d.alive(tab)
          ? `${dest.name} did not get ready in time.`
          : `${dest.name} closed before it was ready.`
      )
    if (tab !== already) await sleep(PROMPT_SETTLES_AFTER_BIND_MS)
    return tab
  }

  private typable(tab: string): boolean {
    const status = this.d.status(tab)
    return (
      !!this.d.boundKey(tab) &&
      status !== undefined &&
      status !== 'approval' &&
      !this.hookWaits(tab)
    )
  }

  takesCommand(tab: string): boolean {
    return (
      this.typable(tab) && this.d.turnOver(tab) && !this.dialogOpen(tab) && this.d.queueDrained(tab)
    )
  }

  dialogOpen(tab: string): boolean {
    return !!this.openAsk(tab) || !!this.d.codexApproval(tab) || !!this.d.codexQuestion(tab)
  }

  private hookWaits(tab: string): boolean {
    const hooks = this.askHooks.get(tab)
    if (!hooks) return false
    for (const hook of hooks)
      if (!fs.existsSync(this.hookFile(tab, hook, ASK_SUFFIX))) hooks.delete(hook)
    return hooks.size > 0
  }

  private async textOf(m: DiscordMessage, dest: Destination, tab: string): Promise<string> {
    const remote = this.d.remote(tab)
    const notes = await Promise.all(m.attachments.map((a) => this.fetchAttachment(m.id, a, remote)))
    return [dest.conductor ? '[Discord]' : '', m.content, ...notes].filter(Boolean).join(' ')
  }

  private async fetchAttachment(
    messageId: string,
    a: DiscordAttachment,
    remote: boolean
  ): Promise<string> {
    if (remote) return `(${a.filename} was not passed in: this session runs on another machine.)`
    if (a.size > BYTES_PER_FILE)
      return `(${a.filename} was not passed in: it is larger than 20 MB.)`
    const dir = path.join(this.d.attachmentsDir, messageId)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, safeDownloadName(a.filename))
    fs.writeFileSync(file, await this.d.download(a.url))
    return `(attached file: ${JSON.stringify(file)})`
  }

  turnEnded(tabId: string, turn: Turn): void {
    const channelId = this.d.conductorChannelOf(tabId)
    if (channelId && turn.reply.trim()) this.say(channelId, turn.reply)
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
    const card: Card = {
      accent: CONDUCTOR_ACCENT,
      header: CONDUCTOR_ASKS,
      body: shown,
      footer: `-# ${how}`
    }
    return view.choices.length ? this.d.withButtons(tab, view, card) : card
  }

  onAsk(tab: string, payload: AskPayload, hook?: string): void {
    const raw = JSON.stringify(payload)
    const before = this.asks.get(tab)
    if (before && before.hook === hook && before.raw === raw) return
    if (before?.hook && before.hook !== hook) this.release(tab, before.hook)
    this.asks.set(tab, { payload, hook, raw })
    if (hook) this.askHooks.set(tab, (this.askHooks.get(tab) ?? new Set()).add(hook))
    this.d.asksChanged(tab)
    const channelId = this.d.conductorChannelOf(tab)
    if (channelId) this.card(channelId, this.askCard(tab, claudeDialog(payload), askHow(payload)))
    else this.d.waiting(tab)
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

  async answerSession(tab: string, reply: string): Promise<string | undefined> {
    if (this.d.backendOf(tab) === 'codex') {
      if (this.d.codexApproval(tab)) {
        const key = codexKeyFor(reply)
        if (!key) return CODEX_TAKES_YES_OR_NO
        this.codexAsks.delete(tab)
        await this.d.type(tab, [key])
        return undefined
      }
      const question = this.d.codexQuestion(tab)
      if (!question) return this.d.awaitsInput(tab) ? CODEX_INPUT_NOT_PROBED : SHOWS_NO_DIALOG
      const key = codexOptionKey(question, reply)
      if (!key) return CODEX_TAKES_AN_OPTION
      this.codexAsks.delete(tab)
      await this.d.type(tab, [key])
      return undefined
    }
    const ask = this.openAsk(tab)
    if (!ask) return SHOWS_NO_DIALOG
    if (ask.hook) {
      this.answer(tab, hookAnswer(ask.payload, reply))
      return undefined
    }
    if (this.turnOver(tab)) return SHOWS_NO_DIALOG
    const keys = claudeKeysFor(ask.payload, reply)
    if (!keys.ok) return keys.error
    this.asks.delete(tab)
    await this.d.type(tab, keys.value)
    return undefined
  }

  private turnOver(tab: string): boolean {
    const status = this.d.status(tab)
    return status === 'idle' || (status === 'waiting' && !this.d.awaitsInput(tab))
  }

  codexAsked(tab: string, a: CodexApproval | CodexQuestion): void {
    const channelId = this.d.conductorChannelOf(tab)
    if (!channelId || this.codexAsks.get(tab) === a.id) return
    this.codexAsks.set(tab, a.id)
    const view = codexDialog(a)
    const question = 'options' in a
    const how = question ? PICK_ONE_OPTION : CODEX_NEEDS_YES_OR_NO
    const shown = question ? view.text : `Codex asks to run: ${view.text || 'a command'}`
    this.card(channelId, this.askCard(tab, view, how, shown))
  }

  private answerDialog(tab: string, m: DiscordMessage): boolean {
    const ask = this.openAsk(tab)
    if (ask) {
      this.answer(tab, hookAnswer(ask.payload, m.content))
      return true
    }
    this.asks.delete(tab)
    const asked = this.codexAsks.get(tab)
    if (asked === undefined) return false
    const open = this.d.codexApproval(tab) ?? this.d.codexQuestion(tab)
    if (!open || open.id !== asked) {
      this.codexAsks.delete(tab)
      return false
    }
    const question = 'options' in open
    const key = question ? codexOptionKey(open, m.content) : codexKeyFor(m.content)
    if (!key) {
      this.say(m.channelId, question ? PICK_ONE_OPTION : CODEX_NEEDS_YES_OR_NO, m.id)
      return true
    }
    this.codexAsks.delete(tab)
    void this.d.type(tab, [key])
    return true
  }

  forget(tab: string): void {
    this.answer(tab, {})
    this.codexAsks.delete(tab)
    this.askHooks.delete(tab)
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
