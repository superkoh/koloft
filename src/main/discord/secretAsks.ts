import { randomUUID } from 'crypto'
import { loopbackHttp, urlOrNull } from '@shared/browserRoute'
import type { SecretAskShape, SecretAskView } from '@shared/types'
import { accentOf, type Card, type CardButton } from './cards'
import { privately, type DiscordInteraction } from './link'
import { ONLY_THE_OWNER_ANSWERS } from './buttons'

export const SECRET_ID_PREFIX = 'secret:'
const OPEN_A_FORM = 9
const FORM_TITLE = 'Koloft'
const FORM_LABEL_LIMIT = 45
const FIELD = 'value'
const SHORT_TEXT = 1
const TEXT_INPUT = 4
const ACTION_ROW = 1
const LONGEST_SECRET = 4000

export const PLAIN_TEXT_WARNING =
  '-# What you type shows on your screen as plain text. Koloft passes it on itself: the session never sees it, and it does not stay in this chat.'
export const PASSED_ON = 'Koloft passed it on.'
export const NO_LONGER_WAITING = 'Koloft is no longer waiting for this.'
export const NOTHING_TYPED = 'Nothing was typed, so nothing was passed on.'
export const ANSWERED_IN_KOLOFT = '✅ Answered in Koloft.'
export const TURNED_DOWN_IN_KOLOFT = '⏹ Turned down in Koloft.'

export interface SecretAsk {
  tabId: string
  from: string
  shape: SecretAskShape
  header(name: string): string
  body: string
  label: string
}

export type SecretAnswer =
  { typed: string } | { doneInKoloft: true } | { ended: 'timeout' | 'declined' }

export interface PlacedCard {
  channelId: string
  messageId: string
  name: string
}

export interface SecretAskDeps {
  owner(): string | undefined
  cardWanted(tabId: string): boolean
  place(tabId: string, card: (name: string) => Card): Promise<PlacedCard | undefined>
  edit(placed: PlacedCard, card: Card): Promise<void>
  respond(i: DiscordInteraction, body: unknown): Promise<unknown>
  show(asks: SecretAskView[]): void
  askedOnlyInKoloft(tabId: string): void
  ended(tabId: string): void
}

interface Pending {
  ask: SecretAsk
  placed?: PlacedCard
  footer?: string
  signInGuest?: number
  settle(answer: SecretAnswer): void
}

function sameUrl(a: string, b: string): boolean {
  return (urlOrNull(a)?.href ?? a) === (urlOrNull(b)?.href ?? b)
}

export class SecretAsks {
  private pending = new Map<string, Pending>()

  constructor(private d: SecretAskDeps) {}

  async ask(ask: SecretAsk, waitMs: number): Promise<SecretAnswer> {
    const id = randomUUID()
    let settle!: (answer: SecretAnswer) => void
    const answer = new Promise<SecretAnswer>((resolve) => (settle = resolve))
    const pending: Pending = { ask, settle }
    this.pending.set(id, pending)
    this.d.show(this.views())
    const timer = setTimeout(
      () => this.end(id, { ended: 'timeout' }, '⌛ Koloft stopped waiting.'),
      waitMs
    )
    if (this.d.cardWanted(ask.tabId)) void this.placeCard(id, pending)
    else this.d.askedOnlyInKoloft(ask.tabId)
    const value = await answer
    clearTimeout(timer)
    return value
  }

  views(): SecretAskView[] {
    return [...this.pending].map(([id, p]) => ({ ...p.ask.shape, id, tabId: p.ask.tabId }))
  }

  answer(id: string, typed: string): void {
    if (typed) this.end(id, { typed }, ANSWERED_IN_KOLOFT)
  }

  done(id: string): void {
    if (this.pending.get(id)?.ask.shape.kind === 'sudo') return
    this.end(id, { doneInKoloft: true }, ANSWERED_IN_KOLOFT)
  }

  decline(id: string): void {
    this.end(id, { ended: 'declined' }, TURNED_DOWN_IN_KOLOFT)
  }

