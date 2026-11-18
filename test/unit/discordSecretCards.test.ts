import { describe, it, expect, vi } from 'vitest'
import {
  A_CARD_REACHES_DISCORD_WITHIN_MS,
  ANSWERED_IN_KOLOFT,
  NO_LONGER_WAITING,
  NOTHING_TYPED,
  PASSED_ON,
  SecretCards,
  TURNED_DOWN_IN_KOLOFT,
  type PlacedCard,
  type SecretCardDeps,
  type TapRounds
} from '../../src/main/discord/secretCards'
import { SecretAsks, type SecretAsk } from '../../src/plugins/passwords/main/secretAsks'
import type { Card } from '../../src/main/discord/cards'
import type { DiscordInteraction } from '../../src/main/discord/link'
import type { SecretAskView } from '../../src/shared/types'
import { ONLY_THE_OWNER_ANSWERS } from '../../src/main/discord/buttons'

const OWNER = '555'
const SECRET = 'hunter2 "x" \\ 日本'
const LONG = 60_000
const PLACED: PlacedCard = { channelId: 'thread-1', messageId: 'm1', name: 'fix-login' }

type AskWithTaps = SecretAsk & { taps?: TapRounds }

function setup(over: Partial<SecretCardDeps> = {}) {
  const cards: Card[] = []
  const edits: Card[] = []
  const responses: unknown[] = []
  const shown: SecretAskView[][] = []
  const onlyInKoloft: string[] = []
  const asks = new SecretAsks<AskWithTaps>({
    show: (views) => void shown.push(views),
    owner: {
      waitsOnTheOwner: (tabId) => void onlyInKoloft.push(tabId),
      ownerAnswered: () => undefined
    }
  })
  const secretCards = new SecretCards({
    asks,
    owner: () => OWNER,
    cardWanted: () => true,
    place: async (_tab, card): Promise<PlacedCard> => {
      cards.push(card('fix-login'))
      return PLACED
    },
    edit: async (_placed, card) => void edits.push(card),
    respond: async (_i, body) => void responses.push(body),
    ...over
  })
  asks.listen(secretCards)
  const interaction = (
    type: number,
    over: Partial<DiscordInteraction> = {}
  ): DiscordInteraction => ({
    id: '1',
    applicationId: '700',
    token: 't',
    type,
    channelId: 'thread-1',
    userId: OWNER,
    command: '',
    options: {},
    customId: cards[0]?.buttons?.[0].id,
    ...over
  })
  const until = (done: () => boolean): Promise<void> =>
    new Promise((resolve) => {
      const tick = (): void => (done() ? resolve() : void setTimeout(tick, 1))
      tick()
    })
  const posted = (): Promise<void> => until(() => cards.length > 0)
  const marked = (): Promise<void> => until(() => onlyInKoloft.length > 0)
  const lastShown = (): SecretAskView[] => shown.at(-1) ?? []
  return {
    asks,
    secretCards,
    cards,
    edits,
    responses,
    onlyInKoloft,
    interaction,
    posted,
    marked,
    lastShown
  }
}

