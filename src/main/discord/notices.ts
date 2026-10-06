import type { BackendId, ConductorBinding, SessionStatus } from '@shared/types'
import { GLOBAL_SCOPE, scopeName } from '@shared/conductors'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import { edgeAttention } from '../attention'

export type NoticeKind = 'finished' | 'waiting' | 'closed'

export interface NoticeSubject {
  key: string
  name: string
  workspace?: string
  conductor?: string
}

export const NOTICE_COALESCE_MS = 1000

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

export function noticeChannel(
  bindings: ConductorBinding[],
  subject: NoticeSubject,
  kind: NoticeKind
): string | undefined {
  const covering = bindings.filter(
    (b) =>
      (b.scope === GLOBAL_SCOPE || b.scope === subject.workspace) &&
      (kind !== 'finished' || b.touched.includes(subject.key))
  )
  return (covering.find((b) => b.scope !== GLOBAL_SCOPE) ?? covering[0])?.channel.channelId
}

export function noticeText(kind: NoticeKind, name: string, detail?: string): string {
  if (kind === 'finished') return `🔔 ${name} finished.`
  if (kind === 'closed') return `⏹ ${name} closed.`
  return detail ? `❓ ${name} is waiting for you: ${detail}` : `❓ ${name} is waiting for you.`
}

export interface NoticeDeps {
  bindings(): ConductorBinding[]
  post(channelId: string, text: string): void
  subject(tabId: string): NoticeSubject | undefined
  peerName(tabId: string): Promise<string | null>
  awaitsInput(tabId: string): boolean
  commandRunning(tabId: string): boolean
  detail(tabId: string): Promise<string | undefined>
}

export class Notices {
  private pending = new Map<string, string[]>()
  private closeNoticed = new Set<string>()
  private waitingNoticed = new Map<string, string>()
  private names = new Map<string, string>()
  private lastSubjects = new Map<string, NoticeSubject>()

  constructor(private d: NoticeDeps) {}

  onStatus(tabId: string, prev: SessionStatus | undefined, next: SessionStatus): void {
    this.liveSubject(tabId)
    if (next === 'working') this.waitingNoticed.delete(tabId)
    const kind = noticeKindOf(prev, next, this.d.awaitsInput(tabId))
    if (kind) void this.notice(tabId, kind)
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
  }

  started(channelId: string, name: string, workspace: string, backend: BackendId): void {
    this.queue(channelId, `▶ Started ${name} (${scopeName(workspace)}, ${BACKEND_LABEL[backend]})`)
  }

  private async notice(tabId: string, kind: NoticeKind): Promise<void> {
    const subject =
      this.liveSubject(tabId) ?? (kind === 'closed' ? this.lastSubjects.get(tabId) : undefined)
    if (!subject || subject.conductor) return
    if (kind === 'finished' && this.d.commandRunning(tabId)) return
    let detail: string | undefined
    if (kind === 'closed') {
      if (this.closeNoticed.has(tabId)) return
      this.closeNoticed.add(tabId)
    } else if (kind === 'waiting') {
      detail = await this.d.detail(tabId)
      if (this.waitingNoticed.get(tabId) === (detail ?? '')) return
      this.waitingNoticed.set(tabId, detail ?? '')
    }
    const channelId = noticeChannel(this.d.bindings(), subject, kind)
    if (!channelId) return
    const name = await this.nameOf(tabId, kind, subject.name)
    this.queue(channelId, noticeText(kind, name, detail))
  }

  private liveSubject(tabId: string): NoticeSubject | undefined {
    const live = this.d.subject(tabId)
    if (live) this.lastSubjects.set(tabId, live)
    return live
  }

  private async nameOf(tabId: string, kind: NoticeKind, title: string): Promise<string> {
    if (kind === 'closed') return this.names.get(tabId) ?? title
    const name = await this.d.peerName(tabId)
    if (name) this.names.set(tabId, name)
    return name ?? title
  }

  private queue(channelId: string, line: string): void {
    const lines = this.pending.get(channelId)
    if (lines) {
      lines.push(line)
      return
    }
    this.pending.set(channelId, [line])
    setTimeout(() => {
      const all = this.pending.get(channelId) ?? []
      this.pending.delete(channelId)
      this.d.post(channelId, all.join('\n'))
    }, NOTICE_COALESCE_MS)
  }
}
