import { describe, it, expect } from 'vitest'
import {
  Interactions,
  ONLY_THE_OWNER,
  SLASH_COMMANDS,
  type InteractionDeps
} from '../../src/main/discord/interactions'
import { interactionOf, sameCommand, type DiscordInteraction } from '../../src/main/discord/link'

const OWNER = '555'
const CHANNEL = '222'
const THREAD = '333'

function interaction(over: Partial<DiscordInteraction>): DiscordInteraction {
  return {
    id: '9',
    token: 'tok',
    type: 2,
    channelId: CHANNEL,
    userId: OWNER,
    command: 'run',
    options: {},
    ...over
  }
}

function setup(over: Partial<InteractionDeps> = {}) {
  const replies: unknown[] = []
  const runs: string[] = []
  const pressed: DiscordInteraction[] = []
  const submitted: DiscordInteraction[] = []
  const deps: InteractionDeps = {
    owner: () => OWNER,
    isButlerChannel: (c) => c === CHANNEL,
    press: async (i) => void pressed.push(i),
    submit: async (i) => void submitted.push(i),
    run: async (text) => {
      runs.push(text)
      return `Typing ${text}`
    },
    respond: async (_i, body) => void replies.push(body),
    ...over
  }
  return { interactions: new Interactions(deps), replies, runs, pressed, submitted }
}

describe('Discord slash commands', () => {
  it('the owner’s /run types the command into the butler, and answers at once', async () => {
    const { interactions, replies, runs } = setup()
    await interactions.handle(interaction({ options: { command: ' /context ' } }))
    expect(runs).toEqual(['/context'])
    expect(replies).toEqual([
      { type: 4, data: { content: 'Typing /context', allowed_mentions: { parse: [] } } }
    ])
  })

  it('/clear goes to the butler', async () => {
    const { interactions, runs } = setup()
    await interactions.handle(interaction({ command: 'clear' }))
    expect(runs).toEqual(['/clear'])
  })

  it('none of the commands asks which session: they all go to the butler', () => {
    expect(SLASH_COMMANDS.flatMap((c) => c.options ?? []).map((o) => o.name)).toEqual([
      'command',
      'focus'
    ])
  })

  it('a button pressed in the butler’s channel is handed on as a press, never run as a command; one anywhere else is left alone', async () => {
    const { interactions, runs, pressed } = setup()
    await interactions.handle(interaction({ type: 3, customId: 'ask:x:0' }))
    await interactions.handle(interaction({ channelId: THREAD, type: 3, customId: 'ask:y:0' }))
    expect(pressed.map((i) => i.customId)).toEqual(['ask:x:0'])
    expect(runs).toEqual([])
  })

  it('a form sent in the butler’s channel is handed on as a submission, never run as a command; one anywhere else is left alone', async () => {
    const { interactions, runs, pressed, submitted } = setup()
    await interactions.handle(interaction({ type: 5, customId: 'secret:x' }))
    await interactions.handle(interaction({ channelId: THREAD, type: 5, customId: 'secret:y' }))
    expect(submitted.map((i) => i.customId)).toEqual(['secret:x'])
    expect(pressed).toEqual([])
    expect(runs).toEqual([])
  })

  it('/compact passes its focus on as the command’s argument', async () => {
    const { interactions, runs } = setup()
    await interactions.handle(
      interaction({ command: 'compact', options: { focus: 'keep the test plan' } })
    )
    expect(runs[0]).toBe('/compact keep the test plan')
  })

  it('someone else gets a refusal only they can see, and nothing runs', async () => {
    const { interactions, replies, runs } = setup()
    await interactions.handle(interaction({ userId: '666', options: { command: '/clear' } }))
    expect(runs).toEqual([])
    expect(replies).toEqual([{ type: 4, data: { content: ONLY_THE_OWNER, flags: 64 } }])
  })

  it('a channel that is not this Koloft’s butler’s gets no answer from it, so another Koloft on the same bot can answer', async () => {
    const { interactions, replies } = setup()
    await interactions.handle(interaction({ channelId: '999', options: { command: '/clear' } }))
    expect(replies).toEqual([])
  })

  it('a /run whose text is not a slash command is refused privately', async () => {
    const { interactions, replies, runs } = setup()
    await interactions.handle(interaction({ options: { command: 'compact please' } }))
    expect(runs).toEqual([])
    expect(replies[0]).toMatchObject({ data: { flags: 64 } })
  })

  it('a failure to start answers with the reason instead of leaving Discord with no reply', async () => {
    const { interactions, replies } = setup({
      run: async () => {
        throw new Error('Alfred could not start.')
      }
    })
    await interactions.handle(interaction({ options: { command: '/clear' } }))
    expect(replies[0]).toMatchObject({
      data: { content: '⚠ Alfred could not start.' }
    })
  })
})

describe('reading an interaction from the Gateway', () => {
  it('takes the user from member in a server, and marks the option being typed', () => {
    expect(
      interactionOf({
        id: '1',
        token: 't',
        type: 4,
        channel_id: CHANNEL,
        member: { user: { id: OWNER } },
        data: {
          name: 'run',
          options: [
            { name: 'command', value: '/x' },
            { name: 'session', value: 'fi', focused: true }
          ]
        }
      })
    ).toEqual({
      id: '1',
      token: 't',
      type: 4,
      channelId: CHANNEL,
      userId: OWNER,
      command: 'run',
      options: { command: '/x', session: 'fi' },
      focused: 'session'
    })
  })

  it('a button press carries its custom id and no command name', () => {
    expect(
      interactionOf({
        id: '2',
        token: 't',
        type: 3,
        channel_id: CHANNEL,
        member: { user: { id: OWNER } },
        data: { custom_id: 'ask:x:1' }
      })
    ).toMatchObject({ type: 3, command: '', customId: 'ask:x:1' })
  })

  it('a sent form carries its custom id and what was typed in each box, exactly', () => {
    const typed = 'p@ss "w" \\ 日本'
    expect(
      interactionOf({
        id: '3',
        token: 't',
        type: 5,
        channel_id: THREAD,
        member: { user: { id: OWNER } },
        data: {
          custom_id: 'secret:x',
          components: [{ components: [{ custom_id: 'value', value: typed }] }]
        }
      })
    ).toMatchObject({ type: 5, customId: 'secret:x', fields: { value: typed } })
  })

  it('a command Discord already has with the same shape is not created again', () => {
    const [run] = SLASH_COMMANDS
    const asDiscordKeepsIt = {
      ...run,
      id: '42',
      version: '7',
      options: run.options?.map((o) => ({ ...o, required: o.required ?? false }))
    }
    expect(sameCommand(asDiscordKeepsIt, run)).toBe(true)
    expect(sameCommand({ ...run, description: 'changed' }, run)).toBe(false)
  })
})
