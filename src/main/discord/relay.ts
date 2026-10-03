import fs from 'fs'
import path from 'path'
import type { BackendId, SessionStatus } from '@shared/types'
import type { TurnEnded } from '@shared/turns'
import { watchJsonDrops, writeWholeBeforeVisible } from '../jsonDrops'
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
  dialogText,
  hookAnswer,
  isAskedCall,
  type CodexApproval
} from './dialog'

export const OFFLINE_REPLY = 'Koloft was offline, this message was not delivered.'
export const CODEX_NEEDS_YES_OR_NO = 'Reply yes or no.'
export const SHOWS_NO_DIALOG = 'it shows no question or approval right now.'
export const CODEX_INPUT_NOT_PROBED =
  'Codex is asking for an answer that is not a yes-or-no approval. Koloft does not know yet how to answer that kind (not probed), so answer it at the Mac.'
const CODEX_TAKES_YES_OR_NO = 'a Codex approval takes yes or no.'
const ASK_SUFFIX = '.ask.json'
const ANSWER_SUFFIX = '.answer.json'
const QUEUED = '⏳'
const DELIVERED = '✅'
const PAGE = 100
// CC§12
export const SUBMIT_AFTER_TEXT_MS = 300
const READY_POLL_MS = 250
const PROMPT_SETTLES_AFTER_BIND_MS = 1000
const ATTACHMENTS_KEPT_MS = 7 * 24 * 60 * 60 * 1000

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
  write(tabId: string, data: string): void
  queue(tabId: string, text: string, clientId: string): Promise<void>
  codexApproval(tabId: string): CodexApproval | undefined
  regDir: string
  attachmentsDir: string
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function newer(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  private approvals = new Map<string, string | number>()

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
    if (m.bot || m.authorId !== this.d.conductors.owner()) return
    const b = this.d.conductors.bindingOfChannel(m.channelId)
    if (!b) return
    this.seenLive.add(m.id)
    const tab = this.d.conductors.liveTab(b.id)
    if (tab && this.answerDialog(tab, m)) {
      this.react(m, DELIVERED, true)
      this.d.conductors.setLastMessage(b.id, m.id)
      return
    }
    this.react(m, QUEUED, true)
    this.enqueue(b.id, {
      clientId: `koloft-discord-${m.id}`,
      text: () => this.textOf(m),
      settle: (failed) => {
        this.react(m, QUEUED, false)
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
    this.d.write(tab, text)
    await wait(SUBMIT_AFTER_TEXT_MS)
    this.d.write(tab, '\r')
  }

  private async readyTab(bindingId: string): Promise<string> {
    const already = this.d.conductors.liveTab(bindingId)
    const opened = await this.d.conductors.open(bindingId)
    if (!opened.ok) throw new Error(opened.error)
    const tab = opened.tabId
    while (!this.canType(tab)) {
      if (!this.d.alive(tab)) throw new Error('The conductor closed before it was ready.')
      await wait(READY_POLL_MS)
    }
    if (tab !== already) await wait(PROMPT_SETTLES_AFTER_BIND_MS)
    return tab
  }

  private canType(tab: string): boolean {
    const status = this.d.status(tab)
    return (
      !!this.d.boundKey(tab) && status !== undefined && status !== 'approval' && !this.askOpen(tab)
    )
  }

  private async textOf(m: DiscordMessage): Promise<string> {
    const notes = await Promise.all(m.attachments.map((a) => this.fetchAttachment(m.id, a)))
    return ['[Discord]', m.content, ...notes].filter(Boolean).join(' ')
  }

  private async fetchAttachment(messageId: string, a: DiscordAttachment): Promise<string> {
    if (a.size > BYTES_PER_FILE)
      return `(${a.filename} was not passed in: it is larger than 20 MB.)`
    this.pruneAttachments()
    const dir = path.join(this.d.attachmentsDir, messageId)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, path.basename(a.filename) || 'file')
    fs.writeFileSync(file, await this.d.download(a.url))
    return `(attached file: ${JSON.stringify(file)})`
  }

  private pruneAttachments(): void {
    let names: string[]
    try {
      names = fs.readdirSync(this.d.attachmentsDir)
    } catch {
      return
    }
    for (const name of names) {
      const dir = path.join(this.d.attachmentsDir, name)
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > ATTACHMENTS_KEPT_MS)
          fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  }

  turnEnded(turn: TurnEnded): void {
    const b = this.d.conductors.bindingOfTab(turn.tabId)
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

  private askOpen(tab: string): boolean {
    try {
      return fs
        .readdirSync(this.d.regDir)
        .some((name) => name.startsWith(`${tab}.`) && name.endsWith(ASK_SUFFIX))
    } catch {
      return false
    }
  }

  // CC§14
  watchAsks(): fs.FSWatcher | null {
    return watchJsonDrops(this.d.regDir, (name) => {
      if (!name.endsWith(ASK_SUFFIX)) return null
      const [tab, hook] = name.slice(0, -ASK_SUFFIX.length).split('.')
      return hook ? (obj): void => this.onAsk(tab, obj as AskPayload, hook) : null
    })
  }

  remoteAsked(tab: string, payload: AskPayload): void {
    this.onAsk(tab, payload)
  }

  private onAsk(tab: string, payload: AskPayload, hook?: string): void {
    const raw = JSON.stringify(payload)
    const before = this.asks.get(tab)
    if (before && before.hook === hook && before.raw === raw) return
    if (before?.hook && before.hook !== hook) this.release(tab, before.hook)
    this.asks.set(tab, { payload, hook, raw })
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
      if (!this.d.codexApproval(tab))
        return this.d.awaitsInput(tab) ? CODEX_INPUT_NOT_PROBED : SHOWS_NO_DIALOG
      const key = codexKeyFor(reply)
      if (!key) return CODEX_TAKES_YES_OR_NO
      this.d.write(tab, key)
      return undefined
    }
    const ask = this.openAsk(tab)
    if (!ask) return SHOWS_NO_DIALOG
    if (ask.hook) {
      this.answer(tab, hookAnswer(ask.payload, reply))
      return undefined
    }
    if (this.d.status(tab) !== 'approval' && !this.d.awaitsInput(tab)) return SHOWS_NO_DIALOG
    const keys = claudeKeysFor(ask.payload, reply)
    if (!keys.ok) return keys.error
    this.asks.delete(tab)
    for (const [i, key] of keys.value.entries()) {
      if (i > 0) await wait(SUBMIT_AFTER_TEXT_MS)
      this.d.write(tab, key)
    }
    return undefined
  }

  conductorWaiting(tab: string): void {
    const b = this.d.conductors.bindingOfTab(tab)
    if (!b || this.d.backendOf(tab) !== 'codex' || this.d.status(tab) !== 'approval') return
    const a = this.d.codexApproval(tab)
    if (!a) {
      setTimeout(() => this.conductorWaiting(tab), READY_POLL_MS)
      return
    }
    if (this.approvals.get(tab) === a.id) return
    this.approvals.set(tab, a.id)
    this.say(b.channel.channelId, codexApprovalText(a))
  }

  private answerDialog(tab: string, m: DiscordMessage): boolean {
    const ask = this.openAsk(tab)
    if (ask) {
      this.answer(tab, hookAnswer(ask.payload, m.content))
      return true
    }
    this.asks.delete(tab)
    const asked = this.approvals.get(tab)
    if (asked === undefined) return false
    if (this.d.codexApproval(tab)?.id !== asked) {
      this.approvals.delete(tab)
      return false
    }
    const key = codexKeyFor(m.content)
    if (!key) {
      this.say(m.channelId, CODEX_NEEDS_YES_OR_NO, m.id)
      return true
    }
    this.approvals.delete(tab)
    this.d.write(tab, key)
    return true
  }

  forget(tab: string): void {
    this.answer(tab, {})
    this.approvals.delete(tab)
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
          for (const m of page.sort((x, y) => (newer(x.id, y.id) ? 1 : -1))) {
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
