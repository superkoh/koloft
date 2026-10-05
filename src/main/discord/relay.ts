import fs from 'fs'
import path from 'path'
import type { BackendId, SessionStatus } from '@shared/types'
import type { Turn } from '@shared/turns'
import { newerSnowflake } from '@shared/conductors'
import { safeDownloadName } from '@shared/downloadName'
import { watchJsonDrops, writeWholeBeforeVisible } from '../jsonDrops'
import { errorText } from '../agentRequests'
import { sleep } from '../codexTransport'
import { typeKeys } from '../ptyManager'
import type { Conductors } from './conductors'
import {
  BYTES_PER_FILE,
  type DiscordAttachment,
  type DiscordFile,
  type DiscordLink,
  type DiscordMessage
} from './link'
import { splitForDiscord } from './split'
import type { AskPayload } from '@shared/sessionEvent'
import type { ToolCall } from '../sessionTracker'
import {
  askText,
  claudeKeysFor,
  codexApprovalText,
  codexKeyFor,
  codexOptionKey,
  codexQuestionText,
  dialogText,
  hookAnswer,
  isAskedCall,
  PICK_ONE_OPTION,
  type CodexApproval,
  type CodexQuestion
} from './dialog'

export const OFFLINE_REPLY = 'Koloft was offline, this message was not delivered.'
export const CODEX_NEEDS_YES_OR_NO = 'Reply yes or no.'
export const SHOWS_NO_DIALOG = 'it shows no question or approval right now.'
export const CODEX_INPUT_NOT_PROBED =
  'Codex is asking something Koloft cannot answer from here: it answers a yes-or-no approval, or one question that picks one option from a list. Answer this one at the Mac.'
const CODEX_TAKES_YES_OR_NO = 'a Codex approval takes yes or no.'
const CODEX_TAKES_AN_OPTION = 'this Codex question takes the number or the name of one option.'
const ASK_SUFFIX = '.ask.json'
const ANSWER_SUFFIX = '.answer.json'
const QUEUED = '⏳'
const DELIVERED = '✅'
const PAGE = 100
const PROMPT_SETTLES_AFTER_BIND_MS = 1000
const CONDUCTOR_GETS_READY_WITHIN_MS = 10 * 60_000

export interface RelayDeps {
  link: Pick<DiscordLink, 'post' | 'upload' | 'react' | 'messages'>
  download(url: string): Promise<Buffer>
  conductors: Pick<
    Conductors,
    | 'owner'
    | 'bindings'
    | 'bindingOfChannel'
    | 'bindingOfTab'
    | 'liveTab'
    | 'open'
    | 'setLastMessage'
  >
  backendOf(tabId: string): BackendId | undefined
  boundKey(tabId: string): string | undefined
  status(tabId: string): SessionStatus | undefined
  awaitsInput(tabId: string): boolean
  waiting(tabId: string): void
  alive(tabId: string): boolean
  ready(tabId: string, ready: () => boolean, ms: number): Promise<boolean>
  asksChanged(tabId: string): void
  write(tabId: string, data: string): void
  queue(tabId: string, text: string, clientId: string): Promise<void>
  codexApproval(tabId: string): CodexApproval | undefined
  codexQuestion(tabId: string): CodexQuestion | undefined
  regDir: string
  attachmentsDir: string
}

