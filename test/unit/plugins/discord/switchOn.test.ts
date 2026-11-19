import { describe, expect, it } from 'vitest'
import { switchedOnOnceItHasABot } from '../../../../src/plugins/discord/main/switchOn'

describe('Discord is switched on once Koloft has a bot for it', () => {
  it('an owner upgrading with a bot token saved but no channel bound and the switch never touched gets Discord on, other switches kept', () => {
    expect(switchedOnOnceItHasABot(true, { todo: false })).toEqual({ todo: false, discord: true })
  })

  it('an owner who turned Discord off keeps it off, and one with no bot is left as the default has it', () => {
    expect(switchedOnOnceItHasABot(true, { discord: false })).toBeNull()
    expect(switchedOnOnceItHasABot(false, {})).toBeNull()
  })
})
