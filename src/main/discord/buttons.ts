import { randomUUID } from 'crypto'
import { cardMessages, type Card } from './cards'
import type { Choice, DialogView } from './dialog'
import { privately, type DiscordInteraction } from './link'

export const NO_LONGER_OPEN = 'This question is no longer open.'
export const ONLY_THE_OWNER_ANSWERS = 'Only the owner Koloft is paired with can answer here.'
export const ANSWERED_ON_THE_COMPUTER = '✅ Answered on the computer.'
export const SESSION_CLOSED = '⏹ The session closed.'
const ANSWER_SHOWN_UP_TO = 200
export const answeredWith = (reply: string): string =>
  `✅ Answered: ${reply.length > ANSWER_SHOWN_UP_TO ? `${reply.slice(0, ANSWER_SHOWN_UP_TO)}…` : reply}`
const ID_PREFIX = 'ask:'
const UPDATE_MESSAGE = 7

export interface PlacedAsk {
  channelId: string
  messageId: string
}

interface OpenAsk {
  tabId: string
  text: string
  choices: Choice[]
  card: Card
  placed?: PlacedAsk
  reply?: string
  footer?: string
}

export interface ButtonDeps {
  owner(): string | undefined
  dialogText(tabId: string): Promise<string | undefined>
  answer(tabId: string, reply: string): Promise<string | undefined>
  respond(i: DiscordInteraction, body: unknown): Promise<unknown>
  edit(placed: PlacedAsk, card: Card): Promise<void>
}

export class AskButtons {
  private asks = new Map<string, OpenAsk>()

  constructor(private d: ButtonDeps) {}

  attach(tabId: string, view: DialogView, card: Card): Card {
    this.forget(tabId, ANSWERED_ON_THE_COMPUTER)
    const id = randomUUID()
    const withButtons: Card = {
      ...card,
      buttons: view.choices.map((c, n) => ({
        label: c.label,
        style: c.style,
        id: `${ID_PREFIX}${id}:${n}`
      }))
    }
    this.asks.set(id, { tabId, text: view.text, choices: view.choices, card: withButtons })
    return withButtons
  }

  placed(card: Card, at: PlacedAsk | undefined): void {
    const [id] = askPartsOf(card.buttons?.[0]?.id)
    const ask = this.asks.get(id)
    if (!ask) return
    if (!at) {
      this.asks.delete(id)
      return
    }
    ask.placed = at
    if (ask.footer) this.settle(id, ask.footer)
  }

  answered(tabId: string, reply: string): void {
    for (const ask of this.asks.values()) if (ask.tabId === tabId) ask.reply = reply
    void this.check(tabId)
  }

  async check(tabId: string): Promise<void> {
    const open = [...this.asks].filter(([, a]) => a.tabId === tabId && !a.footer)
    if (!open.length) return
    const text = await this.d.dialogText(tabId)
    for (const [id, ask] of open)
      if (text !== ask.text && this.asks.get(id) === ask && !ask.footer)
        this.settle(id, ask.reply ? answeredWith(ask.reply) : ANSWERED_ON_THE_COMPUTER)
  }

  async press(i: DiscordInteraction): Promise<void> {
    if (i.userId !== this.d.owner()) {
      await this.d.respond(i, privately(ONLY_THE_OWNER_ANSWERS))
      return
    }
    const [id, n] = askPartsOf(i.customId)
    const ask = this.asks.get(id)
    const choice = ask?.choices[Number(n)]
    if (!ask || ask.footer || !choice || (await this.d.dialogText(ask.tabId)) !== ask.text) {
      if (ask && !ask.footer) this.settle(id, ANSWERED_ON_THE_COMPUTER)
      await this.d.respond(i, privately(NO_LONGER_OPEN))
      return
    }
    this.asks.delete(id)
    const error = await this.d.answer(ask.tabId, choice.reply)
    if (error) {
      this.asks.set(id, ask)
      await this.d.respond(i, privately(error))
      return
    }
    const answered = cardMessages(this.settledCard(ask, `✅ ${choice.label}`))
    await this.d.respond(i, { type: UPDATE_MESSAGE, data: answered[answered.length - 1] })
  }

  forget(tabId: string, footer = SESSION_CLOSED): void {
    for (const [id, ask] of this.asks)
      if (ask.tabId === tabId && !ask.footer)
        this.settle(id, ask.reply ? answeredWith(ask.reply) : footer)
  }

  private settle(id: string, footer: string): void {
    const ask = this.asks.get(id)
    if (!ask) return
    ask.footer = footer
    if (!ask.placed) return
    this.asks.delete(id)
    void this.d.edit(ask.placed, this.settledCard(ask, footer)).catch(() => undefined)
  }

  private settledCard(ask: OpenAsk, footer: string): Card {
    return { ...ask.card, buttons: [], footer: `-# ${footer}` }
  }
}

function askPartsOf(customId: string | undefined): [string, string] {
  const [id = '', n = ''] = (customId ?? '').slice(ID_PREFIX.length).split(':')
  return [id, n]
}
