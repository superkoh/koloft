import type { AttentionEvent, AttentionKind } from '@shared/types'
import { FROM_KOLOFT } from './crossSessionMessage'

export const DIGEST_GATHERS_MS = 30_000
export const VERDICT_WAITED_AT_MOST_MS = 60_000
export const BUTLER_CHECKED_AGAIN_MS = 5_000
export const ITEMS_PER_DIGEST = 10
const REPLY_CHARS_QUOTED = 300
const PEER_MESSAGE_END = '</cross-session-message>'

export interface DigestItem {
  kind: AttentionKind
  title?: string
  sessionId?: string
  workspace?: string
  reply?: string
}

export interface AwayDigestDeps {
  away(): boolean
  lastHandsAt(): number
  reachable(): boolean
  marks(): AttentionEvent[]
  butlerSide(tabId: string): boolean
  judging(tabId: string): boolean
  sessionOf(mark: AttentionEvent): Omit<DigestItem, 'kind' | 'reply'>
  butlerBusy(): boolean
  tell(text: string): Promise<boolean>
  now(): number
  gatherMs: number
}

const HAPPENED: Record<AttentionKind, string> = {
  'turn-done': 'finished its turn and waits',
  approval: 'waits for an answer or an approval',
  exited: 'stopped unexpectedly'
}

export function quoteOf(text: string, chars: number): string {
  const line = text.replaceAll(PEER_MESSAGE_END, '').replace(/\s+/g, ' ').trim()
  return line.length > chars ? `${line.slice(0, chars)}…` : line
}

export function digestLine(item: DigestItem, n: number): string {
  const where = [
    item.sessionId && `session ${item.sessionId}`,
    item.workspace && `workspace ${item.workspace}`
  ].filter(Boolean)
  const reply = item.reply && quoteOf(item.reply, REPLY_CHARS_QUOTED)
  const quoted = reply && item.kind === 'turn-done' ? `; it said: "${reply}"` : ''
  return `${n}. "${item.title ?? 'A session'}"${where.length ? ` (${where.join(', ')})` : ''} ${HAPPENED[item.kind]}${quoted}.`
}

export function digestText(items: DigestItem[]): string {
  const shown = items.slice(0, ITEMS_PER_DIGEST)
  const more = items.length - shown.length
  const rest = more > 0 ? ` And ${more} more; koloft todo lists them all.` : ''
  return `${FROM_KOLOFT}The owner is away from Koloft, and these sessions changed since they last used it: ${shown.map((item, i) => digestLine(item, i + 1)).join(' ')}${rest} What you reply to this goes nowhere. If any of it needs the owner, tell them on Discord with koloft discord send -- "<what to say>"; if none of it does, do nothing.`
}

export class AwayDigest {
  private timer: ReturnType<typeof setTimeout> | undefined
  private handedUpTo: number
  private telling = false
  private waitingSince: number | undefined
  private lastReply = new Map<string, string>()
  private handedOff = new Set<string>()

  constructor(private readonly d: AwayDigestDeps) {
    this.handedUpTo = d.now()
  }

  turnEnded(tabId: string, reply: string, handedOff: boolean): void {
    this.lastReply.set(tabId, reply)
    if (handedOff) this.handedOff.add(tabId)
    else this.handedOff.delete(tabId)
  }

  prompted(tabId: string): void {
    this.lastReply.delete(tabId)
    this.handedOff.delete(tabId)
  }

  forget(tabId: string): void {
    this.prompted(tabId)
  }

  marked(): void {
    if (this.timer || !this.d.away() || !this.d.reachable()) return
    this.later(this.d.gatherMs)
  }

  changedSince(since: number): DigestItem[] {
    this.handedUpTo = Math.max(this.handedUpTo, this.d.now())
    return this.d
      .marks()
      .filter((m) => m.at > since && !m.fyi && !this.d.butlerSide(m.tabId))
      .map((m) => this.itemOf(m))
  }

  private itemOf(m: AttentionEvent): DigestItem {
    return { ...this.d.sessionOf(m), kind: m.kind, reply: this.lastReply.get(m.tabId) }
  }

  private later(ms: number): void {
    this.timer = setTimeout(() => this.hand(), ms)
  }

  private hand(): void {
    this.timer = undefined
    const since = Math.max(this.d.lastHandsAt(), this.handedUpTo)
    const fresh = this.d
      .marks()
      .filter(
        (m) =>
          m.at > since &&
          !m.fyi &&
          !this.d.butlerSide(m.tabId) &&
          !(m.kind === 'turn-done' && this.handedOff.has(m.tabId))
      )
    if (!fresh.length || !this.d.away() || !this.d.reachable()) {
      this.waitingSince = undefined
      return
    }
    const now = this.d.now()
    this.waitingSince ??= now
    const unjudged = fresh.some((m) => m.kind === 'turn-done' && this.d.judging(m.tabId))
    if (
      (unjudged && now - this.waitingSince < VERDICT_WAITED_AT_MOST_MS) ||
      this.telling ||
      this.d.butlerBusy()
    )
      return this.later(BUTLER_CHECKED_AGAIN_MS)
    this.waitingSince = undefined
    const before = this.handedUpTo
    this.handedUpTo = Math.max(...fresh.map((m) => m.at))
    this.telling = true
    void this.d.tell(digestText(fresh.map((m) => this.itemOf(m)))).then((told) => {
      this.telling = false
      if (!told) this.handedUpTo = before
    })
  }
}
