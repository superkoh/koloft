import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, osOutlets, quitAndClose } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import {
  clickAppMenuItem,
  startSessionIn,
  terminalText,
  termIds,
  waitBooted,
  waitConductorStarted,
  waitForCalls
} from './helpers/p1'
import { OPEN_A_FORM, startFakeDiscord, type FakeDiscord } from './helpers/fakeDiscord'
import { guestByUrl, guestType } from './helpers/browser'
import { startEchoServer } from './helpers/fixtureServer'

test.setTimeout(180_000)

const OWNER = { id: '555', username: 'letian' }
const CHANNEL = '222'
const CONDUCTOR_STARTS_MS = 60_000

function seedBinding(env: E2EEnv): void {
  seedSettings(env, {
    hintsOff: true,
    assist: { backend: 'claude' },
    discord: {
      userId: OWNER.id,
      userName: OWNER.username,
      channel: { guildId: '111', channelId: CHANNEL, name: 'koloft-all' }
    }
  })
}

async function sessionIn(page: Page, env: E2EEnv, ws: string, nth: number): Promise<string> {
  await startSessionIn(page, ws)
  const sessionId = (await waitForCalls(env, nth))[nth - 1].sessionId
  const all = await page.evaluate(() => window.api.sessions.list())
  return all.find((s) => s.sessionId === sessionId)!.tabId
}

function type(page: Page, tab: string, line: string): Promise<void> {
  return page.evaluate(([id, l]) => window.api.terminal.write(id, l + '\r'), [tab, line])
}

const theWindow = (app: ElectronApplication): Promise<{ count: number; contentsId: number }> =>
  app.evaluate(({ BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows()
    return { count: all.length, contentsId: all[0]?.webContents.id ?? -1 }
  })

async function enter(fake: FakeDiscord, typed: string): Promise<void> {
  const card = (): FakeDiscord['posted'][number] | undefined =>
    fake.posted.find(
      (p) => p.channelId === CHANNEL && /asks you to fill in a field on a web page/.test(p.content)
    )
  await expect.poll(card, { timeout: CONDUCTOR_STARTS_MS }).toBeTruthy()
  const { buttons, channelId } = card()!
  fake.press(OWNER, buttons![0], channelId)
  await expect
    .poll(() => fake.callbacks.find((c) => c.type === OPEN_A_FORM)?.data.custom_id)
    .toBe(buttons![0].id)
  fake.submit(OWNER, buttons![0].id, typed, channelId)
}

test.describe('the red button only hides the Koloft window: what runs in it goes on, and the Dock brings the same window back', () => {
  test('with the window closed, ⌘W closes no tab unseen, another session reads a session’s whole screen, koloft secret page fills a page the owner half filled in before closing, and a click on the Dock shows that same window again, nothing rebuilt', async ({
    env
  }) => {
    seedBinding(env)
    const fake = await startFakeDiscord(env)
    const server = await startEchoServer()
    const app = await launchApp(env)
    try {
      const login = server.page(
        '/login',
        '<!doctype html><title>login</title><form id="f"><input id="user"><label for="pw">Password</label><input type="password" id="pw"></form>' +
          '<script>document.getElementById("f").addEventListener("submit",function(e){e.preventDefault();document.title="submitted:"+document.getElementById("user").value+":"+document.getElementById("pw").value})</script>'
      )
      const page = await app.firstWindow()
      await waitBooted(page)
      await expect.poll(() => fake.identifies).toBe(1)
      await waitConductorStarted(env, CONDUCTOR_STARTS_MS)
      const a = await sessionIn(page, env, 'ws-a', 1)
      const marker = 'printed-before-the-close'
      const shown = `answered: ${marker}`
      await type(page, a, `/answer ${marker}`)
      await expect.poll(() => terminalText(page, a)).toContain(shown)
      await type(page, a, `/koloft open ${login}`)
      const guest = await guestByUrl(app, '/login')
      await guestType(guest, '#user', 'half-filled')
      const b = await sessionIn(page, env, 'ws-b', 2)
      const aSession = (await waitForCalls(env, 2))[0].sessionId
      const before = await theWindow(app)

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
      await expect.poll(async () => (await osOutlets(app)).windowHidden).toBe(true)
      expect(await theWindow(app)).toEqual(before)
      await clickAppMenuItem(app, page, 'close-tab')

      await type(page, b, `/koloft session screen ${aSession}`)
      await expect.poll(() => terminalText(page, b)).toContain('koloft exit=0')
      expect(await terminalText(page, b)).toContain(shown)

      await type(page, a, '/koloft secret page "#pw"')
      await enter(fake, 'hunter2-hidden')
      await expect.poll(() => guest.title()).toBe('submitted:half-filled:hunter2-hidden')

      await app.evaluate(({ app }) => app.emit('activate'))
      await expect.poll(async () => (await osOutlets(app)).windowHidden).toBe(false)
      expect(await theWindow(app)).toEqual(before)
      expect(await termIds(page)).toEqual(expect.arrayContaining([a, b]))
    } finally {
      await quitAndClose(app)
      await fake.close()
      await server.close()
    }
  })
})
