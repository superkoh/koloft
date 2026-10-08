import type { BackendId, SessionStatus } from '@shared/types'
import type { Card } from './cards'
import type { DiscordLink } from './link'
import { whereOf } from './threads'

export type LiveState = 'working' | 'needs-you' | 'turn-done' | 'idle' | 'closed' | 'unknown'

export interface StatusSubject {
  name: string
  backend: BackendId
  workspace?: string
}

export interface LiveStatusDeps {
  link: Pick<DiscordLink, 'editCard' | 'typing'>
  openerOf(tabId: string): { channelId: string; messageId: string } | undefined
  conductorChannelOf(tabId: string): string | undefined
  subject(tabId: string): Promise<StatusSubject | undefined>
  status(tabId: string): SessionStatus | undefined
  awaitsInput(tabId: string): boolean
  unknown(tabId: string): boolean
}

// PLATFORM§39
export const TYPING_RENEWED_EVERY_MS = 8000

const LOOK: Record<LiveState, { emoji: string; words: string; accent: number; timed: boolean }> = {
  working: { emoji: '🔄', words: 'working, started', accent: 0xec9670, timed: true },
  'needs-you': { emoji: '❓', words: 'needs you, asked', accent: 0xf0a830, timed: true },
  'turn-done': { emoji: '✅', words: 'turn done', accent: 0x8fc69a, timed: true },
  idle: { emoji: '💤', words: 'idle, done', accent: 0x5d7a63, timed: true },
  closed: { emoji: '⏹', words: 'closed', accent: 0x747f8d, timed: true },
  unknown: { emoji: '⚪', words: 'status unknown', accent: 0x747f8d, timed: false }
}

export function liveStateOf(
  status: SessionStatus | undefined,
  awaitsInput: boolean,
  unknown: boolean
): LiveState | undefined {
  if (unknown) return 'unknown'
  if (status === 'approval' || ((status === 'waiting' || status === 'idle') && awaitsInput))
    return 'needs-you'
  if (status === 'waiting') return 'turn-done'
  return status
}

export function statusCard(s: StatusSubject, state: LiveState, since: number): Card {
  const look = LOOK[state]
  const when = look.timed ? ` <t:${Math.floor(since / 1000)}:R>` : ''
  return {
    accent: look.accent,
    header: `${look.emoji} **${s.name}** · ${look.words}${when}`,
    body: whereOf(s),
    silent: true
  }
}

interface TabEntry {
  state?: LiveState
  since: number
  subject?: StatusSubject
  look?: string
}

interface Wanted {
  channelId: string
  card: Card
  body: string
}

export class LiveStatus {
  private tabs = new Map<string, TabEntry>()
  private typingIn = new Map<string, string>()
  private typingNow = new Set<string>()
  private ticker?: ReturnType<typeof setInterval>
  private wanted = new Map<string, Wanted>()
  private shown = new Map<string, string>()
  private editing = new Set<string>()

  constructor(private d: LiveStatusDeps) {}

  async refresh(tabId: string): Promise<void> {
    const entry = this.entryOf(tabId)
    const subject = this.d.openerOf(tabId) ? await this.d.subject(tabId) : undefined
    if (this.tabs.get(tabId) !== entry || entry.state === 'closed') return
    if (subject) entry.subject = subject
    const state = liveStateOf(
      this.d.status(tabId),
      this.d.awaitsInput(tabId),
      this.d.unknown(tabId)
    )
    if (state) this.enter(entry, state)
    this.typeWhile(tabId, state === 'working')
    this.show(tabId, entry)
  }

  sessionChanged(tabId: string, title: string | undefined, unknown: boolean): void {
    const entry = this.tabs.get(tabId)
    const look = `${title}\n${unknown}`
    if (!entry || entry.look === look) return
    entry.look = look
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
    const stillDone = state === 'idle' && entry.state === 'turn-done'
    if (!stillDone) entry.since = Date.now()
    entry.state = state
  }

  private show(tabId: string, entry: TabEntry): void {
    const at = this.d.openerOf(tabId)
    if (!at || !entry.subject || !entry.state) return
    const card = statusCard(entry.subject, entry.state, entry.since)
    this.wanted.set(at.messageId, { channelId: at.channelId, card, body: JSON.stringify(card) })
    if (!this.editing.has(at.messageId)) void this.edit(at.messageId)
  }

  private async edit(messageId: string): Promise<void> {
    this.editing.add(messageId)
    for (let w = this.wanted.get(messageId); w; w = this.wanted.get(messageId)) {
      this.wanted.delete(messageId)
      if (this.shown.get(messageId) === w.body) continue
      const done = await this.d.link.editCard(w.channelId, messageId, w.card).then(
        () => true,
        () => false
      )
      if (done) this.shown.set(messageId, w.body)
    }
    this.editing.delete(messageId)
  }

  private typeWhile(tabId: string, working: boolean): void {
    const channelId = working
      ? (this.d.openerOf(tabId)?.messageId ?? this.d.conductorChannelOf(tabId))
      : undefined
    const before = this.typingIn.get(tabId)
    if (channelId) this.typingIn.set(tabId, channelId)
    else this.typingIn.delete(tabId)
    if (channelId && channelId !== before) this.type(channelId)
    if (this.typingIn.size && !this.ticker)
      this.ticker = setInterval(() => this.renew(), TYPING_RENEWED_EVERY_MS)
    if (!this.typingIn.size && this.ticker) {
      clearInterval(this.ticker)
      this.ticker = undefined
    }
  }

  private renew(): void {
    for (const channelId of new Set(this.typingIn.values())) this.type(channelId)
  }

  private type(channelId: string): void {
    if (this.typingNow.has(channelId)) return
    this.typingNow.add(channelId)
    void this.d.link
      .typing(channelId)
      .catch(() => undefined)
      .finally(() => this.typingNow.delete(channelId))
  }
}
