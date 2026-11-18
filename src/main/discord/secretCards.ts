import { accentOf, type Card, type CardButton } from './cards'
import { privately, type DiscordFile, type DiscordInteraction } from './link'
import { ONLY_THE_OWNER_ANSWERS } from './buttons'
import { errorText } from '@core/errorText'

export const SECRET_ID_PREFIX = 'secret:'
const OPEN_A_FORM = 9
const FORM_TITLE = 'Koloft'
const FORM_LABEL_LIMIT = 45
const FIELD = 'value'
const SHORT_TEXT = 1
const TEXT_INPUT = 4
const ACTION_ROW = 1
const LONGEST_SECRET = 4000
export const A_CARD_REACHES_DISCORD_WITHIN_MS = 60_000

export const PLAIN_TEXT_WARNING =
  '-# What you type shows on your screen as plain text. Koloft passes it on itself: the session never sees it, and it does not stay in this chat.'
export const PASSED_ON = 'Koloft passed it on.'
export const NO_LONGER_WAITING = 'Koloft is no longer waiting for this.'
export const NOTHING_TYPED = 'Nothing was typed, so nothing was passed on.'
export const ANSWERED_IN_KOLOFT = '✅ Answered in Koloft.'
export const TURNED_DOWN_IN_KOLOFT = '⏹ Turned down in Koloft.'

const TAPS_FIRST_FOOTER =
  '-# Koloft taps the middle of each square you name, then sends a new picture.'
export const TAPPING = 'Koloft taps them and sends a new picture.'
const STILL_TAPPING = 'Koloft is still at the last taps: wait for the new picture.'
const GAVE_UP = '⏹ The owner gave up.'
export const PASSED = '✅ The owner said it passed.'
const SQUARES_EXAMPLE = 'B5 H4 F8'

export interface TapRounds {
  picture(): Promise<{ file: DiscordFile; seen(): void }>
  tap(squares: string, going: () => boolean): Promise<string>
}

const NO_PICTURE_POSTED = "\n-# Discord did not take the page's picture: press New picture."

export interface CardAsk {
  tabId: string
  header(name: string): string
  body: string
  label: string
  taps?: TapRounds
}

type HowItEnded =
  'timeout' | 'closed' | 'answered-in-koloft' | 'declined-in-koloft' | 'answered-elsewhere'

const FOOTER_WHEN_ENDED: Record<Exclude<HowItEnded, 'answered-elsewhere'>, string> = {
  timeout: '⌛ Koloft stopped waiting.',
  closed: '⏹ The session closed.',
  'answered-in-koloft': ANSWERED_IN_KOLOFT,
  'declined-in-koloft': TURNED_DOWN_IN_KOLOFT
}

type CardAnswer = { typed: string } | { passed: true } | { ended: 'declined' }

export interface AsksShownOnCards {
  pendingAsk: (id: string) => CardAsk | undefined
  answerFromElsewhere: (id: string, answer: CardAnswer) => void
  notShownElsewhere: (id: string) => void
}

export interface PlacedCard {
  channelId: string
  messageId: string
  name: string
}

export interface SecretCardDeps {
  asks: AsksShownOnCards
  owner(): string | undefined
  cardWanted(tabId: string): boolean
  place(
    tabId: string,
    card: (name: string) => Card,
    files?: DiscordFile[]
  ): Promise<PlacedCard | undefined>
  edit(placed: PlacedCard, card: Card): Promise<void>
  respond(i: DiscordInteraction, body: unknown): Promise<unknown>
}

interface Shown {
  ask: CardAsk
  placed?: PlacedCard
  footer?: string
  tapping?: boolean
}

type TapAction = 'picture' | 'passed' | 'give-up'

export class SecretCards {
  private shown = new Map<string, Shown>()

  constructor(private d: SecretCardDeps) {}

  asked(id: string, ask: CardAsk): boolean {
    if (!this.d.cardWanted(ask.tabId)) return false
    const shown: Shown = { ask }
    this.shown.set(id, shown)
    void this.placeCard(id, shown)
    return true
  }

  ended(id: string, how: HowItEnded, ask: CardAsk): void {
    const shown = this.shown.get(id)
    if (!shown) return
    this.shown.delete(id)
    shown.ask = ask
    if (how !== 'answered-elsewhere') shown.footer = FOOTER_WHEN_ENDED[how]
    if (shown.placed) this.editCard(shown)
  }

  private waiting(id: string): boolean {
    return this.d.asks.pendingAsk(id) !== undefined
  }

  private async placeCard(id: string, shown: Shown): Promise<void> {
    const button = { label: 'Enter it', style: 'primary' as const, id: `${SECRET_ID_PREFIX}${id}` }
    const late = setTimeout(
      () => this.d.asks.notShownElsewhere(id),
      A_CARD_REACHES_DISCORD_WITHIN_MS
    )
    const posted = shown.ask.taps
      ? await this.placeTapCard(id, shown, TAPS_FIRST_FOOTER)
      : await this.put(id, shown, (name) => cardOf(shown.ask, name, PLAIN_TEXT_WARNING, [button]))
    clearTimeout(late)
    if (!posted) this.d.asks.notShownElsewhere(id)
  }

