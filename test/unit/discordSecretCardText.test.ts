import { describe, expect, it } from 'vitest'
import {
  SecretAsks,
  type PlacedCard,
  type SecretAsk,
  type TapRounds
} from '../../src/main/discord/secretAsks'
import type { Card } from '../../src/main/discord/cards'
import type { DiscordInteraction } from '../../src/main/discord/link'

const OWNER = '555'
const PLACED: PlacedCard = { channelId: 'thread-1', messageId: 'm1', name: 'fix-login' }
const LONG = 60_000
const PRESS = 3
const SUBMIT = 5

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const settleLong = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await settle()
}

const withoutIds = (text: string): string =>
  text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')

const cardText = (c: Card): string =>
  [
    `  header: ${c.header}`,
    `  body: ${c.body ?? ''}`,
    `  footer: ${c.footer ?? ''}`,
    `  buttons: ${(c.buttons ?? []).map((b) => `${b.label} [${b.style}] ${withoutIds(b.id)}`).join(' | ')}`
  ].join('\n')

function discord(placeFails: (n: number, files: number) => boolean = () => false) {
  const said: string[] = []
  const placed: Card[] = []
  let places = 0
  const asks = new SecretAsks({
    owner: () => OWNER,
    cardWanted: () => true,
    place: async (_tab, card, files) => {
      if (placeFails(places++, files?.length ?? 0)) throw new Error('Discord answered 500')
      const c = card('fix-login')
      placed.push(c)
      said.push(`card with ${files?.length ?? 0} file(s):\n${cardText(c)}`)
      return PLACED
    },
    edit: async (_placed, card) => void said.push(`card edited:\n${cardText(card)}`),
    respond: async (_i, body) => void said.push(`reply: ${withoutIds(JSON.stringify(body))}`),
    show: () => undefined,
    askedOnlyInKoloft: () => undefined,
    ended: () => undefined
  })
  const button = (label: string): string =>
    placed.at(-1)!.buttons!.find((b) => b.label === label)!.id
  const interaction = (
    type: number,
    customId: string,
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
    customId,
    ...over
  })
  return { asks, said, button, interaction, placed }
}

const SUDO: SecretAsk = {
  tabId: 'tab-1',
  from: 'tab-1',
  shape: { kind: 'sudo', command: 'sudo x', prompt: 'Password:' },
  header: (n) => `HEADER(${n})`,
  body: 'BODY',
  label: 'LABEL'
}

const PICTURE = { file: { name: 'page.png', data: Buffer.from('png') }, seen: () => undefined }

const tapAsk = (taps: TapRounds): SecretAsk => ({
  ...SUDO,
  shape: { kind: 'tap', guestId: 7, url: 'https://x.test/', label: 'Tick the box.' },
  taps
})

const pin = (said: string[], name: string): Promise<void> =>
  expect(said.join('\n') + '\n').toMatchFileSnapshot(`./discord-secret-card-text/${name}.txt`)

describe('the full text of the Discord card that asks the owner for a secret, pinned so that moving it changes no character', () => {
  it('a typed secret: the card, its form, an empty form, someone else, the answer, and a press after it', async () => {
    const d = discord()
    void d.asks.ask(SUDO, LONG)
    await settleLong()
    const enter = d.button('Enter it')
    await d.asks.press(d.interaction(PRESS, enter, { userId: '666' }))
    await d.asks.press(d.interaction(PRESS, enter))
    await d.asks.submit(d.interaction(SUBMIT, enter, { fields: { value: '' } }))
    await d.asks.submit(d.interaction(SUBMIT, enter, { fields: { value: 'pw' } }))
    await settleLong()
    await d.asks.press(d.interaction(PRESS, enter))
    await pin(d.said, 'typed')
  })

  it('each way an ask ends without a typed answer on Discord', async () => {
    const said: string[] = []
    for (const [name, end] of [
      ['answered in Koloft', (a: SecretAsks) => a.answer(a.views()[0].id, 'pw')],
      ['done in Koloft', (a: SecretAsks) => a.done(a.views()[0].id)],
      ['turned down in Koloft', (a: SecretAsks) => a.decline(a.views()[0].id)],
      ['the session closed', (a: SecretAsks) => a.forget('tab-1')]
    ] as const) {
      const d = discord()
      void d.asks.ask({ ...SUDO, shape: { kind: 'url', signIn: 'https://a.example' } }, LONG)
      await settleLong()
      end(d.asks)
      await settleLong()
      said.push(`# ${name}`, ...d.said)
    }
    const timed = discord()
    await timed.asks.ask(SUDO, 5)
    await settleLong()
    said.push('# no answer in time', ...timed.said)
    await pin(said, 'ended')
  })

  it('a tap ask: its card, its form, a new picture, taps, taps still running, failures, and both ends', async () => {
    let letGo!: () => void
    const held = new Promise<void>((r) => (letGo = r))
    let picture = 0
    const d = discord()
    void d.asks.ask(
      tapAsk({
        picture: async () => {
          if (picture++ === 2) throw new Error('the page is gone')
          return PICTURE
        },
        tap: async (squares) => {
          if (squares === 'Z9') throw new Error('Z9 is off the page')
          await held
          return `Tapped ${squares}.`
        }
      }),
      LONG
    )
    await settleLong()
    await d.asks.press(d.interaction(PRESS, d.button('Tap squares')))
    await d.asks.submit(d.interaction(SUBMIT, d.button('Tap squares'), { fields: { value: 'A1' } }))
    await d.asks.press(d.interaction(PRESS, d.button('New picture')))
    await d.asks.submit(d.interaction(SUBMIT, d.button('Tap squares'), { fields: { value: 'A1' } }))
    letGo()
    await settleLong()
    await d.asks.press(d.interaction(PRESS, d.button('New picture')))
    await settleLong()
    await d.asks.submit(d.interaction(SUBMIT, d.button('Tap squares'), { fields: { value: 'Z9' } }))
    await settleLong()
    await d.asks.press(d.interaction(PRESS, d.button('It passed')))
    await settleLong()
    const gaveUp = discord()
    void gaveUp.asks.ask(tapAsk({ picture: async () => PICTURE, tap: async () => '' }), LONG)
    await settleLong()
    await gaveUp.asks.press(gaveUp.interaction(PRESS, gaveUp.button('Give up')))
    await settleLong()
    const noPicture = discord((n, files) => n > 0 && files > 0)
    void noPicture.asks.ask(
      tapAsk({ picture: async () => PICTURE, tap: async () => 'Tapped A1.' }),
      LONG
    )
    await settleLong()
    await noPicture.asks.submit(
      noPicture.interaction(SUBMIT, noPicture.button('Tap squares'), { fields: { value: 'A1' } })
    )
    await settleLong()
    await pin(
      [
        ...d.said,
        '# given up',
        ...gaveUp.said,
        '# Discord does not take the new picture',
        ...noPicture.said
      ],
      'tap'
    )
  })
})
