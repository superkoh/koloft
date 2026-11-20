import { describe, it, expect, vi } from 'vitest'
import {
  CHANGED,
  CHANGED_MEANWHILE,
  CHANGED_ON_THE_COMPUTER,
  INSTRUCTIONS_ID_PREFIX,
  InstructionCards,
  NOT_CHANGED_ON_THE_COMPUTER,
  SESSION_STOPPED_WAITING,
  STOPPED_WAITING,
  type InstructionCardDeps
} from '../../../../src/plugins/discord/main/instructionCards'
import { InstructionAsks } from '../../../../src/plugins/sessions/main/instructionAsks'
import type { InstructionAsk } from '../../../../src/plugins/sessions/main/instructionAsks'
import { cardMessages, type Card } from '../../../../src/plugins/discord/main/cards'
import type { PlacedCard } from '../../../../src/plugins/discord/main/secretCards'
import { NO_LONGER_WAITING } from '../../../../src/plugins/discord/main/secretCards'
import { privately, type DiscordInteraction } from '../../../../src/plugins/discord/main/link'
import { HELD_ASKS_CHECKED_EVERY_MS } from '../../../../src/plugins/discord/main/relay'
import {
  ONLY_THE_OWNER_ANSWERS,
  SESSION_CLOSED,
  UPDATE_MESSAGE_LATER
} from '../../../../src/plugins/discord/main/buttons'
import { DISCORD_TURNED_OFF } from '../../../../src/plugins/discord/main/switchOn'

const OWNER = '555'
const LONG = 60_000
const PLACED: PlacedCard = { channelId: 'lobby', messageId: 'm1', name: 'Alfred' }
const ASK: InstructionAsk = {
  tabId: 'tab-1',
  by: 'Alfred',
  what: "Alfred's instructions",
  before: 'Answer me in Chinese, short.',
  after: 'Answer me in Chinese, short.\nAsk me before any session merges a pull request.'
}

function setup(over: Partial<InstructionCardDeps> = {}) {
  const cards: Card[] = []
  const edits: Card[] = []
  const responses: unknown[] = []
  let text = ASK.before
  const asks = new InstructionAsks({
    show: () => undefined,
    owner: { waitsOnTheOwner: () => undefined, ownerAnswered: () => undefined },
    told: () => undefined
  })
  const instructionCards = new InstructionCards({
    asks,
    owner: () => OWNER,
    cardWanted: () => true,
    place: async (_tab, card) => {
      cards.push(card(PLACED.name))
      return PLACED
    },
    edit: async (_placed, card) => void edits.push(card),
    respond: async (_i, body) => void responses.push(body),
    ...over
  })
  asks.listen(instructionCards)
  const ask = (a: InstructionAsk = ASK, waitMs = LONG) =>
    asks.ask(a, waitMs, async () => {
      if (text !== a.before) return false
      text = a.after
      return true
    })
  const press = (button: number, userId = OWNER): Promise<void> =>
    instructionCards.press({
      id: '1',
      applicationId: '700',
      token: 't',
      type: 3,
      channelId: PLACED.channelId,
      userId,
      command: '',
      options: {},
      customId: cards[0].buttons![button].id
    } as DiscordInteraction)
  const until = (done: () => boolean): Promise<void> =>
    new Promise((resolve) => {
      const tick = (): void => (done() ? resolve() : void setTimeout(tick, 1))
      tick()
    })
  return {
    asks,
    instructionCards,
    cards,
    edits,
    responses,
    ask,
    press,
    until,
    text: () => text,
    changeTextTo: (t: string) => (text = t),
    lastFooter: () => edits.at(-1)?.footer,
    lastButtons: () => edits.at(-1)?.buttons ?? []
  }
}

