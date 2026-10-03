import type { BackendId, ConductorBinding, SessionStatus } from '@shared/types'
import { GLOBAL_SCOPE, scopeName } from '@shared/conductors'
import { BACKEND_LABEL } from '@shared/sessionBackend'

export type NoticeKind = 'finished' | 'waiting' | 'closed'

export interface NoticeSubject {
  key: string
  name: string
  workspace?: string
}

export const NOTICE_COALESCE_MS = 1000

export function noticeKindOf(
  prev: SessionStatus | undefined,
  next: SessionStatus
): NoticeKind | undefined {
  if (next === 'approval') return 'waiting'
  if (next === 'waiting' && (prev === 'working' || prev === 'approval')) return 'finished'
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

export class Notices {
  private pending = new Map<string, string[]>()

  constructor(
    private d: {
      bindings(): ConductorBinding[]
      post(channelId: string, text: string): void
    }
  ) {}

  notify(subject: NoticeSubject, kind: NoticeKind, detail?: string): void {
    const channelId = noticeChannel(this.d.bindings(), subject, kind)
    if (channelId) this.queue(channelId, noticeText(kind, subject.name, detail))
  }

  started(channelId: string, name: string, workspace: string, backend: BackendId): void {
    this.queue(channelId, `▶ Started ${name} (${scopeName(workspace)}, ${BACKEND_LABEL[backend]})`)
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
