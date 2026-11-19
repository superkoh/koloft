import { describe, expect, it } from 'vitest'
import { switchedOnOnceItHasABot } from '../../../../src/plugins/discord/main/switchOn'

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
