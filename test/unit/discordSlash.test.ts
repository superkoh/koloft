import { describe, it, expect } from 'vitest'
import { toChannel } from '../../src/main/discord/slash'
import { accentOf, CONDUCTOR_ACCENT, type Card } from '../../src/main/discord/cards'

function channel() {
  const said: [string, string][] = []
  const cards: [string, Card][] = []
  const to = toChannel('222', () => ({
    say: (id, text) => void said.push([id, text]),
    card: async (id, card) => void cards.push([id, card])
  }))
  return { to, said, cards }
}

describe('a slash command run from Discord', () => {
  it('says it will post what the command prints in Discord', () => {
    expect(channel().to.where).toBe('post what it prints in Discord')
  })

  it('posts its result as a card in the channel, in the butler’s colour for the butler and the session’s own colour for any other', () => {
    const { to, said, cards } = channel()
    to.say('⚠ gone')
    to.result({ target: { name: 'Alfred', tabId: 't1', butler: true }, header: 'h', body: 'b' })
    to.result({ target: { name: 'fix-login', tabId: 't2', butler: false }, header: 'h', body: 'b' })
    expect(said).toEqual([['222', '⚠ gone']])
    expect(cards).toEqual([
      ['222', { accent: CONDUCTOR_ACCENT, header: 'h', body: 'b' }],
      ['222', { accent: accentOf('fix-login'), header: 'h', body: 'b' }]
    ])
  })
})
