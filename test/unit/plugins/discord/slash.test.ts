import { describe, it, expect } from 'vitest'
import { toChannel } from '../../../../src/plugins/discord/main/slash'
import { accentOf, CONDUCTOR_ACCENT, type Card } from '../../../../src/plugins/discord/main/cards'

describe('a slash command run from Discord', () => {
  it('posts its result card in the butler’s colour for the butler and in the session’s own colour for any other', () => {
    const accents: Card['accent'][] = []
    const to = toChannel('222', () => ({
      say: () => undefined,
      card: async (_id, card) => void accents.push(card.accent)
    }))
    to.result({ target: { name: 'Alfred', tabId: 't1', overseer: true }, header: 'h', body: 'b' })
    to.result({
      target: { name: 'fix-login', tabId: 't2', overseer: false },
      header: 'h',
      body: 'b'
    })
    expect(accents).toEqual([CONDUCTOR_ACCENT, accentOf('fix-login')])
  })
})