describe('an agent asks to change the Instructions, and the owner answers on a Discord card', () => {
  it("shows the same change as the box at the Mac: who wants to change which block, the summary, each line marked, and the box's two buttons", async () => {
    const s = setup()
    void s.ask()
    await s.until(() => s.cards.length > 0)
    const [card] = s.cards
    expect(card.header).toBe('❓ **Alfred** is waiting for you.')
    expect(card.body).toBe(
      [
        "Alfred wants to change Alfred's instructions: 1 line added.",
        '```diff',
        '  Answer me in Chinese, short.',
        '+ Ask me before any session merges a pull request.',
        '```'
      ].join('\n')
    )
    expect(card.footer).toBe(
      '-# Nothing changes until you agree. Sessions started afterwards follow the new text.'
    )
    expect(card.buttons?.map((b) => [b.label, b.style])).toEqual([
      ["Don't change", 'secondary'],
      ['Change them', 'success']
    ])
    expect(card.buttons?.every((b) => b.id.startsWith(INSTRUCTIONS_ID_PREFIX))).toBe(true)
  })

  it('Change them on the phone writes the text, and only then does the card say Changed and lose its buttons', async () => {
    const s = setup()
    const given = s.ask()
    await s.until(() => s.cards.length > 0)
    await s.press(1)
    expect(s.responses).toEqual([{ type: UPDATE_MESSAGE_LATER }])
    expect(await given).toBe('agreed')
    expect(s.text()).toBe(ASK.after)
    await s.until(() => s.edits.length > 0)
    expect(s.lastFooter()).toBe(`-# ${CHANGED}`)
    expect(s.lastButtons()).toEqual([])
  })

  it("Don't change on the phone writes nothing", async () => {
    const s = setup()
    const given = s.ask()
    await s.until(() => s.cards.length > 0)
    await s.press(0)
    expect(await given).toBe('declined')
    expect(s.text()).toBe(ASK.before)
    expect(s.lastFooter()).toBe('-# ⏹ Not changed.')
  })

  it('an answer at the Mac ends the card with what was answered there', async () => {
    for (const [agreed, footer] of [
      [true, CHANGED_ON_THE_COMPUTER],
      [false, NOT_CHANGED_ON_THE_COMPUTER]
    ] as const) {
      const s = setup()
      const given = s.ask()
      await s.until(() => s.cards.length > 0)
      s.asks.answer(s.asks.views()[0].id, agreed)
      await given
      await s.until(() => s.edits.length > 0)
      expect(s.lastFooter()).toBe(`-# ${footer}`)
    }
  })

  it('agreed while the text changed elsewhere: nothing is written, and the card says so', async () => {
    const s = setup()
    const given = s.ask()
    await s.until(() => s.cards.length > 0)
    s.changeTextTo('The owner rewrote it meanwhile.')
    await s.press(1)
    expect(await given).toBe('changed-meanwhile')
    expect(s.text()).toBe('The owner rewrote it meanwhile.')
    await s.until(() => s.edits.length > 0)
    expect(s.lastFooter()).toBe(`-# ${CHANGED_MEANWHILE}`)
  })

  it('names how the ask ended when nobody answered it: Koloft stopped waiting, the session closed, or the session stopped waiting', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      const timedOut = s.ask(ASK, 1000)
      await vi.advanceTimersByTimeAsync(1000)
      expect(await timedOut).toBe('timeout')
      expect(s.lastFooter()).toBe(`-# ${STOPPED_WAITING}`)
      const closed = s.ask()
      await vi.advanceTimersByTimeAsync(0)
      s.asks.forget(ASK.tabId)
      expect(await closed).toBe('closed')
      expect(s.lastFooter()).toBe(`-# ${SESSION_CLOSED}`)
      let waiting = true
      const stopped = s.asks.ask(
        ASK,
        LONG,
        async () => true,
        () => waiting
      )
      await vi.advanceTimersByTimeAsync(0)
      waiting = false
      await vi.advanceTimersByTimeAsync(5000)
      expect(await stopped).toBe('closed')
      expect(s.lastFooter()).toBe(`-# ${SESSION_STOPPED_WAITING}`)
    } finally {
      vi.useRealTimers()
    }
  })

  it('only the paired owner can answer, and a card whose ask is over answers privately that Koloft no longer waits', async () => {
    const s = setup()
    const given = s.ask()
    await s.until(() => s.cards.length > 0)
    await s.press(1, 'someone-else')
    expect(s.responses).toEqual([privately(ONLY_THE_OWNER_ANSWERS)])
    expect(s.text()).toBe(ASK.before)
    s.asks.answer(s.asks.views()[0].id, false)
    await given
    await s.press(1)
    expect(s.responses.at(-1)).toEqual(privately(NO_LONGER_WAITING))
    expect(s.text()).toBe(ASK.before)
  })

  it('while the owner is at the Mac no card is posted; once the owner is away, the next check posts it', async () => {
    vi.useFakeTimers()
    try {
      let away = false
      const s = setup({ cardWanted: () => away })
      void s.ask(ASK, 10 * HELD_ASKS_CHECKED_EVERY_MS)
      await vi.advanceTimersByTimeAsync(HELD_ASKS_CHECKED_EVERY_MS)
      expect(s.cards).toEqual([])
      away = true
      await vi.advanceTimersByTimeAsync(HELD_ASKS_CHECKED_EVERY_MS)
      expect(s.cards).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says whether a session’s ask has a card on Discord, so the butler’s digest can leave it out: posted, on its way, or none when the card could not be posted', async () => {
    let land!: (placed: PlacedCard | undefined) => void
    const landing = (): Promise<PlacedCard | undefined> =>
      new Promise((resolve) => (land = resolve))
    const s = setup({ place: () => landing() })
    expect(s.instructionCards.onDiscord(ASK.tabId)).toBeUndefined()
    void s.ask()
    expect(s.instructionCards.onDiscord(ASK.tabId)).toBe('posting')
    land(PLACED)
    await s.until(() => s.instructionCards.onDiscord(ASK.tabId) === 'posted')
    expect(s.instructionCards.onDiscord('another-tab')).toBeUndefined()

    const failed = setup({ place: () => landing() })
    void failed.ask()
    land(undefined)
    await failed.until(() => failed.instructionCards.onDiscord(ASK.tabId) === undefined)
  })

  it('an ask answered at the Mac before the owner left never reaches Discord', async () => {
    vi.useFakeTimers()
    try {
      let away = false
      const s = setup({ cardWanted: () => away })
      const given = s.ask()
      s.asks.answer(s.asks.views()[0].id, true)
      await given
      away = true
      await vi.advanceTimersByTimeAsync(HELD_ASKS_CHECKED_EVERY_MS)
      expect(s.cards).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('an ask that ends while its card is still on its way changes the card once it lands', async () => {
    let land!: () => void
    const landed = new Promise<void>((resolve) => (land = resolve))
    const cards: Card[] = []
    const s = setup({
      place: async (_tab, card) => {
        cards.push(card(PLACED.name))
        await landed
        return PLACED
      }
    })
    const given = s.ask()
    await s.until(() => cards.length > 0)
    s.asks.answer(s.asks.views()[0].id, false)
    await given
    expect(s.edits).toEqual([])
    land()
    await s.until(() => s.edits.length > 0)
    expect(s.lastFooter()).toBe(`-# ${NOT_CHANGED_ON_THE_COMPUTER}`)
  })

  it('turning Discord off ends every open card while the ask goes on at the Mac; turned on again, a still open ask gets a new card', async () => {
    vi.useFakeTimers()
    try {
      let on = true
      const s = setup({ cardWanted: () => on })
      const given = s.ask(ASK, 10 * HELD_ASKS_CHECKED_EVERY_MS)
      await vi.advanceTimersByTimeAsync(0)
      on = false
      await s.instructionCards.endAll(DISCORD_TURNED_OFF)
      expect(s.lastFooter()).toBe(`-# ${DISCORD_TURNED_OFF}`)
      expect(s.lastButtons()).toEqual([])
      expect(s.asks.views()).toHaveLength(1)
      on = true
      await vi.advanceTimersByTimeAsync(HELD_ASKS_CHECKED_EVERY_MS)
      expect(s.cards).toHaveLength(2)
      expect(s.cards[1].buttons).toHaveLength(2)
      s.asks.answer(s.asks.views()[0].id, true)
      expect(await given).toBe('agreed')
      expect(s.lastFooter()).toBe(`-# ${CHANGED_ON_THE_COMPUTER}`)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a card that could not be posted is not posted again, even while another ask waits for the owner to leave', async () => {
    vi.useFakeTimers()
    try {
      const tries: string[] = []
      const s = setup({
        cardWanted: (tab) => tab !== 'held-tab',
        place: async (tab) => {
          tries.push(tab)
          return undefined
        }
      })
      void s.ask({ ...ASK, tabId: 'held-tab' }, 10 * HELD_ASKS_CHECKED_EVERY_MS)
      void s.ask(ASK, 10 * HELD_ASKS_CHECKED_EVERY_MS)
      await vi.advanceTimersByTimeAsync(3 * HELD_ASKS_CHECKED_EVERY_MS)
      expect(tries).toEqual([ASK.tabId])
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows only the unchanged lines next to a change, so one added line in long instructions stays one short card', async () => {
    const s = setup()
    const long = Array.from({ length: 40 }, (_, n) => `Rule ${n + 1}.`)
    const before = long.join('\n')
    const after = [...long.slice(0, 20), 'A new rule.', ...long.slice(20)].join('\n')
    void s.ask({ ...ASK, before, after })
    await s.until(() => s.cards.length > 0)
    expect(s.cards[0].body!.split('\n').slice(1)).toEqual([
      '```diff',
      '  …',
      '  Rule 18.',
      '  Rule 19.',
      '  Rule 20.',
      '+ A new rule.',
      '  Rule 21.',
      '  Rule 22.',
      '  Rule 23.',
      '  …',
      '```'
    ])
  })

  it('a write that failed ends the card with its error on one line', async () => {
    const s = setup()
    const given = s.asks.ask(ASK, LONG, async () => {
      throw new Error('Koloft cannot reach this machine now.\nssh: connect timed out')
    })
    await s.until(() => s.cards.length > 0)
    await s.press(1)
    await expect(given).rejects.toThrow()
    expect(s.lastFooter()).toBe('-# ⚠ Koloft cannot reach this machine now. ssh: connect timed out')
  })

  it('a line holding three backticks cannot close the diff block early, and a change too long for one message keeps the block open into the next, buttons on the last', async () => {
    const s = setup()
    const fence = 'Wrap code in ``` fences.'
    const long = Array.from({ length: 120 }, (_, n) => `Rule ${n}: ${'x'.repeat(40)}`).join('\n')
    void s.ask({ ...ASK, after: `${ASK.before}\n${fence}\n\`\`\`\n${long}` })
    await s.until(() => s.cards.length > 0)
    const body = s.cards[0].body!
    expect(body.split('\n').filter((l) => l.includes('```'))).toEqual(['```diff', '```'])
    const messages = cardMessages(s.cards[0]).map((m) => JSON.stringify(m))
    expect(messages.length).toBeGreaterThan(1)
    for (const m of messages.slice(1)) expect(m).toContain('```diff')
    expect(messages.at(-1)).toContain('Change them')
    expect(messages.slice(0, -1).some((m) => m.includes('Change them'))).toBe(false)
  })
})
