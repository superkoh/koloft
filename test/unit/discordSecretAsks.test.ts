import { describe, it, expect } from 'vitest'
import {
  NO_LONGER_WAITING,
  NOTHING_TYPED,
  PASSED_ON,
  SecretAsks,
  type PlacedCard,
  type SecretAskDeps
} from '../../src/main/discord/secretAsks'
import type { Card } from '../../src/main/discord/cards'
import type { DiscordInteraction } from '../../src/main/discord/link'
import { ONLY_THE_OWNER_ANSWERS } from '../../src/main/discord/buttons'

const OWNER = '555'
const SECRET = 'hunter2 "x" \\ 日本'
const LONG = 60_000

function setup(over: Partial<SecretAskDeps> = {}) {
  const cards: Card[] = []
  const edits: Card[] = []
  const responses: unknown[] = []
  const asks = new SecretAsks({
    owner: () => OWNER,
    place: async (_tab, card): Promise<PlacedCard> => {
      cards.push(card('fix-login'))
      return { channelId: 'thread-1', messageId: 'm1', name: 'fix-login' }
    },
    edit: async (_placed, card) => void edits.push(card),
    respond: async (_i, body) => void responses.push(body),
    ...over
  })
  const interaction = (
    type: number,
    over: Partial<DiscordInteraction> = {}
  ): DiscordInteraction => ({
    id: '1',
    token: 't',
    type,
    channelId: 'thread-1',
    userId: OWNER,
    command: '',
    options: {},
    customId: cards[0]?.buttons?.[0].id,
    ...over
  })
  const posted = (): Promise<void> =>
    new Promise((resolve) => {
      const tick = (): void => (cards.length ? resolve() : void setTimeout(tick, 1))
      tick()
    })
  return { asks, cards, edits, responses, interaction, posted }
}

const ask = {
  tabId: 'tab-1',
  header: (n: string) => `🔑 **${n}** asks`,
  body: 'Command: `sudo x`',
  label: 'Your sudo password'
}

describe('asking the owner for a secret in Discord', () => {
  it('the owner presses the card’s button, types in the form, and the asker gets exactly what was typed; it never shows in any message', async () => {
    const { asks, cards, edits, responses, interaction, posted } = setup()
    const answer = asks.ask(ask, LONG)
    await posted()
    expect(cards[0].body).toContain('sudo x')
    await asks.press(interaction(3))
    expect(responses[0]).toMatchObject({
      type: 9,
      data: {
        components: [{ components: [{ type: 4, label: 'Your sudo password', required: true }] }]
      }
    })
    await asks.submit(interaction(5, { fields: { value: SECRET } }))
    expect(await answer).toBe(SECRET)
    expect(responses[1]).toEqual({ type: 4, data: { content: PASSED_ON, flags: 64 } })
    await new Promise((r) => setTimeout(r, 0))
    expect(edits[0].buttons ?? []).toEqual([])
    expect(JSON.stringify([cards, edits, responses])).not.toContain('hunter2')
  })

  it('someone other than the owner can neither open the form nor send one', async () => {
    const { asks, responses, interaction, posted } = setup()
    let settled = false
    void asks.ask(ask, LONG).then(() => (settled = true))
    await posted()
    await asks.press(interaction(3, { userId: '666' }))
    await asks.submit(interaction(5, { userId: '666', fields: { value: SECRET } }))
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(false)
    expect(responses).toEqual([
      { type: 4, data: { content: ONLY_THE_OWNER_ANSWERS, flags: 64 } },
      { type: 4, data: { content: ONLY_THE_OWNER_ANSWERS, flags: 64 } }
    ])
  })

  it('an empty form passes nothing on and keeps waiting', async () => {
    const { asks, responses, interaction, posted } = setup()
    const answer = asks.ask(ask, LONG)
    await posted()
    await asks.submit(interaction(5, { fields: { value: '' } }))
    expect(responses).toEqual([{ type: 4, data: { content: NOTHING_TYPED, flags: 64 } }])
    await asks.submit(interaction(5, { fields: { value: 'x' } }))
    expect(await answer).toBe('x')
  })

  it('with no Discord thread to post in, the asker hears so at once', async () => {
    const { asks } = setup({ place: async () => undefined })
    expect(await asks.ask(ask, LONG)).toBeNull()
  })

  it('past its wait, or once the session closes, the ask ends with nothing, and a later press says so', async () => {
    const timed = setup()
    expect(await timed.asks.ask(ask, 5)).toBeUndefined()
    await timed.asks.press(timed.interaction(3))
    expect(timed.responses).toEqual([{ type: 4, data: { content: NO_LONGER_WAITING, flags: 64 } }])
    const closed = setup()
    const answer = closed.asks.ask(ask, LONG)
    await closed.posted()
    closed.asks.forget('tab-1')
    expect(await answer).toBeUndefined()
  })
})
