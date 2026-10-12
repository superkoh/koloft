import { describe, it, expect } from 'vitest'
import {
  NO_BOT_PAGE,
  NO_TOKEN_ON_PAGE,
  tokenFromPage,
  type GuestPage
} from '../../src/main/discord/tokenFromPage'

const TOKEN = 'MTQyNzAwMDAwMDAwMDAwMDAw.GabcDe.abcdefghijklmnopqrstuvwxyz0123456789'

function page(url: string, text: string): GuestPage & { ran: number } {
  const p = {
    ran: 0,
    url: () => url,
    run: async (script: string) => {
      p.ran++
      return new Function('document', `return ${script}`)({ body: { innerText: text } })
    }
  }
  return p
}

describe('reading the bot token from the Workbench page', () => {
  it('reads it only from a discord.com Developer Portal Bot page', async () => {
    const bot = page('https://discord.com/developers/applications/700/bot', `Token\n${TOKEN}\nCopy`)
    expect(await tokenFromPage([bot])).toEqual({ token: TOKEN })
  })

  it('never runs anything on another page, even one that shows a token or looks alike', async () => {
    const lookalikes = [
      page('https://discord.com.evil.example/developers/applications/700/bot', TOKEN),
      page('http://discord.com/developers/applications/700/bot', TOKEN),
      page('https://discord.com/developers/applications/700/information', TOKEN),
      page('https://example.com/?u=https://discord.com/developers/applications/700/bot', TOKEN)
    ]
    expect(await tokenFromPage(lookalikes)).toEqual({ error: NO_BOT_PAGE })
    expect(lookalikes.map((p) => p.ran)).toEqual([0, 0, 0, 0])
  })

  it('says so when the Bot page shows no token yet', async () => {
    const bot = page('https://discord.com/developers/applications/700/bot', 'Reset Token')
    expect(await tokenFromPage([bot])).toEqual({ error: NO_TOKEN_ON_PAGE })
  })
})
