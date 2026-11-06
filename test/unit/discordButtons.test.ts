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
import { ANSWER_NOT_TAKEN } from '../../src/main/discord/relay'

const OWNER = '555'
const PLACED = { channelId: '333', messageId: '900' }

function setup(over: Partial<ButtonDeps> = {}) {
  let open: string | undefined = 'Bash asks to run:\nnpm test'
  const answers: { tab: string; reply: string }[] = []
  const responses: unknown[] = []
  const followUps: string[] = []
  const edits: { messageId: string; footer?: string; buttons: number }[] = []
  const buttons = new AskButtons({
    owner: () => OWNER,
    dialogText: async () => open,
    answer: async (tab, reply) => {
      answers.push({ tab, reply })
      return undefined
    },
    respond: async (_i, body) => void responses.push(body),
    followUp: async (_i, text) => void followUps.push(text),
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
    followUps,
    edits,
    close: () => {
      open = undefined
    },
    change: (text: string) => {
      open = text
    }
  }
}

const UPDATE_LATER = { type: 6 }

describe('answering a question with a button in Discord', () => {
  it('a press is acknowledged before the session has taken the answer, and once it has, the card says what was picked, with no buttons left', async () => {
    let taken!: () => void
    const s = setup({
      answer: async () => new Promise((resolve) => (taken = () => resolve(undefined)))
    })
    expect(s.card.buttons?.map((b) => b.label)).toEqual(['Yes', 'No'])
    s.buttons.placed(s.card, PLACED)
    const pressing = s.buttons.press(s.press(1))
    await vi.waitFor(() => expect(taken).toBeDefined())
    expect(s.responses).toEqual([UPDATE_LATER])
    expect(s.edits).toEqual([])
    taken()
    await pressing
    expect(s.edits).toEqual([{ messageId: '900', footer: '-# ✅ No', buttons: 0 }])
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

  it('an answer Koloft cannot give, or one the session did not take, is shown only to the presser, and the buttons stay for another try', async () => {
    const s = setup({ answer: async () => ANSWER_NOT_TAKEN })
    s.buttons.placed(s.card, PLACED)
    await s.buttons.press(s.press(0))
    await s.buttons.press(s.press(0))
    expect(s.responses).toEqual([UPDATE_LATER, UPDATE_LATER])
    expect(s.followUps).toEqual([ANSWER_NOT_TAKEN, ANSWER_NOT_TAKEN])
    expect(s.edits).toEqual([])
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

  it('the session closed: the card says so, or says the answer already sent from Discord', async () => {
    const closed = setup()
    closed.buttons.placed(closed.card, PLACED)
    closed.buttons.forget('tab-1')
    expect(footers(closed)).toEqual([`-# ${SESSION_CLOSED}`])
    const answeredFirst = setup()
    answeredFirst.buttons.placed(answeredFirst.card, PLACED)
    answeredFirst.buttons.answered('tab-1', 'yes')
    answeredFirst.buttons.attach('tab-1', { text: 'next?', choices: YES_OR_NO }, answeredFirst.card)
    expect(footers(answeredFirst)).toEqual([`-# ${answeredWith('yes')}`])
  })

  it('a card Discord never took is forgotten, so nothing is kept for it', async () => {
    const s = setup()
    s.buttons.placed(s.card, undefined)
    s.close()
    await s.buttons.check('tab-1')
    s.buttons.placed(s.card, PLACED)
    expect(s.edits).toEqual([])
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
    expect(s.edits).toEqual([{ messageId: '900', footer: '-# ✅ No', buttons: 0 }])
  })
})
