import { describe, it, expect } from 'vitest'
import { DISCORD_MESSAGE_LIMIT, splitForDiscord } from '../../src/main/discord/split'

function lines(n: number, width: number): string {
  return Array.from({ length: n }, (_, i) => `${i}`.padEnd(width, 'x')).join('\n')
}

describe('splitForDiscord: every word is sent, in messages Discord accepts', () => {
  it('a text of exactly the limit is one message, and one character more makes two', () => {
    const full = 'a'.repeat(DISCORD_MESSAGE_LIMIT)
    expect(splitForDiscord(full)).toEqual([full])
    const parts = splitForDiscord(full + 'b')
    expect(parts).toHaveLength(2)
    expect(parts.join('')).toBe(full + 'b')
  })

  it('splits at line ends, so joining the parts with newlines gives the text back', () => {
    const text = lines(300, 20)
    const parts = splitForDiscord(text)
    expect(parts.length).toBeGreaterThan(2)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT)
    expect(parts.join('\n')).toBe(text)
  })

  it('closes a code block at the end of one message and reopens it, with its language, at the start of the next', () => {
    const code = lines(200, 30)
    const text = `Here is the patch:\n\`\`\`ts\n${code}\n\`\`\`\nDone.`
    const parts = splitForDiscord(text)
    expect(parts.length).toBeGreaterThan(2)
    for (const [i, p] of parts.entries()) {
      expect(p.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT)
      expect(p.split('\n').filter((l) => l.startsWith('```')).length % 2).toBe(0)
      if (i > 0) expect(p.startsWith('```ts\n')).toBe(true)
    }
    const unwrapped = parts
      .map((p, i) => {
        let s = p
        if (i > 0) s = s.slice('```ts\n'.length)
        if (i < parts.length - 1) s = s.slice(0, -'\n```'.length)
        return s
      })
      .join('\n')
    expect(unwrapped).toBe(text)
  })

  it('cuts a line longer than a message, and a Chinese text, into full parts with nothing lost', () => {
    const chinese = '这是一段很长的中文回复。'.repeat(400)
    const parts = splitForDiscord(chinese)
    expect(parts.length).toBeGreaterThan(2)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT)
    expect(parts.join('')).toBe(chinese)
  })

  it('never cuts an emoji in half', () => {
    const text = 'a' + '😀'.repeat(DISCORD_MESSAGE_LIMIT)
    const parts = splitForDiscord(text)
    expect(parts.join('')).toBe(text)
    for (const p of parts) expect(p).not.toMatch(/[\uD800-\uDBFF]$/)
  })

  it('sends nothing for an empty or blank reply', () => {
    expect(splitForDiscord('')).toEqual([])
    expect(splitForDiscord('\n  \n')).toEqual([])
  })
})
