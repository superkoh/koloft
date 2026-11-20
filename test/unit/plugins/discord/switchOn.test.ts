import { describe, expect, it } from 'vitest'
import {
  switchedOnOnceItHasABot,
  withDiscordAsBefore
} from '../../../../src/plugins/discord/main/switchOn'

const aBot = async (): Promise<boolean> => true
const noBot = async (): Promise<boolean> => false

describe('Discord is switched on once Koloft has a bot for it', () => {
  it('an owner upgrading with a bot token saved but no channel bound and the switch never touched gets Discord on', async () => {
    expect(await switchedOnOnceItHasABot({ todo: false }, aBot)).toBe(true)
  })

  it('an owner who turned Discord off keeps it off without the keychain being read, and one with no bot is left as the default has it', async () => {
    const neverAsked = async (): Promise<boolean> => {
      throw new Error('read the keychain')
    }
    expect(await switchedOnOnceItHasABot({ discord: false }, neverAsked)).toBe(false)
    expect(await switchedOnOnceItHasABot({}, noBot)).toBe(false)
  })
})

describe('a Discord setup that could not start puts back only the Discord switch', () => {
  it('Discord goes back to what it was, or to never set, and a switch changed meanwhile stays as changed', () => {
    const now = { discord: true, todo: false }
    expect(withDiscordAsBefore(now, { discord: false, todo: true })).toEqual({
      discord: false,
      todo: false
    })
    expect(withDiscordAsBefore(now, { todo: true })).toEqual({ todo: false })
  })
})
