import { diffLines } from '@shared/editDiff'
import { errorText } from '@core/errorText'
import {
  CHANGE_THEM,
  INSTRUCTIONS_CHANGED_MEANWHILE,
  KEEP_THEM,
  NOTHING_CHANGES_UNTIL_YOU_AGREE,
  changeSummary,
  type InstructionAsk,
  type InstructionAskEnd,
  type InstructionAskListener
} from '@plugins/sessions/api'
import { CONDUCTOR_ACCENT, type Card } from './cards'
import { privately, type DiscordInteraction } from './link'
import { ONLY_THE_OWNER_ANSWERS, SESSION_CLOSED, UPDATE_MESSAGE_LATER } from './buttons'
import { NO_LONGER_WAITING, type PlacedCard } from './secretCards'
import { butlerAsks, HELD_ASKS_CHECKED_EVERY_MS } from './relay'

export const INSTRUCTIONS_ID_PREFIX = 'instructions:'
const AGREE = 'agree'
const FENCE = '```'
const FENCE_THAT_CANNOT_CLOSE = '`​`​`'

export const CHANGED = '✅ Changed.'
export const NOT_CHANGED = '⏹ Not changed.'
export const CHANGED_ON_THE_COMPUTER = '✅ Changed, on the computer.'
export const NOT_CHANGED_ON_THE_COMPUTER = '⏹ Not changed, on the computer.'
export const STOPPED_WAITING = '⌛ Koloft stopped waiting, so nothing changed.'
export const SESSION_STOPPED_WAITING = '⏹ The session stopped waiting, so nothing changed.'
export const CHANGED_MEANWHILE = `⏹ ${INSTRUCTIONS_CHANGED_MEANWHILE}`

export function footerWhenEnded(end: InstructionAskEnd): string {
  switch (end.how) {
    case 'changed':
      return end.at === 'phone' ? CHANGED : CHANGED_ON_THE_COMPUTER
    case 'not-changed':
      return end.at === 'phone' ? NOT_CHANGED : NOT_CHANGED_ON_THE_COMPUTER
    case 'changed-meanwhile':
      return CHANGED_MEANWHILE
    case 'write-failed':
      return `⚠ ${errorText(end.error)}`
    case 'timeout':
      return STOPPED_WAITING
    case 'tab-closed':
      return SESSION_CLOSED
    case 'stopped-waiting':
      return SESSION_STOPPED_WAITING
  }
}

const withoutFences = (line: string): string => line.replaceAll(FENCE, FENCE_THAT_CANNOT_CLOSE)

export function changeShown(ask: InstructionAsk): string {
  const mark = { ctx: '  ', add: '+ ', del: '- ' } as const
  const rows = diffLines(ask.before, ask.after).rows.map(
    (r) => `${mark[r.kind]}${withoutFences(r.text)}`
  )
  return [
    `${ask.by} wants to change ${ask.what}: ${changeSummary(ask.before, ask.after)}.`,
    `${FENCE}diff`,
    ...rows,
    FENCE
  ].join('\n')
}

export interface InstructionCardDeps {
  asks: {
    pendingAsk(id: string): InstructionAsk | undefined
    answerFromElsewhere(id: string, agreed: boolean): void
  }
  owner(): string | undefined
  cardWanted(tabId: string): boolean
  place(tabId: string, card: (name: string) => Card): Promise<PlacedCard | undefined>
  edit(placed: PlacedCard, card: Card): Promise<void>
  respond(i: DiscordInteraction, body: unknown): Promise<unknown>
}

interface Shown {
  ask: InstructionAsk
  tried?: boolean
  placing?: boolean
  placed?: PlacedCard
  footer?: string
}

export class InstructionCards implements InstructionAskListener {
  private shown = new Map<string, Shown>()
  private heldCheck: ReturnType<typeof setInterval> | undefined

  constructor(private d: InstructionCardDeps) {}

  asked(id: string, ask: InstructionAsk): void {
    this.shown.set(id, { ask })
    this.post(id)
  }

  ended(id: string, end: InstructionAskEnd): void {
    const shown = this.shown.get(id)
    if (!shown) return
    this.shown.delete(id)
    shown.footer = footerWhenEnded(end)
    if (shown.placed) void this.editCard(shown)
  }

  async endAll(footer: string): Promise<void> {
    const all = [...this.shown.values()]
    this.shown.clear()
    await Promise.all(
      all.map((s) => {
        s.footer = footer
        return s.placed ? this.editCard(s) : undefined
      })
    )
  }

  onDiscord(tabId: string): 'posted' | 'posting' | undefined {
    const mine = [...this.shown].flatMap(([id, s]) =>
      (this.d.asks.pendingAsk(id) ?? s.ask).tabId === tabId ? [s] : []
    )
    if (mine.some((s) => s.placed)) return 'posted'
    const onItsWay = (s: Shown): boolean => !!s.placing || (!s.tried && this.d.cardWanted(tabId))
    return mine.some(onItsWay) ? 'posting' : undefined
  }

  checkHeld(): void {
    for (const id of this.shown.keys()) this.post(id)
    if ([...this.shown.values()].some((s) => !s.placing && !s.placed)) return
    clearInterval(this.heldCheck)
    this.heldCheck = undefined
  }

  private post(id: string): void {
    const shown = this.shown.get(id)
    if (!shown || shown.placing || shown.placed) return
    const tabId = (this.d.asks.pendingAsk(id) ?? shown.ask).tabId
    if (!this.d.cardWanted(tabId)) {
      this.heldCheck ??= setInterval(() => this.checkHeld(), HELD_ASKS_CHECKED_EVERY_MS).unref()
      return
    }
    shown.placing = true
    void this.d
      .place(tabId, (name) => this.cardOf(id, shown, name))
      .catch(() => undefined)
      .then((placed) => {
        shown.placing = false
        shown.tried = true
        shown.placed = placed
        if (placed && shown.footer) void this.editCard(shown)
      })
  }

  async press(i: DiscordInteraction): Promise<void> {
    if (i.userId !== this.d.owner()) {
      await this.d.respond(i, privately(ONLY_THE_OWNER_ANSWERS))
      return
    }
    const [id, choice] = (i.customId ?? '').slice(INSTRUCTIONS_ID_PREFIX.length).split(':')
    if (!this.d.asks.pendingAsk(id) || !this.shown.has(id)) {
      await this.d.respond(i, privately(NO_LONGER_WAITING))
      return
    }
    await this.d.respond(i, { type: UPDATE_MESSAGE_LATER })
    this.d.asks.answerFromElsewhere(id, choice === AGREE)
  }

  private cardOf(id: string, shown: Shown, name: string): Card {
    const button = (label: string, style: 'secondary' | 'success', choice: string) => ({
      label,
      style,
      id: `${INSTRUCTIONS_ID_PREFIX}${id}:${choice}`
    })
    return {
      accent: CONDUCTOR_ACCENT,
      header: butlerAsks(name),
      body: changeShown(shown.ask),
      footer: `-# ${shown.footer ?? NOTHING_CHANGES_UNTIL_YOU_AGREE}`,
      buttons: shown.footer
        ? []
        : [button(KEEP_THEM, 'secondary', 'keep'), button(CHANGE_THEM, 'success', AGREE)]
    }
  }

  private editCard(shown: Shown): Promise<void> {
    const placed = shown.placed!
    return this.d.edit(placed, this.cardOf('', shown, placed.name)).catch(() => undefined)
  }
}
