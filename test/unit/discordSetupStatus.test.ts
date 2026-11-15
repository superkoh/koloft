import { describe, it, expect } from 'vitest'
import { setupStatusText } from '../../src/main/discord/setupSteps'
import type { DiscordPhase } from '../../src/shared/types'

function tokenLine(phase: DiscordPhase): string | undefined {
  return setupStatusText({ phase, guilds: [], failing: {} }, {})
    .split('\n')
    .find((l) => l.startsWith('Bot token:'))
}

describe('koloft discord status', () => {
  it('tells the setup task a saved token Discord refuses apart from a good one, so it gets a new token instead of skipping that step', () => {
    expect(tokenLine('off')).toBe('Bot token: not saved')
    expect(tokenLine('token')).toBe('Bot token: saved, but Discord refuses it')
    expect(tokenLine('connected')).toBe('Bot token: saved')
  })
})
