import { EventEmitter } from 'events'
import type { BackendId, SessionStatus } from '@shared/types'
import type { Turn } from '@shared/turns'
import { edgeAttention } from './attention'
import type { StatusEdge, TurnOverEdge } from './sessionRuntime'
import type { TabExit } from './tabLifecycle'

export type CloseWhy = 'you' | 'exited' | 'crashed' | 'asleep'

export type AnswerPlace = 'koloft' | 'discord'

export type SyncEvent =
  | {
      kind: 'session-listed'
      tabId: string
      key?: string
      title?: string
      workspace?: string
      backend?: BackendId
      startedBy?: string
    }
  | {
      kind: 'session-renamed'
      tabId: string
      key?: string
      title?: string
      workspace?: string
      statusUnknown: boolean
    }
  | { kind: 'owner-said'; tabId: string; key?: string; text: string }
  | { kind: 'others-said'; tabId: string; key?: string; from: string; text: string }
  | { kind: 'turn-replied'; tabId: string; key?: string; reply: string }
  | { kind: 'working'; tabId: string; key?: string; turnOver: boolean }
  | { kind: 'idle'; tabId: string; key?: string; turnDone: boolean }
  | { kind: 'asked'; tabId: string; key?: string }
  | { kind: 'answered'; tabId: string; key?: string; answer?: string; where: AnswerPlace }
  | { kind: 'secret-asked'; tabId: string; key?: string; label: string }
  | { kind: 'session-closed'; tabId: string; key?: string; why: CloseWhy; gone: boolean }
  | { kind: 'session-reopened'; tabId: string; key: string }
  | { kind: 'session-removed'; key: string }

export interface ListedSession {
  tabId: string
  key?: string
  title?: string
  workspace?: string
  statusUnknown: boolean
}

export interface SessionEventDeps {
  keyOf(tabId: string): string | undefined
  status(tabId: string): SessionStatus | undefined
  turnOver(tabId: string): boolean
  launchedToResume(tabId: string): string | undefined
}

export const DELIVERIES_REMEMBERED_PER_TAB = 20

function sameWords(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export class SessionEvents extends EventEmitter<{ event: [SyncEvent] }> {
  private delivered = new Map<string, string[]>()
  private listings = new Map<string, string>()
  private openAsks = new Map<string, { where: AnswerPlace; answer?: string }>()
  private boundOnce = new Set<string>()

  constructor(private d: SessionEventDeps) {
    super()
  }

  private send(event: SyncEvent): void {
    this.emit('event', event)
  }

  private key(tabId: string): string | undefined {
    return this.d.keyOf(tabId) || undefined
  }

  bound(tabId: string, key: string): void {
    this.listings.delete(tabId)
    const first = !this.boundOnce.has(tabId)
    this.boundOnce.add(tabId)
    if (first && key === this.d.launchedToResume(tabId))
      this.send({ kind: 'session-reopened', tabId, key })
    else this.send({ kind: 'session-listed', tabId, key })
  }

  started(
    startedBy: string,
    tabId: string,
    title: string,
    workspace: string,
    backend: BackendId
  ): void {
    this.send({ kind: 'session-listed', tabId, title, workspace, backend, startedBy })
  }

  sessionsChanged(sessions: ListedSession[]): void {
    for (const s of sessions) {
      const look = JSON.stringify([s.title, s.workspace, s.statusUnknown])
      if (this.listings.get(s.tabId) === look) continue
      this.listings.set(s.tabId, look)
      this.send({ kind: 'session-renamed', ...s, key: s.key || undefined })
    }
  }

  removed(key: string): void {
    this.send({ kind: 'session-removed', key })
  }

  status({ tabId, prev, next }: StatusEdge): void {
    const key = this.key(tabId)
    if (next === 'approval') return this.asked(tabId)
    this.answerOpenAsk(tabId)
    if (next === 'working')
      return this.send({ kind: 'working', tabId, key, turnOver: this.d.turnOver(tabId) })
    this.send({ kind: 'idle', tabId, key, turnDone: edgeAttention(prev, next) === 'turn-done' })
  }

  turnOver({ tabId, over }: TurnOverEdge): void {
    if (this.d.status(tabId) !== 'working') return
    this.send({ kind: 'working', tabId, key: this.key(tabId), turnOver: over })
  }

  asked(tabId: string): void {
    if (!this.openAsks.has(tabId)) this.openAsks.set(tabId, { where: 'koloft' })
    this.send({ kind: 'asked', tabId, key: this.key(tabId) })
  }

  answeredInDiscord(tabId: string, answer: string): void {
    if (this.openAsks.has(tabId)) this.openAsks.set(tabId, { where: 'discord', answer })
  }

  private answerOpenAsk(tabId: string): void {
    const ask = this.openAsks.get(tabId)
    if (!ask) return
    this.openAsks.delete(tabId)
    this.send({ kind: 'answered', tabId, key: this.key(tabId), ...ask })
  }

  secretAsked(tabId: string, label: string): void {
    this.send({ kind: 'secret-asked', tabId, key: this.key(tabId), label })
  }

  deliveredText(tabId: string, text: string): void {
    const words = sameWords(text)
    if (!words) return
    const list = this.delivered.get(tabId) ?? []
    list.push(words)
    if (list.length > DELIVERIES_REMEMBERED_PER_TAB) list.shift()
    this.delivered.set(tabId, list)
  }

  told(tabId: string, from: string, text: string, delivered = text): void {
    this.deliveredText(tabId, delivered)
    this.send({ kind: 'others-said', tabId, key: this.key(tabId), from, text })
  }

  private koloftTyped(tabId: string, text: string): boolean {
    const list = this.delivered.get(tabId)
    const at = list?.indexOf(sameWords(text)) ?? -1
    if (at < 0) return false
    list!.splice(at, 1)
    return true
  }

  turnEnded(tabId: string, turn: Turn): void {
    const key = this.key(tabId)
    for (const line of turn.said) {
      if (line.who !== 'owner') continue
      if (this.koloftTyped(tabId, line.text) || line.koloft) continue
      this.send({ kind: 'owner-said', tabId, key, text: line.text })
    }
    this.send({ kind: 'turn-replied', tabId, key, reply: turn.reply })
  }

  closing(tabId: string): void {
    this.send({ kind: 'session-closed', tabId, key: this.key(tabId), why: 'you', gone: false })
  }

  exit(e: Pick<TabExit, 'tabId' | 'asleep' | 'crashed' | 'byKoloft'>): void {
    const why: CloseWhy = e.asleep
      ? 'asleep'
      : e.byKoloft
        ? 'you'
        : e.crashed
          ? 'crashed'
          : 'exited'
    const key = this.key(e.tabId)
    this.delivered.delete(e.tabId)
    this.listings.delete(e.tabId)
    this.openAsks.delete(e.tabId)
    this.boundOnce.delete(e.tabId)
    this.send({ kind: 'session-closed', tabId: e.tabId, key, why, gone: true })
  }
}
