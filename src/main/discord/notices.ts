import type { BackendId, ConductorBinding, SessionStatus } from '@shared/types'
import { GLOBAL_SCOPE } from '@shared/conductors'
import { edgeAttention } from '../attention'
import { accentOf, type Card } from './cards'
import type { DialogView } from './dialog'

export type NoticeKind = 'finished' | 'waiting' | 'closed'

export interface NoticeSubject {
  tabId: string
  key: string
  name: string
  backend: BackendId
  workspace?: string
  conductor?: string
}

export const REPLY_FOLLOWS_THE_TURN_MS = 7000
export const ANSWER_IN_THE_THREAD = '-# Answer with a button, or write the answer here.'

export function noticeKindOf(
  prev: SessionStatus | undefined,
  next: SessionStatus,
  awaitsInput: boolean
): NoticeKind | undefined {
  const edge = edgeAttention(prev, next)
  if (edge === 'approval') return 'waiting'
  if (edge === 'turn-done') return awaitsInput ? 'waiting' : 'finished'
  return undefined
}

export function noticeBinding(
  bindings: ConductorBinding[],
  subject: Pick<NoticeSubject, 'key' | 'workspace'>,
  kind: NoticeKind,
  threaded = false
): ConductorBinding | undefined {
  const covering = bindings.filter(
    (b) =>
      (b.scope === GLOBAL_SCOPE || b.scope === subject.workspace) &&
      (kind !== 'finished' || threaded || b.touched.includes(subject.key))
  )
  return covering.find((b) => b.scope !== GLOBAL_SCOPE) ?? covering[0]
}

export function noticeCard(kind: NoticeKind, name: string, body?: string): Card {
  const accent = accentOf(name)
  if (kind === 'finished') return { accent, header: `🔔 **${name}** finished.`, body }
  if (kind === 'closed') return { accent, header: `⏹ **${name}** closed.`, silent: true }
  return { accent, header: `❓ **${name}** is waiting for you.`, body }
}

export interface NoticeDeps {
  bindings(): ConductorBinding[]
  place(b: ConductorBinding, subject: NoticeSubject): Promise<string>
  threadOf(key: string): string | undefined
  card(channelId: string, card: Card): Promise<void>
  archive(threadId: string): void
  withButtons(tabId: string, view: DialogView, card: Card): Card
  subject(tabId: string): NoticeSubject | undefined
  shownName(tabId: string): Promise<string | null>
  awaitsInput(tabId: string): boolean
  commandRunning(tabId: string): boolean
  dialog(tabId: string): Promise<DialogView | undefined>
}

export class Notices {
  private closeNoticed = new Set<string>()
  private waitingNoticed = new Map<string, string>()
  private names = new Map<string, string>()
  private lastSubjects = new Map<string, NoticeSubject>()
  private replyWaiters = new Map<string, (reply: string | undefined) => void>()

  constructor(private d: NoticeDeps) {}

  onStatus(tabId: string, prev: SessionStatus | undefined, next: SessionStatus): void {
    this.liveSubject(tabId)
    if (next === 'working') this.waitingNoticed.delete(tabId)
    const kind = noticeKindOf(prev, next, this.d.awaitsInput(tabId))
    if (kind) void this.notice(tabId, kind)
  }

  turnEnded(tabId: string, reply: string): void {
    const waiter = this.replyWaiters.get(tabId)
    this.replyWaiters.delete(tabId)
    waiter?.(reply)
  }

  waiting(tabId: string): void {
    void this.notice(tabId, 'waiting')
  }

  closed(tabId: string): void {
    void this.notice(tabId, 'closed')
  }

  forget(tabId: string): void {
    this.closeNoticed.delete(tabId)
    this.waitingNoticed.delete(tabId)
    this.names.delete(tabId)
    this.lastSubjects.delete(tabId)
    this.replyWaiters.get(tabId)?.(undefined)
    this.replyWaiters.delete(tabId)
  }

  private replyOf(tabId: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.replyWaiters.delete(tabId)
        resolve(undefined)
      }, REPLY_FOLLOWS_THE_TURN_MS)
      this.replyWaiters.set(tabId, (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
    })
  }

  private async notice(tabId: string, kind: NoticeKind): Promise<void> {
    const subject =
      this.liveSubject(tabId) ?? (kind === 'closed' ? this.lastSubjects.get(tabId) : undefined)
    if (!subject || subject.conductor) return
    if (kind === 'closed') return this.closedNotice(tabId, subject)
    if (kind === 'finished' && this.d.commandRunning(tabId)) return
    const b = noticeBinding(this.d.bindings(), subject, kind, !!this.d.threadOf(subject.key))
    if (!b) return
    let body: string | undefined
    let dialog: DialogView | undefined
    if (kind === 'waiting') {
      dialog = await this.d.dialog(tabId)
      if (this.waitingNoticed.get(tabId) === (dialog?.text ?? '')) return
      this.waitingNoticed.set(tabId, dialog?.text ?? '')
      body = dialog?.text
    } else if (kind === 'finished') body = await this.replyOf(tabId)
    const name = await this.nameOf(tabId, subject.name)
    const channelId = await this.d.place(b, { ...subject, name })
    const inThread = channelId !== b.channel.channelId
    let card = noticeCard(kind, name, body)
    if (kind === 'waiting' && inThread) card = { ...card, footer: ANSWER_IN_THE_THREAD }
    if (dialog?.choices.length) card = this.d.withButtons(tabId, dialog, card)
    void this.d.card(channelId, card)
  }

  // PLATFORM§39
  private async closedNotice(tabId: string, subject: NoticeSubject): Promise<void> {
    if (this.closeNoticed.has(tabId)) return
    this.closeNoticed.add(tabId)
    const threadId = this.d.threadOf(subject.key)
    if (!threadId) return
    await this.d.card(threadId, noticeCard('closed', this.names.get(tabId) ?? subject.name))
    this.d.archive(threadId)
  }

  private liveSubject(tabId: string): NoticeSubject | undefined {
    const live = this.d.subject(tabId)
    if (live) this.lastSubjects.set(tabId, live)
    return live
  }

  private async nameOf(tabId: string, title: string): Promise<string> {
    const name = await this.d.shownName(tabId)
    if (name) this.names.set(tabId, name)
    return name ?? title
  }
}
