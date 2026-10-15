import { randomUUID } from 'crypto'
import { accentOf, type Card } from './cards'
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

export interface SecretAsk {
  tabId: string
  header(name: string): string
  body: string
  label: string
}

export interface PlacedCard {
  channelId: string
  messageId: string
  name: string
}

export interface SecretAskDeps {
  owner(): string | undefined
  place(tabId: string, card: (name: string) => Card): Promise<PlacedCard | undefined>
  edit(placed: PlacedCard, card: Card): Promise<void>
  respond(i: DiscordInteraction, body: unknown): Promise<unknown>
}

interface Pending {
  ask: SecretAsk
  placed?: PlacedCard
  settle(value: string | undefined): void
}

export class SecretAsks {
  private pending = new Map<string, Pending>()

  constructor(private d: SecretAskDeps) {}

  async ask(ask: SecretAsk, waitMs: number): Promise<string | undefined | null> {
    const id = randomUUID()
    const card = (name: string): Card => ({
      accent: accentOf(name),
      header: ask.header(name),
      body: ask.body,
      footer: PLAIN_TEXT_WARNING,
      buttons: [{ label: 'Enter it', style: 'primary', id: `${SECRET_ID_PREFIX}${id}` }]
    })
    let settle!: (value: string | undefined) => void
    const answer = new Promise<string | undefined>((resolve) => (settle = resolve))
    const pending: Pending = { ask, settle }
    this.pending.set(id, pending)
    const placed = await this.d.place(ask.tabId, card).catch(() => undefined)
    if (!placed) {
      this.pending.delete(id)
      return null
    }
    pending.placed = placed
    const timer = setTimeout(() => this.end(id, undefined, '⌛ Koloft stopped waiting.'), waitMs)
    const value = await answer
    clearTimeout(timer)
    return value
  }

  // PLATFORM§39
  async press(i: DiscordInteraction): Promise<void> {
    if (i.userId !== this.d.owner()) {
      await this.d.respond(i, privately(ONLY_THE_OWNER_ANSWERS))
      return
    }
    const id = (i.customId ?? '').slice(SECRET_ID_PREFIX.length)
    const pending = this.pending.get(id)
    if (!pending) {
      await this.d.respond(i, privately(NO_LONGER_WAITING))
      return
    }
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
    if (i.userId !== this.d.owner()) {
      await this.d.respond(i, privately(ONLY_THE_OWNER_ANSWERS))
      return
    }
    const id = (i.customId ?? '').slice(SECRET_ID_PREFIX.length)
    if (!this.pending.has(id)) {
      await this.d.respond(i, privately(NO_LONGER_WAITING))
      return
    }
    const value = i.fields?.[FIELD] ?? ''
    if (!value) {
      await this.d.respond(i, privately(NOTHING_TYPED))
      return
    }
    this.end(id, value, '✅ Passed on.')
    await this.d.respond(i, privately(PASSED_ON))
  }

  forget(tabId: string): void {
    for (const [id, p] of this.pending)
      if (p.ask.tabId === tabId) this.end(id, undefined, '⏹ The session closed.')
  }

  private end(id: string, value: string | undefined, footer: string): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.settle(value)
    const placed = p.placed
    if (!placed) return
    void this.d
      .edit(placed, {
        accent: accentOf(placed.name),
        header: p.ask.header(placed.name),
        body: p.ask.body,
        footer: `-# ${footer}`
      })
      .catch(() => undefined)
  }
}
