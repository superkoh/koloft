import { setTimeout as sleep } from 'timers/promises'
import type { BackendId } from '@shared/types'
import { messagingOf } from '@shared/sessionBackend'
import { errorText } from '@core/errorText'
import {
  MESSAGE_SOCKET_SHOWS_WITHIN_MS,
  crossSessionLine,
  fitsACrossSessionMessage,
  type ModeClass
} from '../../../main/crossSessionMessage'

const PROMPT_SETTLES_AFTER_BIND_MS = 1000
const RECIPIENT_GETS_READY_WITHIN_MS = 10 * 60_000
// AGY§8
const FIRST_PROMPT_BINDS_WITHIN_MS = 10_000

export interface Recipient {
  key: string
  name: string
  liveTab(): string | undefined
  open(): Promise<string>
  ownerIsWhere?(): string
}

export interface Words {
  clientId: string
  text(): Promise<string>
  typeAsCommand?(tab: string, command: string): Promise<void>
  ownersOwn?: boolean
  handing?(tab: string, said: string): void
  notHanded?(tab: string, said: string): void
  settle(failed?: string): void
}

export interface QuietMarks {
  handing(tab: string, said: string): void
  notHanded(tab: string, said: string): void
}

export interface HandOverDeps {
  backendOf(tab: string): BackendId | undefined
  boundKey(tab: string): string | undefined
  alive(tab: string): boolean
  typable(tab: string): boolean
  ready(tab: string, ready: () => boolean, ms: number): Promise<boolean>
  type(tab: string, keys: string[]): Promise<boolean>
  queue(tab: string, text: string, clientId: string): Promise<void>
  sendLine(tab: string, line: string, ms: number): Promise<void>
  modeOf(tab: string): ModeClass
  beforeHanding(tab: string, text: string, clientId: string, asPeerLine: boolean): Promise<void>
  quiet: QuietMarks
}

export class HandOver {
  private queues = new Map<string, Words[]>()
  private told = 0

  constructor(private d: HandOverDeps) {}

  tell(
    to: Recipient,
    text: string,
    delivered: (ok: boolean) => void = () => undefined,
    quiet = false
  ): void {
    this.hand(to, {
      clientId: `koloft-notice-${++this.told}`,
      text: async () => text,
      ...(quiet && {
        handing: (tab, said) => this.d.quiet.handing(tab, said),
        notHanded: (tab, said) => this.d.quiet.notHanded(tab, said)
      }),
      settle: (failed) => delivered(!failed)
    })
  }

  tellQuietly(to: Recipient, text: string): Promise<boolean> {
    return new Promise((resolve) => this.tell(to, text, resolve, true))
  }

  hand(to: Recipient, words: Words): void {
    const waiting = this.queues.get(to.key)
    if (waiting) return void waiting.push(words)
    const items = [words]
    this.queues.set(to.key, items)
    void this.pump(to, items)
  }

  delivering(key: string): boolean {
    return this.queues.has(key)
  }

  private async pump(to: Recipient, items: Words[]): Promise<void> {
    try {
      while (items.length) {
        const words = items[0]
        const failed = await this.deliver(to, words)
          .then(() => undefined)
          .catch(errorText)
        items.shift()
        words.settle(failed)
      }
    } finally {
      this.queues.delete(to.key)
    }
  }

  private async deliver(to: Recipient, words: Words): Promise<void> {
    const tab = await this.readyTab(to)
    const first = !this.d.boundKey(tab)
    const said = await words.text()
    const fromKoloft = !words.typeAsCommand && !words.ownersOwn
    const text = fromKoloft && to.ownerIsWhere ? `${said} ${to.ownerIsWhere()}` : said
    words.handing?.(tab, said)
    try {
      await this.handTo(tab, words, text)
    } catch (error) {
      words.notHanded?.(tab, said)
      throw error
    }
    // AGY§8
    if (first) await this.d.ready(tab, () => !!this.d.boundKey(tab), FIRST_PROMPT_BINDS_WITHIN_MS)
  }

  private async handTo(tab: string, words: Words, text: string): Promise<void> {
    if (words.typeAsCommand) return words.typeAsCommand(tab, text)
    const backend = this.d.backendOf(tab)
    const route = backend && messagingOf(backend, false)
    if (route === 'peerLine') return this.sendAsPeer(tab, text, words.clientId)
    await this.d.beforeHanding(tab, text, words.clientId, false)
    if (route === 'queue') return this.d.queue(tab, text, words.clientId)
    await this.d.type(tab, [text, '\r'])
  }

  // CC§13 ADR-0028
  private async sendAsPeer(tab: string, text: string, id: string): Promise<void> {
    if (!fitsACrossSessionMessage(text))
      throw new Error('Koloft cannot hand over a message holding </cross-session-message>.')
    await this.d.beforeHanding(tab, text, id, true)
    await this.d.sendLine(
      tab,
      crossSessionLine(this.d.modeOf(tab), text, id),
      MESSAGE_SOCKET_SHOWS_WITHIN_MS
    )
  }

  private async readyTab(to: Recipient): Promise<string> {
    const already = to.liveTab()
    const tab = await to.open()
    if (!(await this.d.ready(tab, () => this.d.typable(tab), RECIPIENT_GETS_READY_WITHIN_MS)))
      throw new Error(
        this.d.alive(tab)
          ? `${to.name} did not get ready in time.`
          : `${to.name} closed before it was ready.`
      )
    if (tab !== already) await sleep(PROMPT_SETTLES_AFTER_BIND_MS)
    return tab
  }
}