interface Inbound {
  clientId: string
  text(): Promise<string>
  settle(failed?: string): void
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
    for (const part of splitForDiscord(text))
      void this.d.link.post(channelId, part, replyTo).catch(() => undefined)
  }

  async send(channelId: string, files: DiscordFile[], text: string): Promise<void> {
    const [first = '', ...more] = splitForDiscord(text)
    await (files.length
      ? this.d.link.upload(channelId, files, first)
      : this.d.link.post(channelId, first))
    for (const part of more) await this.d.link.post(channelId, part)
  }

  private react(m: DiscordMessage, emoji: string, on: boolean): void {
    void this.d.link.react(m.channelId, m.id, emoji, on).catch(() => undefined)
  }

  onMessage(m: DiscordMessage): void {
    if (m.authorId !== this.d.conductors.owner()) return
    const b = this.d.conductors.bindingOfChannel(m.channelId)
    if (!b) return
    this.seenLive.add(m.id)
    const tab = this.d.conductors.liveTab(b.id)
    if (tab && this.answerDialog(tab, m)) {
      this.react(m, DELIVERED, true)
      this.d.conductors.setLastMessage(b.id, m.id)
      return
    }
    const waits = !tab || this.pumping.has(b.id) || !this.typable(tab)
    if (waits) this.react(m, QUEUED, true)
    this.enqueue(b.id, {
      clientId: `koloft-discord-${m.id}`,
      text: () => this.textOf(m),
      settle: (failed) => {
        if (waits) this.react(m, QUEUED, false)
        if (failed) this.say(m.channelId, `${failed} This message was not delivered.`, m.id)
        else this.react(m, DELIVERED, true)
        this.d.conductors.setLastMessage(b.id, m.id)
      }
    })
  }

  tell(bindingId: string, text: string): void {
    this.enqueue(bindingId, {
      clientId: `koloft-notice-${++this.told}`,
      text: async () => text,
      settle: () => undefined
    })
  }

  private enqueue(bindingId: string, item: Inbound): void {
    const queued = this.inbox.get(bindingId) ?? []
    queued.push(item)
    this.inbox.set(bindingId, queued)
    void this.pump(bindingId)
  }

  private async pump(bindingId: string): Promise<void> {
    if (this.pumping.has(bindingId)) return
    this.pumping.add(bindingId)
    try {
      const queued = this.inbox.get(bindingId) ?? []
      while (queued.length) {
        const item = queued[0]
        const failed = await this.deliver(bindingId, item)
          .then(() => undefined)
          .catch(errorText)
        queued.shift()
        item.settle(failed)
      }
    } finally {
      this.pumping.delete(bindingId)
    }
  }

  private async deliver(bindingId: string, item: Inbound): Promise<void> {
    const text = await item.text()
    const tab = await this.readyTab(bindingId)
    if (this.d.backendOf(tab) === 'codex') {
      await this.d.queue(tab, text, item.clientId)
      return
    }
    await typeKeys((data) => this.d.write(tab, data), [text, '\r'])
  }

  private async readyTab(bindingId: string): Promise<string> {
    const already = this.d.conductors.liveTab(bindingId)
    const opened = await this.d.conductors.open(bindingId)
    if (!opened.ok) throw new Error(opened.error)
    const tab = opened.tabId
    if (!(await this.d.ready(tab, () => this.typable(tab), CONDUCTOR_GETS_READY_WITHIN_MS)))
      throw new Error(
        this.d.alive(tab)
          ? 'The conductor did not get ready in time.'
          : 'The conductor closed before it was ready.'
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

  private hookWaits(tab: string): boolean {
    const hooks = this.askHooks.get(tab)
    if (!hooks) return false
    for (const hook of hooks)
      if (!fs.existsSync(this.hookFile(tab, hook, ASK_SUFFIX))) hooks.delete(hook)
    return hooks.size > 0
  }

  private async textOf(m: DiscordMessage): Promise<string> {
    const notes = await Promise.all(m.attachments.map((a) => this.fetchAttachment(m.id, a)))
    return ['[Discord]', m.content, ...notes].filter(Boolean).join(' ')
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
    const b = this.d.conductors.bindingOfTab(tabId)
    if (b && turn.reply.trim()) this.say(b.channel.channelId, turn.reply)
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

  onAsk(tab: string, payload: AskPayload, hook?: string): void {
    const raw = JSON.stringify(payload)
    const before = this.asks.get(tab)
    if (before && before.hook === hook && before.raw === raw) return
    if (before?.hook && before.hook !== hook) this.release(tab, before.hook)
    this.asks.set(tab, { payload, hook, raw })
    if (hook) this.askHooks.set(tab, (this.askHooks.get(tab) ?? new Set()).add(hook))
    this.d.asksChanged(tab)
    const b = this.d.conductors.bindingOfTab(tab)
    if (b) this.say(b.channel.channelId, askText(payload))
    else this.d.waiting(tab)
  }

  dialogDetail(tab: string): string | undefined {
    const ask = this.openAsk(tab)
    return ask && dialogText(ask.payload)
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
        this.d.write(tab, key)
        return undefined
      }
      const question = this.d.codexQuestion(tab)
      if (!question) return this.d.awaitsInput(tab) ? CODEX_INPUT_NOT_PROBED : SHOWS_NO_DIALOG
      const key = codexOptionKey(question, reply)
      if (!key) return CODEX_TAKES_AN_OPTION
      this.d.write(tab, key)
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
    await typeKeys((data) => this.d.write(tab, data), keys.value)
    return undefined
  }

  private turnOver(tab: string): boolean {
    const status = this.d.status(tab)
    return status === 'idle' || (status === 'waiting' && !this.d.awaitsInput(tab))
  }

  codexAsked(tab: string, a: CodexApproval | CodexQuestion): void {
    const b = this.d.conductors.bindingOfTab(tab)
    if (!b || this.codexAsks.get(tab) === a.id) return
    this.codexAsks.set(tab, a.id)
    this.say(b.channel.channelId, 'options' in a ? codexQuestionText(a) : codexApprovalText(a))
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
    this.d.write(tab, key)
    return true
  }

  forget(tab: string): void {
    this.answer(tab, {})
    this.codexAsks.delete(tab)
    this.askHooks.delete(tab)
  }

  async catchUp(): Promise<void> {
    const owner = this.d.conductors.owner()
    for (const b of this.d.conductors.bindings()) {
      const channelId = b.channel.channelId
      try {
        if (!b.lastMessageId) {
          const [latest] = await this.d.link.messages(channelId, undefined, 1)
          if (latest) this.d.conductors.setLastMessage(b.id, latest.id)
          continue
        }
        let after = b.lastMessageId
        for (;;) {
          const page = await this.d.link.messages(channelId, after, PAGE)
          for (const m of page.sort((x, y) => (newerSnowflake(x.id, y.id) ? 1 : -1))) {
            if (!m.bot && m.authorId === owner && !this.seenLive.has(m.id))
              this.say(channelId, OFFLINE_REPLY, m.id)
            after = m.id
          }
          if (page.length < PAGE) break
        }
        this.d.conductors.setLastMessage(b.id, after)
      } catch {}
    }
  }
}
