import type { SessionStatus } from '@shared/types'
import type { Card } from './cards'
import type { DiscordLink } from './link'
import { whereOf, type ThreadSubject } from './threads'

export type LiveState =
  'working' | 'still-running' | 'needs-you' | 'turn-done' | 'idle' | 'closed' | 'unknown'

const TURN_OVER: ReadonlySet<LiveState> = new Set(['still-running', 'turn-done', 'idle'])
const TYPES_WHILE: ReadonlySet<LiveState> = new Set(['working', 'still-running'])

export type StatusSubject = Pick<ThreadSubject, 'name' | 'backend' | 'workspace'>

export interface LiveStatusDeps {
  link: Pick<DiscordLink, 'editCard' | 'typing'>
  openerOf(tabId: string): { channelId: string; threadId: string } | undefined
  conductorChannelOf(tabId: string): string | undefined
  subject(tabId: string): Promise<StatusSubject | undefined>
  status(tabId: string): SessionStatus | undefined
  awaitsInput(tabId: string): boolean
  turnOver(tabId: string): boolean
  unknown(tabId: string): boolean
  alive(tabId: string): boolean
}

// PLATFORM§39
export const TYPING_RENEWED_EVERY_MS = 8000

const LOOK: Record<LiveState, { emoji: string; words: string; accent: number; after?: string }> = {
  working: { emoji: '🔄', words: 'working, started', accent: 0xec9670 },
  'still-running': {
    emoji: '✅',
    words: 'turn done',
    accent: 0x8fc69a,
    after: ' · work still running'
  },
  'needs-you': { emoji: '❓', words: 'needs you, asked', accent: 0xf0a830 },
  'turn-done': { emoji: '✅', words: 'turn done', accent: 0x8fc69a },
  idle: { emoji: '💤', words: 'idle, done', accent: 0x5d7a63 },
  closed: { emoji: '⏹', words: 'closed', accent: 0x747f8d },
  unknown: { emoji: '⚪', words: 'status unknown', accent: 0x747f8d }
}

export function liveStateOf(
  status: SessionStatus | undefined,
  awaitsInput: boolean,
  turnOver: boolean,
  unknown: boolean
): LiveState | undefined {
  if (unknown) return 'unknown'
  if (status === 'approval' || ((status === 'waiting' || status === 'idle') && awaitsInput))
    return 'needs-you'
  if (status === 'waiting') return 'turn-done'
  if (status === 'working' && turnOver) return 'still-running'
  return status
}

export function statusCard(s: StatusSubject, state: LiveState, since: number): Card {
  const look = LOOK[state]
  const when = state === 'unknown' ? '' : ` <t:${Math.floor(since / 1000)}:R>`
  return {
    accent: look.accent,
    header: `${look.emoji} **${s.name}** · ${look.words}${when}${look.after ?? ''}`,
    body: whereOf(s),
    silent: true
  }
}

interface TabEntry {
  state?: LiveState
  since: number
  subject?: StatusSubject
  look?: string
  renamed?: boolean
}

interface Wanted {
  channelId: string
  card: Card
  body: string
}

export class LiveStatus {
  private tabs = new Map<string, TabEntry>()
  private typers = new Map<string, { channelId: string; timer: ReturnType<typeof setInterval> }>()
  private wanted = new Map<string, Wanted>()
  private shown = new Map<string, string>()

  constructor(private d: LiveStatusDeps) {}

  async refresh(tabId: string): Promise<void> {
    if (!this.d.alive(tabId)) return
    const opener = this.d.openerOf(tabId)
    if (!opener && !this.d.conductorChannelOf(tabId) && !this.tabs.has(tabId)) return
    const entry = this.entryOf(tabId)
    if (opener && (!entry.subject || entry.renamed)) {
      entry.renamed = false
      const subject = await this.d.subject(tabId)
      if (this.tabs.get(tabId) !== entry) return
      if (subject) entry.subject = subject
    }
    if (entry.state === 'closed') return
    const state = liveStateOf(
      this.d.status(tabId),
      this.d.awaitsInput(tabId),
      this.d.turnOver(tabId),
      this.d.unknown(tabId)
    )
    if (state) this.enter(entry, state)
    this.typeWhile(tabId, !!state && TYPES_WHILE.has(state))
    this.show(tabId, entry)
  }

  sessionChanged(tabId: string, title: string | undefined, unknown: boolean): void {
    const entry = this.tabs.get(tabId)
    const look = `${title}\n${unknown}`
    if (!entry || entry.look === look) return
    entry.look = look
    entry.renamed = true
    void this.refresh(tabId)
  }

  closed(tabId: string): void {
    const entry = this.entryOf(tabId)
    this.typeWhile(tabId, false)
    this.enter(entry, 'closed')
    this.show(tabId, entry)
  }

  forget(tabId: string): void {
    this.tabs.delete(tabId)
    this.typeWhile(tabId, false)
  }

  private entryOf(tabId: string): TabEntry {
    let entry = this.tabs.get(tabId)
    if (!entry) {
      entry = { since: Date.now() }
      this.tabs.set(tabId, entry)
    }
    return entry
  }

  private enter(entry: TabEntry, state: LiveState): void {
    if (entry.state === state) return
    const sameTurnEnd = !!entry.state && TURN_OVER.has(entry.state) && TURN_OVER.has(state)
    if (!sameTurnEnd) entry.since = Date.now()
    entry.state = state
  }

  private show(tabId: string, entry: TabEntry): void {
    const at = this.d.openerOf(tabId)
    if (!at || !entry.subject || !entry.state) return
    const card = statusCard(entry.subject, entry.state, entry.since)
    const idle = !this.wanted.has(at.threadId)
    this.wanted.set(at.threadId, { channelId: at.channelId, card, body: JSON.stringify(card) })
    if (idle) void this.edit(at.threadId)
  }

  private async edit(messageId: string): Promise<void> {
    for (;;) {
      const w = this.wanted.get(messageId)!
      if (this.shown.get(messageId) !== w.body) {
        const done = await this.d.link.editCard(w.channelId, messageId, w.card).then(
          () => true,
          () => false
        )
        if (done) this.shown.set(messageId, w.body)
      }
      if (this.wanted.get(messageId) === w) break
    }
    this.wanted.delete(messageId)
  }

  private typeWhile(tabId: string, working: boolean): void {
    const channelId = working
      ? (this.d.openerOf(tabId)?.threadId ?? this.d.conductorChannelOf(tabId))
      : undefined
    const was = this.typers.get(tabId)
    if (was?.channelId === channelId) return
    if (was) clearInterval(was.timer)
    this.typers.delete(tabId)
    if (!channelId) return
    const type = (): void => void this.d.link.typing(channelId).catch(() => undefined)
    type()
    this.typers.set(tabId, { channelId, timer: setInterval(type, TYPING_RENEWED_EVERY_MS) })
  }
}