  private async put(
    id: string,
    shown: Shown,
    card: (name: string) => Card,
    files?: DiscordFile[]
  ): Promise<boolean> {
    const tabId = (this.d.asks.pendingAsk(id) ?? shown.ask).tabId
    const placed = await this.d.place(tabId, card, files).catch(() => undefined)
    if (!placed) return false
    shown.placed = placed
    if (shown.footer) this.editCard(shown)
    return true
  }

  private async placeTapCard(id: string, shown: Shown, footer: string): Promise<boolean> {
    const picture = await shown.ask.taps!.picture().then(
      ({ file, seen }) => ({ files: [file], seen, note: '' }),
      (error: unknown) => ({
        files: [],
        seen: undefined,
        note: `\n-# Koloft could not take the page's picture: ${errorText(error)}.`
      })
    )
    if (!this.waiting(id)) return false
    const button = (label: string, style: CardButton['style'], action?: TapAction): CardButton => ({
      label,
      style,
      id: `${SECRET_ID_PREFIX}${id}${action ? `:${action}` : ''}`
    })
    const buttons = [
      button('Tap squares', 'primary'),
      button('New picture', 'secondary', 'picture'),
      button('It passed', 'success', 'passed'),
      button('Give up', 'secondary', 'give-up')
    ]
    const card =
      (note: string) =>
      (name: string): Card =>
        cardOf(shown.ask, name, `${footer}${note}`, buttons)
    if (await this.put(id, shown, card(picture.note), picture.files)) {
      picture.seen?.()
      return true
    }
    return (
      picture.files.length > 0 && this.waiting(id) && this.put(id, shown, card(NO_PICTURE_POSTED))
    )
  }

  private startRound(id: string, shown: Shown, act: () => Promise<string>): void {
    shown.tapping = true
    void this.tapRound(id, shown, act)
  }

  private async tapRound(id: string, shown: Shown, act: () => Promise<string>): Promise<void> {
    try {
      const note = await act().catch(
        (error: unknown) => `Koloft could not tap: ${errorText(error)}.`
      )
      if (!this.waiting(id)) return
      const before = shown.placed
      const placed = await this.placeTapCard(id, shown, `-# ${note} This is the page now.`)
      if (!placed) this.d.asks.notShownElsewhere(id)
      else if (before && this.waiting(id))
        void this.d
          .edit(before, cardOf(shown.ask, before.name, `-# ${note}`))
          .catch(() => undefined)
    } finally {
      shown.tapping = false
    }
  }

  private async shownFor(
    i: DiscordInteraction
  ): Promise<[string, Shown, TapAction | undefined] | undefined> {
    if (i.userId !== this.d.owner()) {
      await this.d.respond(i, privately(ONLY_THE_OWNER_ANSWERS))
      return undefined
    }
    const [id, action] = (i.customId ?? '').slice(SECRET_ID_PREFIX.length).split(':')
    const shown = this.waiting(id) ? this.shown.get(id) : undefined
    if (!shown) await this.d.respond(i, privately(NO_LONGER_WAITING))
    return shown && [id, shown, action as TapAction | undefined]
  }

  private end(id: string, shown: Shown, answer: CardAnswer, footer: string): void {
    shown.footer = footer
    this.d.asks.answerFromElsewhere(id, answer)
  }

  // PLATFORM§39
  async press(i: DiscordInteraction): Promise<void> {
    const found = await this.shownFor(i)
    if (!found) return
    const [id, shown, action] = found
    if (shown.ask.taps && (action === 'passed' || action === 'give-up')) {
      const [answer, note]: [CardAnswer, string] =
        action === 'passed' ? [{ passed: true }, PASSED] : [{ ended: 'declined' }, GAVE_UP]
      this.end(id, shown, answer, note)
      await this.d.respond(i, privately(note))
      return
    }
    if (shown.tapping) {
      await this.d.respond(i, privately(STILL_TAPPING))
      return
    }
    if (shown.ask.taps && action === 'picture') {
      this.startRound(id, shown, async () => 'New picture.')
      await this.d.respond(i, privately('Koloft sends a new picture.'))
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
                label: shown.ask.label.slice(0, FORM_LABEL_LIMIT),
                style: SHORT_TEXT,
                required: true,
                max_length: LONGEST_SECRET,
                ...(shown.ask.taps ? { placeholder: SQUARES_EXAMPLE } : {})
              }
            ]
          }
        ]
      }
    })
  }

  async submit(i: DiscordInteraction): Promise<void> {
    const found = await this.shownFor(i)
    if (!found) return
    const [id, shown] = found
    const value = i.fields?.[FIELD] ?? ''
    if (!value) {
      await this.d.respond(i, privately(NOTHING_TYPED))
      return
    }
    const taps = shown.ask.taps
    if (taps) {
      if (shown.tapping) {
        await this.d.respond(i, privately(STILL_TAPPING))
        return
      }
      this.startRound(id, shown, () => taps.tap(value, () => this.waiting(id)))
      await this.d.respond(i, privately(TAPPING))
      return
    }
    this.end(id, shown, { typed: value }, '✅ Passed on.')
    await this.d.respond(i, privately(PASSED_ON))
  }

  private editCard(shown: Shown): void {
    const placed = shown.placed!
    void this.d
      .edit(placed, cardOf(shown.ask, placed.name, `-# ${shown.footer}`))
      .catch(() => undefined)
  }
}

function cardOf(ask: CardAsk, name: string, footer: string, buttons?: CardButton[]): Card {
  return { accent: accentOf(name), header: ask.header(name), body: ask.body, footer, buttons }
}
