import { describe, it, expect } from 'vitest'
import {
  AskButtons,
  NO_LONGER_OPEN,
  ONLY_THE_OWNER_ANSWERS,
  type ButtonDeps
} from '../../src/main/discord/buttons'
import type { DiscordInteraction } from '../../src/main/discord/link'
import { YES_OR_NO } from '../../src/main/discord/dialog'

const OWNER = '555'

function setup(over: Partial<ButtonDeps> = {}) {
  let open: string | undefined = 'Bash asks to run:\nnpm test'
  const answers: { tab: string; reply: string }[] = []
  const responses: unknown[] = []
  const buttons = new AskButtons({
    owner: () => OWNER,
    dialogText: async () => open,
    answer: async (tab, reply) => {
      answers.push({ tab, reply })
      return undefined
    },
    respond: async (_i, body) => void responses.push(body),
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
