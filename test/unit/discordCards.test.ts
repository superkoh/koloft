import { describe, it, expect } from 'vitest'
import {
  cardMessages,
  IS_COMPONENTS_V2,
  SUPPRESS_NOTIFICATIONS,
  TEXT_DISPLAY_LIMIT
} from '../../src/main/discord/cards'

type Container = { components: { type: number; content?: string; components?: unknown[] }[] }

function texts(message: { components: unknown[] }): string[] {
  const [box] = message.components as Container[]
  return box.components.flatMap((c) => (c.content === undefined ? [] : [c.content]))
}

// PLATFORM§39
describe('a card is a Components V2 message', () => {
  it('a body past one text block’s limit goes over several cards: the header on the first, the buttons on the last, and every block within the limit', () => {
    const body = Array.from({ length: 600 }, (_, i) => `line ${i + 1} of a long reply`).join('\n')
    const messages = cardMessages({
      accent: 1,
      header: '🔔 **fix-login** finished.',
      body,
      buttons: [{ label: 'Yes', id: 'ask:1:0', style: 'success' }]
    })
    expect(messages.length).toBeGreaterThan(1)
    expect(texts(messages[0])[0]).toBe('🔔 **fix-login** finished.')
    expect(texts(messages[1])[0]).not.toContain('fix-login** finished')
    for (const m of messages)
      expect(texts(m).reduce((n, t) => n + t.length, 0)).toBeLessThanOrEqual(TEXT_DISPLAY_LIMIT)
    const rows = (m: (typeof messages)[number]): number =>
      (m.components[0] as Container).components.filter((c) => c.type === 1).length
    expect(messages.map(rows)).toEqual([...messages.slice(1).map(() => 0), 1])
    expect(texts(messages.at(-1)!).join('\n')).toContain('line 600 of a long reply')
  })

  it('is flagged as Components V2, and a quiet card also as silent', () => {
    expect(cardMessages({ accent: 1, header: 'h' })[0].flags).toBe(IS_COMPONENTS_V2)
    expect(cardMessages({ accent: 1, header: 'h', silent: true })[0].flags).toBe(
      IS_COMPONENTS_V2 | SUPPRESS_NOTIFICATIONS
    )
  })

  it('rewrites a table in the body the way plain messages are rewritten', () => {
    const [message] = cardMessages({
      accent: 1,
      header: 'h',
      body: '| a | b |\n|---|---|\n| 1 | 2 |'
    })
    expect(texts(message)[1]).toBe('**1**\n> b: 2')
  })
})
