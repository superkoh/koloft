import { afterEach, describe, expect, it } from 'vitest'
import { DISCORD_API_URL, discordApiUrl } from '../../src/main/discord/link'

const saved = {
  api: process.env.KOLOFT_DISCORD_API_URL,
  test: process.env.KOLOFT_TEST_BACKGROUND
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  restore('KOLOFT_DISCORD_API_URL', saved.api)
  restore('KOLOFT_TEST_BACKGROUND', saved.test)
})

describe('which Discord the bot connects to', () => {
  it('a dev build never connects to the real Discord, so it cannot take the released app’s bot', () => {
    delete process.env.KOLOFT_DISCORD_API_URL
    delete process.env.KOLOFT_TEST_BACKGROUND
    expect(discordApiUrl(false)).toBeNull()
    expect(discordApiUrl(true)).toBe(DISCORD_API_URL)
  })

  it('KOLOFT_DISCORD_API_URL is the one way to point any build at a Discord', () => {
    process.env.KOLOFT_DISCORD_API_URL = 'http://127.0.0.1:4100'
    expect(discordApiUrl(false)).toBe('http://127.0.0.1:4100')
    expect(discordApiUrl(true)).toBe('http://127.0.0.1:4100')
  })
})
