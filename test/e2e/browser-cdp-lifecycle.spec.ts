import type { Browser, ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import {
  clickAppMenuItem,
  killSession,
  processAlive,
  startSessionIn,
  waitBooted,
  waitForCalls
} from './helpers/p1'
import {
  BROWSER,
  BROWSER_MENU_IDS,
  cdpEndpointOf,
  cdpRefusal,
  connectCdp,
  guestByUrl,
  openBrowser,
  openTabs,
  openViaAgent
} from './helpers/browser'
import { openSettings } from './helpers/extensions'
import { startEchoServer } from './helpers/fixtureServer'

test.describe('CDP client lifecycle: the user always wins, and a connected client is always told', () => {
  const endpointOf = cdpEndpointOf

  async function session(page: Page, env: E2EEnv, ws: string): Promise<string> {
    await waitBooted(page)
    await startSessionIn(page, ws)
    return await endpointOf(env)
  }

  const connect = connectCdp

  async function guestGrips(
    app: ElectronApplication
  ): Promise<{ url: string; devtools: boolean; attached: boolean }[]> {
    return app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((w) => w.getType() === 'webview')
        .map((w) => ({
          url: w.getURL(),
          devtools: w.isDevToolsOpened(),
          attached: w.debugger.isAttached()
        }))
    )
  }

  // PLATFORM§16
  test('BB-50: DevTools open on a tab does not lock the agent out of it', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      const url = await session(page, env, 'ws-a')
      await openViaAgent(page, server.page('/guarded', '<title>Guarded</title><body>g</body>'))
      await openBrowser(page)
      await page.locator(BROWSER.tabAgent).click()
      await guestByUrl(app, '/guarded')
      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.devtools)
      await expect
        .poll(async () => (await guestGrips(app)).some((g) => g.devtools), { timeout: 30_000 })
        .toBe(true)

      const browser = await connect(page, url)
      try {
        const seen = browser.contexts()[0].pages()
        expect(seen.length).toBeGreaterThanOrEqual(1)
        const guarded = seen.find((p) => p.url().includes('/guarded'))
        expect(guarded).toBeTruthy()
        expect(await guarded!.title()).toBe('Guarded')

        const grips = (await guestGrips(app)).filter((g) => g.url.includes('/guarded'))
        expect(grips).toHaveLength(1)
        expect(grips[0]).toMatchObject({ devtools: true, attached: true })
      } finally {
        await browser.close().catch(() => {})
      }
    } finally {
      await server.close()
    }
  })

  // PLATFORM§16
  test('BB-51: opening DevTools on a driven page takes it from neither side', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      const url = await session(page, env, 'ws-a')
      const browser = await connect(page, url)
      try {
        const ctx = browser.contexts()[0]
        const driven = await ctx.newPage()
        await driven.goto(server.page('/driven', '<title>Driven</title><body>d</body>'))
        expect(await driven.title()).toBe('Driven')

        await openBrowser(page)
        await openTabs(page).first().click()
        await expect(page.locator(BROWSER.tabActive)).toHaveCount(1, { timeout: 30_000 })
        await clickAppMenuItem(app, page, BROWSER_MENU_IDS.devtools)
        await expect
          .poll(async () => (await guestGrips(app)).some((g) => g.devtools), { timeout: 30_000 })
          .toBe(true)

        await driven.goto(server.page('/after', '<title>After</title><body>a</body>'))
        expect(await driven.title()).toBe('After')
        expect(browser.isConnected()).toBe(true)

        await expect(page.locator(BROWSER.drivenTab)).toHaveCount(1, { timeout: 30_000 })
      } finally {
        await browser.close().catch(() => {})
      }
    } finally {
      await server.close()
    }
  })

  test('BB-23: turning browser control off drops the live connection at once, not at its next command', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const url = await session(page, env, 'ws-a')
    const browser = await connect(page, url)
    const closed = new Promise<void>((r) => browser.on('disconnected', () => r()))
    try {
      await browser.contexts()[0].newPage()

      await openSettings(page)
      await page.locator('.set-ni', { hasText: 'Extensions' }).click()
      await page
        .locator('.set-row', { hasText: 'Let agents drive this Browser' })
        .locator('button[role="switch"], input[type="checkbox"], .switch')
        .first()
        .click()

      await closed
      expect(browser.isConnected()).toBe(false)
    } finally {
      await browser.close().catch(() => {})
    }
  })

  test('BB-30: a client sees only its own session’s tabs', async ({ app, page, env }) => {
    test.setTimeout(300_000)
    await withTwoSessions(page, env, async (a, b) => {
      const clientA = await connect(page, a)
      const clientB = await connect(page, b)
      try {
        const pageA = await clientA.contexts()[0].newPage()
        await pageA.goto('about:blank#a-only')
        const pageB = await clientB.contexts()[0].newPage()
        await pageB.goto('about:blank#b-only')

        const urlsA = clientA
          .contexts()[0]
          .pages()
          .map((p) => p.url())
          .join(' ')
        const urlsB = clientB
          .contexts()[0]
          .pages()
          .map((p) => p.url())
          .join(' ')
        expect(urlsA).toContain('a-only')
        expect(urlsA).not.toContain('b-only')
        expect(urlsB).toContain('b-only')
        expect(urlsB).not.toContain('a-only')
      } finally {
        await clientA.close()
        await clientB.close()
      }
    })
  })

  test('BB-62: the user can close a driven tab; the client is told, and its next command errors instead of hanging', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      const url = await session(page, env, 'ws-a')
      const browser = await connect(page, url)
      try {
        const p = await browser.contexts()[0].newPage()
        await p.goto(server.url('/a'))
        await openBrowser(page)
        await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })

        const gone = new Promise<void>((r) => p.on('close', () => r()))
        await page.locator(BROWSER.tabClose).first().click()

        await gone
        await expect(openTabs(page)).toHaveCount(0, { timeout: 30_000 })
        expect(browser.isConnected()).toBe(true)
        await expect(p.title()).rejects.toThrow()
      } finally {
        await browser.close().catch(() => {})
      }
    } finally {
      await server.close()
    }
  })

  test('BB-49: closing the Koloft tab closes its endpoint for good', async ({ app, page, env }) => {
    test.setTimeout(240_000)
    const url = await session(page, env, 'ws-a')
    const browser = await connect(page, url)
    const closed = new Promise<void>((r) => browser.on('disconnected', () => r()))
    try {
      await browser.contexts()[0].newPage()
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('shortcut:close-tab')
      })

      await closed
      expect(await cdpRefusal(url)).toEqual({ code: 1008, reason: 'unknown endpoint' })
    } finally {
      await browser.close().catch(() => {})
    }
  })

  async function withTwoSessions(
    page: Page,
    env: E2EEnv,
    fn: (a: string, b: string) => Promise<void>
  ): Promise<void> {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const a = await endpointOf(env)

    await startSessionIn(page, 'ws-b')
    const b = await endpointOf(env)
    expect(b).not.toBe(a)

    await fn(a, b)
  }
})
