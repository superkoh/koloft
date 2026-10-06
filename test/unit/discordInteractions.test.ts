import { describe, it, expect } from 'vitest'
import type { ConductorBinding } from '../../src/shared/types'
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

const binding: ConductorBinding = {
  id: 'b1',
  scope: 'global',
  backend: 'claude',
  channel: { guildId: '1', channelId: CHANNEL, name: 'koloft-all' },
  sessionIds: [],
  touched: []
}

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
  const runs: { session: string; text: string }[] = []
  const pressed: DiscordInteraction[] = []
  const deps: InteractionDeps = {
    owner: () => OWNER,
    routeOf: (c) =>
      c === CHANNEL ? { binding } : c === THREAD ? { binding, sessionKey: 'k1' } : undefined,
    press: async (i) => void pressed.push(i),
    choices: () => [
      { name: 'This channel’s conductor (Global)', value: 'me' },
      { name: 'fix-login · Claude', value: 'k1' },
      { name: 'docs · Codex', value: 'k2' }
    ],
    run: async (_b, session, text) => {
      runs.push({ session, text })
      return `Typing ${text}`
    },
    respond: async (_i, body) => void replies.push(body),
    ...over
  }
  return { interactions: new Interactions(deps), replies, runs, pressed }
}

describe('Discord slash commands', () => {
  it('the owner’s /run types the command into the session picked, and answers at once', async () => {
    const { interactions, replies, runs } = setup()
    await interactions.handle(interaction({ options: { command: ' /context ', session: 'k1' } }))
    expect(runs).toEqual([{ session: 'k1', text: '/context' }])
    expect(replies).toEqual([
      { type: 4, data: { content: 'Typing /context', allowed_mentions: { parse: [] } } }
    ])
  })

  it('with no session picked, the command goes to this channel’s conductor', async () => {
    const { interactions, runs } = setup()
    await interactions.handle(interaction({ command: 'clear' }))
    expect(runs).toEqual([{ session: 'me', text: '/clear' }])
  })

  it('in a session’s thread, with no session picked, the command goes to that session', async () => {
    const { interactions, runs } = setup()
    await interactions.handle(interaction({ channelId: THREAD, command: 'clear' }))
    expect(runs).toEqual([{ session: 'k1', text: '/clear' }])
  })

  it('a button pressed in a channel or thread Koloft knows is handed on as a press, never run as a command', async () => {
    const { interactions, runs, pressed } = setup()
    await interactions.handle(interaction({ channelId: THREAD, type: 3, customId: 'ask:x:0' }))
    await interactions.handle(interaction({ channelId: '999', type: 3, customId: 'ask:y:0' }))
    expect(pressed.map((i) => i.customId)).toEqual(['ask:x:0'])
    expect(runs).toEqual([])
  })

  it('/compact passes its focus on as the command’s argument', async () => {
    const { interactions, runs } = setup()
    await interactions.handle(
      interaction({ command: 'compact', options: { focus: 'keep the test plan' } })
    )
    expect(runs[0].text).toBe('/compact keep the test plan')
  })

  it('someone else gets a refusal only they can see, and nothing runs', async () => {
    const { interactions, replies, runs } = setup()
    await interactions.handle(interaction({ userId: '666', options: { command: '/clear' } }))
    expect(runs).toEqual([])
    expect(replies).toEqual([{ type: 4, data: { content: ONLY_THE_OWNER, flags: 64 } }])
  })

  it('a channel this Koloft has no conductor in gets no answer from it, so another Koloft on the same bot can answer', async () => {
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
        throw new Error('there is no session "nope".')
      }
    })
    await interactions.handle(interaction({ options: { command: '/clear', session: 'nope' } }))
    expect(replies[0]).toMatchObject({
      data: { content: '⚠ there is no session "nope".' }
    })
  })

  it('autocomplete lists the sessions whose name holds what was typed', async () => {
    const { interactions, replies } = setup()
    await interactions.handle(
      interaction({ type: 4, options: { session: 'LOG' }, focused: 'session' })
    )
    expect(replies).toEqual([
      { type: 8, data: { choices: [{ name: 'fix-login · Claude', value: 'k1' }] } }
    ])
  })

  it('autocomplete shows someone else no sessions', async () => {
    const { interactions, replies } = setup()
    await interactions.handle(
      interaction({ type: 4, userId: '666', options: { session: '' }, focused: 'session' })
    )
    expect(replies).toEqual([{ type: 8, data: { choices: [] } }])
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
