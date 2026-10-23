import { describe, it, expect, vi } from 'vitest'
import {
  ANSWERED_ON_THE_COMPUTER,
  AskButtons,
  answeredWith,
  NO_LONGER_OPEN,
  ONLY_THE_OWNER_ANSWERS,
  SESSION_CLOSED,
  type ButtonDeps
} from '../../src/main/discord/buttons'
import type { DiscordInteraction } from '../../src/main/discord/link'
import { YES_OR_NO } from '../../src/main/discord/dialog'

const OWNER = '555'
const PLACED = { channelId: '333', messageId: '900' }

function setup(over: Partial<ButtonDeps> = {}) {
  let open: string | undefined = 'Bash asks to run:\nnpm test'
  const answers: { tab: string; reply: string }[] = []
  const responses: unknown[] = []
  const edits: { messageId: string; footer?: string; buttons: number }[] = []
  const buttons = new AskButtons({
    owner: () => OWNER,
    dialogText: async () => open,
    answer: async (tab, reply) => {
      answers.push({ tab, reply })
      return undefined
    },
    respond: async (_i, body) => void responses.push(body),
    edit: async (placed, card) =>
      void edits.push({
        messageId: placed.messageId,
        footer: card.footer,
        buttons: card.buttons?.length ?? 0
      }),
    ...over
  })
  const card = buttons.attach(
    'tab-1',
    { text: 'Bash asks to run:\nnpm test', choices: YES_OR_NO },
    { accent: 1, header: '❓ **fix-login** is waiting for you.', body: 'npm test' }
  )
  const press = (n: number, userId = OWNER): DiscordInteraction => ({
    id: '1',
    token: 't',
    type: 3,
    channelId: '333',
    userId,
    command: '',
    options: {},
    customId: card.buttons![n].id
  })
  return {
    buttons,
    card,
    press,
    answers,
    responses,
    edits,
    close: () => {
      open = undefined
    },
    change: (text: string) => {
      open = text
    }
  }
}

type Update = {
  type: number
  data: { components: { components: { content?: string; type: number }[] }[] }
}

describe('answering a question with a button in Discord', () => {
  it('a press answers that option and turns the card into one that says what was picked, with no buttons left', async () => {
    const { buttons, card, press, answers, responses } = setup()
    expect(card.buttons?.map((b) => b.label)).toEqual(['Yes', 'No'])
    await buttons.press(press(1))
    expect(answers).toEqual([{ tab: 'tab-1', reply: 'no' }])
    const update = responses[0] as Update
    expect(update.type).toBe(7)
    const inside = update.data.components[0].components
    expect(inside.map((c) => c.content).filter(Boolean)).toContain('-# ✅ No')
    expect(inside.some((c) => c.type === 1)).toBe(false)
  })

  it('a press after the question was answered at the Mac, or replaced by another, answers nothing and says so only to the presser', async () => {
    const closed = setup()
    closed.close()
    await closed.buttons.press(closed.press(0))
    const replaced = setup()
    replaced.change('Bash asks to run:\nrm -rf /tmp/x')
    await replaced.buttons.press(replaced.press(0))
    for (const s of [closed, replaced]) {
      expect(s.answers).toEqual([])
      expect(s.responses).toEqual([{ type: 4, data: { content: NO_LONGER_OPEN, flags: 64 } }])
    }
  })

  it('a press on a card whose question was answered at the Mac also takes the buttons off that card', async () => {
    const s = setup()
    s.buttons.placed(s.card, PLACED)
    s.close()
    await s.buttons.press(s.press(0))
    expect(s.edits).toEqual([
      { messageId: '900', footer: `-# ${ANSWERED_ON_THE_COMPUTER}`, buttons: 0 }
    ])
  })

  it('someone other than the owner cannot answer', async () => {
    const { buttons, press, answers, responses } = setup()
    await buttons.press(press(0, '666'))
    expect(answers).toEqual([])
    expect(responses).toEqual([{ type: 4, data: { content: ONLY_THE_OWNER_ANSWERS, flags: 64 } }])
  })

  it('an answer Koloft cannot give is shown only to the presser, and the buttons stay for another try', async () => {
    const { buttons, press, responses } = setup({
      answer: async () => 'a Codex approval takes yes or no.'
    })
    await buttons.press(press(0))
    await buttons.press(press(0))
    expect(responses).toEqual([
      { type: 4, data: { content: 'a Codex approval takes yes or no.', flags: 64 } },
      { type: 4, data: { content: 'a Codex approval takes yes or no.', flags: 64 } }
    ])
  })
})

describe('a question answered some other way loses its buttons too', () => {
  const footers = (s: ReturnType<typeof setup>): (string | undefined)[] =>
    s.edits.map((e) => e.footer)

  it('answered with a message in the channel, or by koloft session answer: once the question closes, the card says that answer and has no buttons', async () => {
    const s = setup()
    s.buttons.placed(s.card, PLACED)
    s.buttons.answered('tab-1', 'run it twice')
    await s.buttons.check('tab-1')
    expect(s.edits).toEqual([])
    s.close()
    await s.buttons.check('tab-1')
    await s.buttons.check('tab-1')
    expect(s.edits).toEqual([
      { messageId: '900', footer: `-# ${answeredWith('run it twice')}`, buttons: 0 }
    ])
  })

  it('answered at the Mac, or replaced by the next question: the card says it was answered on the computer', async () => {
    const atMac = setup()
    atMac.buttons.placed(atMac.card, PLACED)
    atMac.close()
    await atMac.buttons.check('tab-1')
    const replaced = setup()
    replaced.buttons.placed(replaced.card, PLACED)
    replaced.buttons.attach('tab-1', { text: 'next?', choices: YES_OR_NO }, replaced.card)
    for (const s of [atMac, replaced])
      expect(footers(s)).toEqual([`-# ${ANSWERED_ON_THE_COMPUTER}`])
  })

  it('the session closed: the card says so', async () => {
    const s = setup()
    s.buttons.placed(s.card, PLACED)
    s.buttons.forget('tab-1')
    expect(footers(s)).toEqual([`-# ${SESSION_CLOSED}`])
  })

  it('answered before Discord said where the card landed: the card is changed once it is placed', async () => {
    const s = setup()
    s.close()
    await s.buttons.check('tab-1')
    expect(s.edits).toEqual([])
    s.buttons.placed(s.card, PLACED)
    expect(footers(s)).toEqual([`-# ${ANSWERED_ON_THE_COMPUTER}`])
  })

  it('a button press in progress is left to change its own card', async () => {
    let finish!: () => void
    const s = setup({
      answer: () => new Promise((resolve) => (finish = () => resolve(undefined)))
    })
    s.buttons.placed(s.card, PLACED)
    const pressing = s.buttons.press(s.press(1))
    await vi.waitFor(() => expect(finish).toBeDefined())
    s.close()
    await s.buttons.check('tab-1')
    finish()
    await pressing
    expect(s.edits).toEqual([])
    expect((s.responses[0] as Update).type).toBe(7)
  })
})
