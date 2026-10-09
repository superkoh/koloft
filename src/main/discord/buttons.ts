import { randomUUID } from 'crypto'
import { cardMessages, type Card } from './cards'
import type { Choice, DialogView } from './dialog'
import { privately, type DiscordInteraction } from './link'

export const NO_LONGER_OPEN = 'This question is no longer open.'
export const ONLY_THE_OWNER_ANSWERS = 'Only the owner Koloft is paired with can answer here.'
const ID_PREFIX = 'ask:'
const UPDATE_MESSAGE = 7

interface OpenAsk {
  tabId: string
  text: string
  choices: Choice[]
  card: Card
}

export interface ButtonDeps {
  owner(): string | undefined
  dialogText(tabId: string): Promise<string | undefined>
  answer(tabId: string, reply: string): Promise<string | undefined>
  respond(i: DiscordInteraction, body: unknown): Promise<unknown>
}

export class AskButtons {
  private asks = new Map<string, OpenAsk>()

  constructor(private d: ButtonDeps) {}

  attach(tabId: string, view: DialogView, card: Card): Card {
    this.forget(tabId)
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

  async press(i: DiscordInteraction): Promise<void> {
    if (i.userId !== this.d.owner()) {
      await this.d.respond(i, privately(ONLY_THE_OWNER_ANSWERS))
      return
    }
    const [id, n] = (i.customId ?? '').slice(ID_PREFIX.length).split(':')
    const ask = this.asks.get(id)
    const choice = ask?.choices[Number(n)]
    if (!ask || !choice || (await this.d.dialogText(ask.tabId)) !== ask.text) {
      this.asks.delete(id)
      await this.d.respond(i, privately(NO_LONGER_OPEN))
      return
    }
    const error = await this.d.answer(ask.tabId, choice.reply)
    if (error) {
      await this.d.respond(i, privately(error))
      return
    }
    this.asks.delete(id)
    const answered = cardMessages({ ...ask.card, buttons: [], footer: `-# ✅ ${choice.label}` })
    await this.d.respond(i, { type: UPDATE_MESSAGE, data: answered[answered.length - 1] })
  }

  forget(tabId: string): void {
    for (const [id, ask] of this.asks) if (ask.tabId === tabId) this.asks.delete(id)
  }
}