  navigationStarted(guestId: number, url: string): void {
    for (const p of this.pending.values()) {
      const s = p.ask.shape
      if (s.kind === 'url' && p.signInGuest === undefined && sameUrl(url, s.signIn))
        p.signInGuest = guestId
    }
  }

  navigated(guestId: number, url: string): void {
    for (const [id, p] of this.pending) {
      const s = p.ask.shape
      const landed =
        (s.kind === 'page' && s.guestId === guestId) ||
        (s.kind === 'url' &&
          p.signInGuest === guestId &&
          !!loopbackHttp(url) &&
          !sameUrl(url, s.signIn))
      if (landed) this.done(id)
    }
  }

  rehome(fromTabId: string, toTabId: string): void {
    let moved = false
    for (const p of this.pending.values())
      if (p.ask.tabId === fromTabId) {
        p.ask = { ...p.ask, tabId: toTabId }
        moved = true
      }
    if (moved) this.d.show(this.views())
  }

  private async placeCard(id: string, pending: Pending): Promise<void> {
    const button = { label: 'Enter it', style: 'primary' as const, id: `${SECRET_ID_PREFIX}${id}` }
    const placed = await this.d
      .place(pending.ask.tabId, (name) => cardOf(pending.ask, name, PLAIN_TEXT_WARNING, [button]))
      .catch(() => undefined)
    if (!placed) return
    pending.placed = placed
    if (pending.footer) this.editCard(pending)
  }

  private async pendingFor(i: DiscordInteraction): Promise<[string, Pending] | undefined> {
    if (i.userId !== this.d.owner()) {
      await this.d.respond(i, privately(ONLY_THE_OWNER_ANSWERS))
      return undefined
    }
    const id = (i.customId ?? '').slice(SECRET_ID_PREFIX.length)
    const pending = this.pending.get(id)
    if (!pending) await this.d.respond(i, privately(NO_LONGER_WAITING))
    return pending && [id, pending]
  }

  // PLATFORM§39
  async press(i: DiscordInteraction): Promise<void> {
    const found = await this.pendingFor(i)
    if (!found) return
    const [id, pending] = found
    await this.d.respond(i, {
      type: OPEN_A_FORM,
      data: {
        custom_id: `${SECRET_ID_PREFIX}${id}`,
        title: FORM_TITLE,
        components: [
          {
            type: ACTION_ROW,
            components: [
              {
                type: TEXT_INPUT,
                custom_id: FIELD,
                label: pending.ask.label.slice(0, FORM_LABEL_LIMIT),
                style: SHORT_TEXT,
                required: true,
                max_length: LONGEST_SECRET
              }
            ]
          }
        ]
      }
    })
  }

  async submit(i: DiscordInteraction): Promise<void> {
    const found = await this.pendingFor(i)
    if (!found) return
    const [id] = found
    const value = i.fields?.[FIELD] ?? ''
    if (!value) {
      await this.d.respond(i, privately(NOTHING_TYPED))
      return
    }
    this.end(id, { typed: value }, '✅ Passed on.')
    await this.d.respond(i, privately(PASSED_ON))
  }

  forget(tabId: string): void {
    for (const [id, p] of this.pending)
      if (p.ask.tabId === tabId || p.ask.from === tabId)
        this.end(id, { ended: 'timeout' }, '⏹ The session closed.')
  }

  private end(id: string, answer: SecretAnswer, footer: string): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.footer = footer
    p.settle(answer)
    this.d.show(this.views())
    const tabId = p.ask.tabId
    if (![...this.pending.values()].some((q) => q.ask.tabId === tabId)) this.d.ended(tabId)
    if (p.placed) this.editCard(p)
  }

  private editCard(p: Pending): void {
    const placed = p.placed!
    void this.d.edit(placed, cardOf(p.ask, placed.name, `-# ${p.footer}`)).catch(() => undefined)
  }
}

function cardOf(ask: SecretAsk, name: string, footer: string, buttons?: CardButton[]): Card {
  return { accent: accentOf(name), header: ask.header(name), body: ask.body, footer, buttons }
}
