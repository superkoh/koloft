import { describe, it, expect } from 'vitest'
import {
  ANSWERED_IN_KOLOFT,
  NO_LONGER_WAITING,
  NOTHING_TYPED,
  PASSED_ON,
  SecretAsks,
  TURNED_DOWN_IN_KOLOFT,
  type PlacedCard,
  type SecretAsk,
  type SecretAskDeps
} from '../../src/main/discord/secretAsks'
import type { Card } from '../../src/main/discord/cards'
import type { DiscordInteraction } from '../../src/main/discord/link'
import type { SecretAskView } from '../../src/shared/types'
import { ONLY_THE_OWNER_ANSWERS } from '../../src/main/discord/buttons'

const OWNER = '555'
const SECRET = 'hunter2 "x" \\ 日本'
const LONG = 60_000
const PLACED: PlacedCard = { channelId: 'thread-1', messageId: 'm1', name: 'fix-login' }

function setup(over: Partial<SecretAskDeps> = {}) {
  const cards: Card[] = []
  const edits: Card[] = []
  const responses: unknown[] = []
  const shown: SecretAskView[][] = []
  const onlyInKoloft: string[] = []
  const ended: string[] = []
  const asks = new SecretAsks({
    owner: () => OWNER,
    cardWanted: () => true,
    place: async (_tab, card): Promise<PlacedCard> => {
      cards.push(card('fix-login'))
      return PLACED
    },
    edit: async (_placed, card) => void edits.push(card),
    respond: async (_i, body) => void responses.push(body),
    show: (views) => void shown.push(views),
    askedOnlyInKoloft: (tabId) => void onlyInKoloft.push(tabId),
    ended: (tabId) => void ended.push(tabId),
    ...over
  })
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
  const posted = (): Promise<void> =>
    new Promise((resolve) => {
      const tick = (): void => (cards.length ? resolve() : void setTimeout(tick, 1))
      tick()
    })
  const lastShown = (): SecretAskView[] => shown.at(-1) ?? []
  return { asks, cards, edits, responses, onlyInKoloft, ended, interaction, posted, lastShown }
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
    const { asks, cards, edits, responses, interaction, posted, lastShown } = setup()
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
    expect(await answer).toEqual({ typed: SECRET })
    expect(responses[1]).toEqual({ type: 4, data: { content: PASSED_ON, flags: 64 } })
    await settle()
    expect(edits[0].buttons ?? []).toEqual([])
    expect(lastShown()).toEqual([])
    expect(JSON.stringify([cards, edits, responses])).not.toContain('hunter2')
  })

  it('someone other than the owner can neither open the form nor send one', async () => {
    const { asks, responses, interaction, posted } = setup()
    let settled = false
    void asks.ask(ask, LONG).then(() => (settled = true))
    await posted()
    await asks.press(interaction(3, { userId: '666' }))
    await asks.submit(interaction(5, { userId: '666', fields: { value: SECRET } }))
    await settle()
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
    expect(await answer).toEqual({ typed: 'x' })
  })

  it('while the owner is at the Mac and the turn did not come from Discord, the ask shows only in Koloft, with no card, and what is typed there reaches the asker', async () => {
    const { asks, cards, onlyInKoloft, ended, lastShown } = setup({ cardWanted: () => false })
    const answer = asks.ask(ask, LONG)
    expect(lastShown()).toMatchObject([{ tabId: 'tab-1', kind: 'sudo', command: 'sudo x' }])
    expect(onlyInKoloft).toEqual(['tab-1'])
    asks.answer(lastShown()[0].id, '')
    asks.answer(lastShown()[0].id, SECRET)
    expect(await answer).toEqual({ typed: SECRET })
    await settle()
    expect(cards).toEqual([])
    expect(ended).toEqual(['tab-1'])
    expect(lastShown()).toEqual([])
  })

  it('with no Discord channel bound, the ask still waits in Koloft instead of being refused', async () => {
    const { asks, lastShown } = setup({ place: async () => undefined })
    const answer = asks.ask(ask, LONG)
    await settle()
    asks.answer(lastShown()[0].id, 'pw')
    expect(await answer).toEqual({ typed: 'pw' })
  })

  it('answered in Koloft first, the card loses its button and says so, and a later press says Koloft no longer waits', async () => {
    const { asks, edits, responses, interaction, posted, lastShown } = setup()
    const answer = asks.ask(ask, LONG)
    await posted()
    asks.answer(lastShown()[0].id, 'pw')
    expect(await answer).toEqual({ typed: 'pw' })
    await settle()
    expect(edits[0].footer).toContain(ANSWERED_IN_KOLOFT)
    expect(edits[0].buttons ?? []).toEqual([])
    await asks.press(interaction(3))
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

  it('a page ask ends once its own page loads another address; a sign-in ask ends only once the page that opened the sign-in lands on an http loopback address', async () => {
    const { asks } = setup({ cardWanted: () => false })
    const page = asks.ask(
      { ...ask, shape: { kind: 'page', guestId: 7, url: 'https://a.example/login', label: 'P' } },
      LONG
    )
    const signInUrl = 'https://auth.example/authorize?x=1'
    const signIn = asks.ask({ ...ask, shape: { kind: 'url', signIn: signInUrl } }, LONG)
    let signedIn = false
    void signIn.then(() => (signedIn = true))
    asks.navigated(8, 'https://a.example/home')
    asks.navigated(9, 'http://localhost:3000/')
    asks.navigationStarted(9, signInUrl)
    asks.navigated(9, 'https://auth.example/consent')
    asks.navigated(10, 'http://localhost:1455/auth/callback?code=c')
    await settle()
    expect(signedIn).toBe(false)
    asks.navigated(7, 'https://a.example/home')
    expect(await page).toEqual({ doneInKoloft: true })
    asks.navigated(9, 'http://127.0.0.1:1455/auth/callback?code=c')
    expect(await signIn).toEqual({ doneInKoloft: true })
  })

  it('an ask from a Workbench shell ends when that shell closes, and one whose tab moves follows it to the new tab', async () => {
    const { asks, lastShown } = setup({ cardWanted: () => false })
    const fromShell = asks.ask({ ...ask, from: 'shell-1' }, LONG)
    asks.forget('shell-1')
    expect(await fromShell).toEqual({ ended: 'timeout' })
    void asks.ask(ask, LONG)
    asks.rehome('tab-1', 'tab-9')
    expect(lastShown()).toMatchObject([{ tabId: 'tab-9' }])
  })

  it('past its wait, or once the session closes, the ask ends with nothing, and a later press says so', async () => {
    const timed = setup()
    expect(await timed.asks.ask(ask, 5)).toEqual({ ended: 'timeout' })
    await timed.asks.press(timed.interaction(3))
    expect(timed.responses).toEqual([{ type: 4, data: { content: NO_LONGER_WAITING, flags: 64 } }])
    const closed = setup()
    const answer = closed.asks.ask(ask, LONG)
    await closed.posted()
    closed.asks.forget('tab-1')
    expect(await answer).toEqual({ ended: 'timeout' })
  })
})