const ask: SecretAsk = {
  tabId: 'tab-1',
  from: 'tab-1',
  shape: { kind: 'sudo', command: 'sudo x', prompt: 'Password:' },
  header: (n: string) => `🔑 **${n}** asks`,
  body: 'Command: `sudo x`',
  label: 'Your sudo password'
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('asking the owner for a secret, in Koloft and in Discord', () => {
  it('the owner presses the card’s button, types in the form, and the asker gets exactly what was typed; it never shows in any message', async () => {
    const { asks, secretCards, cards, edits, responses, interaction, posted, lastShown } = setup()
    const answer = asks.ask(ask, LONG)
    await posted()
    expect(cards[0].body).toContain('sudo x')
    await secretCards.press(interaction(3))
    expect(responses[0]).toMatchObject({
      type: 9,
      data: {
        components: [{ components: [{ type: 4, label: 'Your sudo password', required: true }] }]
      }
    })
    await secretCards.submit(interaction(5, { fields: { value: SECRET } }))
    expect(await answer).toEqual({ typed: SECRET })
    expect(responses[1]).toEqual({ type: 4, data: { content: PASSED_ON, flags: 64 } })
    await settle()
    expect(edits[0].buttons ?? []).toEqual([])
    expect(lastShown()).toEqual([])
    expect(JSON.stringify([cards, edits, responses])).not.toContain('hunter2')
  })

  it('someone other than the owner can neither open the form nor send one', async () => {
    const { asks, secretCards, responses, interaction, posted } = setup()
    let settled = false
    void asks.ask(ask, LONG).then(() => (settled = true))
    await posted()
    await secretCards.press(interaction(3, { userId: '666' }))
    await secretCards.submit(interaction(5, { userId: '666', fields: { value: SECRET } }))
    await settle()
    expect(settled).toBe(false)
    expect(responses).toEqual([
      { type: 4, data: { content: ONLY_THE_OWNER_ANSWERS, flags: 64 } },
      { type: 4, data: { content: ONLY_THE_OWNER_ANSWERS, flags: 64 } }
    ])
  })

  it('an empty form passes nothing on and keeps waiting', async () => {
    const { asks, secretCards, responses, interaction, posted } = setup()
    const answer = asks.ask(ask, LONG)
    await posted()
    await secretCards.submit(interaction(5, { fields: { value: '' } }))
    expect(responses).toEqual([{ type: 4, data: { content: NOTHING_TYPED, flags: 64 } }])
    await secretCards.submit(interaction(5, { fields: { value: 'x' } }))
    expect(await answer).toEqual({ typed: 'x' })
  })

  it('while the owner is at the Mac and the turn did not come from Discord, no card goes up and the session is marked as waiting on the owner in Koloft', async () => {
    const { asks, cards, onlyInKoloft, lastShown } = setup({ cardWanted: () => false })
    const answer = asks.ask(ask, LONG)
    expect(onlyInKoloft).toEqual(['tab-1'])
    asks.answer(lastShown()[0].id, SECRET)
    expect(await answer).toEqual({ typed: SECRET })
    await settle()
    expect(cards).toEqual([])
  })

  it('with no Discord channel bound, the ask still waits in Koloft instead of being refused', async () => {
    const { asks, lastShown } = setup({ place: async () => undefined })
    const answer = asks.ask(ask, LONG)
    await settle()
    asks.answer(lastShown()[0].id, 'pw')
    expect(await answer).toEqual({ typed: 'pw' })
  })

  it('answered in Koloft first, the card loses its button and says so, and a later press says Koloft no longer waits', async () => {
    const { asks, secretCards, edits, responses, interaction, posted, lastShown } = setup()
    const answer = asks.ask(ask, LONG)
    await posted()
    asks.answer(lastShown()[0].id, 'pw')
    expect(await answer).toEqual({ typed: 'pw' })
    await settle()
    expect(edits[0].footer).toContain(ANSWERED_IN_KOLOFT)
    expect(edits[0].buttons ?? []).toEqual([])
    await secretCards.press(interaction(3))
    expect(responses).toEqual([{ type: 4, data: { content: NO_LONGER_WAITING, flags: 64 } }])
  })

  it('a card still being posted when Koloft is answered is marked answered as soon as it lands', async () => {
    let land!: (p: PlacedCard) => void
    const { asks, edits, lastShown } = setup({
      place: () => new Promise((resolve) => (land = resolve))
    })
    const answer = asks.ask(ask, LONG)
    asks.answer(lastShown()[0].id, 'pw')
    expect(await answer).toEqual({ typed: 'pw' })
    expect(edits).toEqual([])
    land(PLACED)
    await settle()
    expect(edits[0].footer).toContain(ANSWERED_IN_KOLOFT)
    expect(edits[0].buttons ?? []).toEqual([])
  })

  it('turned down in Koloft, the asker hears so and the card says it was turned down', async () => {
    const { asks, edits, posted, lastShown } = setup()
    const answer = asks.ask(ask, LONG)
    await posted()
    asks.decline(lastShown()[0].id)
    expect(await answer).toEqual({ ended: 'declined' })
    await settle()
    expect(edits[0].footer).toContain(TURNED_DOWN_IN_KOLOFT)
  })

  it('past its wait, or once the session closes, the ask ends with nothing, and a later press says so', async () => {
    const timed = setup()
    expect(await timed.asks.ask(ask, 5)).toEqual({ ended: 'timeout' })
    await timed.secretCards.press(timed.interaction(3))
    expect(timed.responses).toEqual([{ type: 4, data: { content: NO_LONGER_WAITING, flags: 64 } }])
    const closed = setup()
    const answer = closed.asks.ask(ask, LONG)
    await closed.posted()
    closed.asks.forget('tab-1')
    expect(await answer).toEqual({ ended: 'timeout' })
  })
})

describe('asking the owner to tap a page from Discord, in rounds', () => {
  const PICTURE = { file: { name: 'page.png', data: Buffer.from('png') }, seen: () => undefined }
  const tapAsk = (taps: TapRounds): AskWithTaps => ({
    tabId: 'tab-1',
    from: 'tab-1',
    shape: { kind: 'tap', guestId: 7, url: 'https://x.test/', label: 'Tick the box.' },
    header: (n: string) => `👆 **${n}** asks you to tap a web page`,
    body: 'Tick the box.',
    label: 'Squares to tap, in order',
    taps
  })
  const button = (cards: Card[], label: string): string =>
    cards[0].buttons!.find((b) => b.label === label)!.id

  it('a Give up pressed while the taps run stops the taps still to come', async () => {
    let letGo!: () => void
    const held = new Promise<void>((r) => (letGo = r))
    const tapped: string[] = []
    const { asks, secretCards, cards, interaction, posted } = setup()
    const answer = asks.ask(
      tapAsk({
        picture: async () => PICTURE,
        tap: async (squares, going) => {
          for (const square of squares.split(' ')) {
            if (!going()) break
            tapped.push(square)
            await held
          }
          return 'Tapped.'
        }
      }),
      LONG
    )
    await posted()
    await secretCards.submit(interaction(5, { fields: { value: 'A1 B1 C1' } }))
    await settle()
    await secretCards.press(interaction(3, { customId: button(cards, 'Give up') }))
    letGo()
    await settle()
    expect(await answer).toEqual({ ended: 'declined' })
    expect(tapped).toEqual(['A1'])
  })

  it('once the asking tab moves, the next picture goes where the tab now is', async () => {
    const tabs: string[] = []
    const { asks, secretCards, cards, interaction, posted } = setup({
      place: async (tab, card): Promise<PlacedCard> => {
        tabs.push(tab)
        cards.push(card('fix-login'))
        return PLACED
      }
    })
    void asks.ask(tapAsk({ picture: async () => PICTURE, tap: async () => 'Tapped.' }), LONG)
    await posted()
    asks.rehome('tab-1', 'tab-9')
    await secretCards.press(interaction(3, { customId: button(cards, 'New picture') }))
    await settle()
    await settle()
    expect(tabs).toEqual(['tab-1', 'tab-9'])
  })

  it('when the next card cannot be posted at all, the card before keeps its buttons', async () => {
    let placed = 0
    const { asks, secretCards, cards, edits, interaction, posted } = setup({
      place: async (_tab, card): Promise<PlacedCard> => {
        if (placed++) throw new Error('Discord answered 500')
        cards.push(card('fix-login'))
        return PLACED
      }
    })
    void asks.ask(tapAsk({ picture: async () => PICTURE, tap: async () => 'Tapped A1.' }), LONG)
    await posted()
    await secretCards.submit(interaction(5, { fields: { value: 'A1' } }))
    await settle()
    await settle()
    expect(placed).toBe(3)
    expect(edits).toEqual([])
  })

  it('when Discord does not take the new picture, the card still comes, says so, and the squares named next are read on the picture the owner last saw', async () => {
    let shownPictures = 0
    let placed = 0
    const { asks, secretCards, cards, interaction, posted } = setup({
      place: async (_tab, card, files): Promise<PlacedCard> => {
        if (placed++ && files?.length) throw new Error('Discord answered 413')
        cards.push(card('fix-login'))
        return PLACED
      }
    })
    void asks.ask(
      tapAsk({
        picture: async () => ({ ...PICTURE, seen: () => void shownPictures++ }),
        tap: async () => 'Tapped A1.'
      }),
      LONG
    )
    await posted()
    await secretCards.submit(interaction(5, { fields: { value: 'A1' } }))
    await settle()
    await settle()
    expect(cards).toHaveLength(2)
    expect(cards[1].footer).toMatch(/Discord did not take the page's picture/)
    expect(shownPictures).toBe(1)
  })

  it('two presses of New picture close together take one new picture, and the second is told to wait', async () => {
    let pictures = 0
    const { asks, secretCards, cards, responses, interaction, posted } = setup()
    void asks.ask(
      tapAsk({
        picture: async () => {
          pictures++
          return PICTURE
        },
        tap: async () => 'Tapped.'
      }),
      LONG
    )
    await posted()
    const press = interaction(3, { customId: button(cards, 'New picture') })
    await Promise.all([secretCards.press(press), secretCards.press(press)])
    await settle()
    expect(pictures).toBe(2)
    expect(JSON.stringify(responses)).toMatch(/still at the last taps/)
  })

  it('once the ask has ended while the first card was still uploading, a failed upload posts no second card and marks nothing', async () => {
    let fail!: (e: Error) => void
    let places = 0
    const { asks, onlyInKoloft, lastShown } = setup({
      place: (): Promise<PlacedCard> => {
        places++
        return places === 1
          ? new Promise((_resolve, reject) => (fail = reject))
          : Promise.resolve(PLACED)
      }
    })
    const answer = asks.ask(
      tapAsk({ picture: async () => PICTURE, tap: async () => 'Tapped.' }),
      LONG
    )
    await settle()
    expect(places).toBe(1)
    asks.decline(lastShown()[0].id)
    expect(await answer).toEqual({ ended: 'declined' })
    fail(new Error('Discord answered 413'))
    await settle()
    await settle()
    expect(places).toBe(1)
    expect(onlyInKoloft).toEqual([])
  })

  it('a tap card counts as not taken only when neither the picture nor the card without it goes up', async () => {
    const tapsWith = (fails: (files: unknown[] | undefined) => boolean) => {
      const t = setup({
        place: async (_tab, card, files): Promise<PlacedCard> => {
          if (fails(files)) throw new Error('Discord answered 413')
          t.cards.push(card('fix-login'))
          return PLACED
        }
      })
      void t.asks.ask(tapAsk({ picture: async () => PICTURE, tap: async () => 'Tapped.' }), LONG)
      return t
    }
    const pictureRefused = tapsWith((files) => !!files?.length)
    await pictureRefused.posted()
    expect(pictureRefused.onlyInKoloft).toEqual([])
    const allRefused = tapsWith(() => true)
    await allRefused.marked()
    expect(allRefused.onlyInKoloft).toEqual(['tab-1'])
  })
})

describe('a secret card Discord does not take', () => {
  it('a card that goes up keeps Koloft quiet; one Discord does not take marks the session as waiting on the owner in Koloft, where the ask still waits', async () => {
    const taken = setup()
    void taken.asks.ask(ask, LONG)
    await taken.posted()
    expect(taken.onlyInKoloft).toEqual([])

    const refused = setup({
      place: async () => {
        throw new Error('Discord answered 403')
      }
    })
    const answer = refused.asks.ask(ask, LONG)
    await refused.marked()
    expect(refused.onlyInKoloft).toEqual(['tab-1'])
    refused.asks.answer(refused.lastShown()[0].id, 'pw')
    expect(await answer).toEqual({ typed: 'pw' })
  })

  it('an ask that moved to another tab before its card failed marks the tab it is in now', async () => {
    let fail!: (e: Error) => void
    const { asks, onlyInKoloft, marked } = setup({
      place: () => new Promise((_resolve, reject) => (fail = reject))
    })
    void asks.ask(ask, LONG)
    asks.rehome('tab-1', 'tab-9')
    fail(new Error('Discord answered 404'))
    await marked()
    expect(onlyInKoloft).toEqual(['tab-9'])
  })

  it('a card Discord has neither taken nor refused within its time marks the session in Koloft once, even when Discord refuses it later', async () => {
    vi.useFakeTimers()
    try {
      let fail!: (e: Error) => void
      const { asks, onlyInKoloft } = setup({
        place: () => new Promise((_resolve, reject) => (fail = reject))
      })
      void asks.ask(ask, 2 * A_CARD_REACHES_DISCORD_WITHIN_MS)
      await vi.advanceTimersByTimeAsync(A_CARD_REACHES_DISCORD_WITHIN_MS - 1)
      expect(onlyInKoloft).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(onlyInKoloft).toEqual(['tab-1'])
      fail(new Error('Discord answered 403'))
      await vi.advanceTimersByTimeAsync(1)
      expect(onlyInKoloft).toEqual(['tab-1'])
    } finally {
      vi.useRealTimers()
    }
  })
})
