import type { AttentionEvent, AttentionKind } from '@shared/types'
import { FROM_KOLOFT } from './crossSessionMessage'

export const DIGEST_GATHERS_MS = 30_000
export const VERDICT_WAITED_AT_MOST_MS = 60_000
export const BUTLER_CHECKED_AGAIN_MS = 5_000
const REPLY_CHARS_QUOTED = 300

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
  handedOff(tabId: string): boolean
  itemOf(mark: AttentionEvent): DigestItem
  butlerBusy(): boolean
  tell(text: string): void
  now(): number
  gatherMs: number
}

const HAPPENED: Record<AttentionKind, string> = {
  'turn-done': 'finished its turn and waits',
  approval: 'waits for an answer or an approval',
  exited: 'stopped unexpectedly'
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function lineOf(item: DigestItem, n: number): string {
  const where = [
    item.sessionId && `session ${item.sessionId}`,
    item.workspace && `workspace ${item.workspace}`
  ].filter(Boolean)
  const reply = item.reply && oneLine(item.reply)
  const quoted =
    reply && item.kind === 'turn-done'
      ? `; it said: "${reply.length > REPLY_CHARS_QUOTED ? `${reply.slice(0, REPLY_CHARS_QUOTED)}…` : reply}"`
      : ''
  return `${n}. "${item.title ?? 'A session'}"${where.length ? ` (${where.join(', ')})` : ''} ${HAPPENED[item.kind]}${quoted}.`
}

export function digestText(items: DigestItem[]): string {
  return `${FROM_KOLOFT}The owner is away from Koloft, and these sessions changed since they last used it: ${items.map((item, i) => lineOf(item, i + 1)).join(' ')} What you reply to this goes nowhere. If any of it needs the owner, tell them on Discord with koloft discord send -- "<what to say>"; if none of it does, do nothing.`
}

export class AwayDigest {
  private timer: ReturnType<typeof setTimeout> | undefined
  private handedUpTo = 0
  private waitingSince: number | undefined
  private wasAway = false

  constructor(private readonly d: AwayDigestDeps) {}

  check(): void {
    const away = this.d.away()
    if (away && !this.wasAway) this.marked()
    this.wasAway = away
  }

  marked(): void {
    if (this.timer || !this.d.away() || !this.d.reachable()) return
    this.later(this.d.gatherMs)
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
          !(m.kind === 'turn-done' && this.d.handedOff(m.tabId))
      )
    if (!fresh.length || !this.d.away() || !this.d.reachable()) {
      this.waitingSince = undefined
      return
    }
    const now = this.d.now()
    this.waitingSince ??= now
    const unjudged = fresh.some((m) => m.kind === 'turn-done' && this.d.judging(m.tabId))
    if ((unjudged && now - this.waitingSince < VERDICT_WAITED_AT_MOST_MS) || this.d.butlerBusy())
      return this.later(BUTLER_CHECKED_AGAIN_MS)
    this.waitingSince = undefined
    this.handedUpTo = now
    this.d.tell(digestText(fresh.map((m) => this.d.itemOf(m))))
  }
}
