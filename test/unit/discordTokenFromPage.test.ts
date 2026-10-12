import { describe, it, expect } from 'vitest'
import {
  NO_BOT_PAGE,
  NO_TOKEN_ON_PAGE,
  SAVED,
  saveTokenFromPage,
  STILL_ATTACHED,
  type GuestPage
} from '../../src/main/discord/tokenFromPage'

const TOKEN = 'MTQyNzAwMDAwMDAwMDAwMDAw.GabcDe.abcdefghijklmnopqrstuvwxyz0123456789'
const BOT = 'https://discord.com/developers/applications/700/bot'

function page(url: string, text: string): GuestPage & { ran: number; reloads: number } {
  const p = {
    ran: 0,
    reloads: 0,
    url: () => url,
    run: async (script: string) => {
      p.ran++
      return new Function('document', `return ${script}`)({ body: { innerText: text } })
    },
    reload: () => {
      p.reloads++
    }
  }
  return p
}

function saver(): { save: (t: string) => Promise<boolean>; saved: string[] } {
  const saved: string[] = []
  return {
    saved,
    save: async (t) => {
      saved.push(t)
      return true
    }
  }
}

describe('saving the bot token from the Workbench page', () => {
  it('reads it from the Bot page, saves it, then reloads the page so no later snapshot can show it', async () => {
    const bot = page(BOT, `Token\n${TOKEN}\nCopy`)
    const { save, saved } = saver()
    expect(await saveTokenFromPage([bot], false, save)).toBe(SAVED)
    expect(saved).toEqual([TOKEN])
    expect(bot.reloads).toBe(1)
  })

  it('refuses while a tool is still attached to the browser, and reads nothing', async () => {
    const bot = page(BOT, TOKEN)
    const { save, saved } = saver()
    expect(await saveTokenFromPage([bot], true, save)).toBe(STILL_ATTACHED)
    expect([bot.ran, saved.length]).toEqual([0, 0])
  })

  it('never runs anything on another page, even one that shows a token or looks alike', async () => {
    const lookalikes = [
      page('https://discord.com.evil.example/developers/applications/700/bot', TOKEN),
      page('http://discord.com/developers/applications/700/bot', TOKEN),
      page('https://discord.com/developers/applications/700/information', TOKEN),
      page('https://example.com/?u=https://discord.com/developers/applications/700/bot', TOKEN)
    ]
    const { save, saved } = saver()
    expect(await saveTokenFromPage(lookalikes, false, save)).toBe(NO_BOT_PAGE)
    expect(lookalikes.map((p) => p.ran)).toEqual([0, 0, 0, 0])
    expect(saved).toEqual([])
  })

  it('says so when the Bot page shows no token yet', async () => {
    const bot = page(BOT, 'Reset Token')
    expect(await saveTokenFromPage([bot], false, saver().save)).toBe(NO_TOKEN_ON_PAGE)
    expect(bot.reloads).toBe(0)
  })
})
