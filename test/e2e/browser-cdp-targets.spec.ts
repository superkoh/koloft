import { chromium, type Browser, type Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { setGuestLimit, type E2EEnv } from './helpers/env'
import { centerTerm, runIn, startSessionIn, waitBooted } from './helpers/p1'
import {
  BROWSER,
  addressField,
  cdpEndpointOf,
  closeBrowser,
  crashGuest,
  guestContents,
  newWebTab,
  openBrowser,
  openTabs,
  openViaAgent,
  tabByTitle,
  typeInAddressBar
} from './helpers/browser'
import { startEchoServer } from './helpers/fixtureServer'

test.describe('CDP target list: what a client is shown, what it costs, and what happens when the tab runs a new session', () => {
  interface RawClient {
    send(method: string, params?: unknown, sessionId?: string): Promise<Record<string, unknown>>
    close(): void
  }

  async function bareWebSocketClientThatNeverAutoAttaches(
    page: Page,
    url: string
  ): Promise<RawClient> {
    const ws = new WebSocket(url)
    const pending = new Map<number, (msg: Record<string, unknown>) => void>()
    let id = 0
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data)) as Record<string, unknown>
      if (typeof msg.id === 'number') pending.get(msg.id)?.(msg)
    })
    const open = new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', () => reject(new Error('the endpoint refused the connection')))
    })
    await open
    return {
      send: (method, params, sessionId) =>
        new Promise((resolve) => {
          id += 1
          pending.set(id, resolve)
          ws.send(JSON.stringify({ id, method, params: params ?? {}, sessionId }))
        }),
      close: () => ws.close()
    }
  }

  async function session(page: Page, env: E2EEnv): Promise<string> {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    return await cdpEndpointOf(env)
  }

  test('BB-32/33: every tab is listed without loading any; attaching loads it, in the background', async ({
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      const url = await session(page, env)
      await openViaAgent(page, server.url('/a'))
      await openBrowser(page)
      await expect(openTabs(page)).toHaveCount(1, { timeout: 40_000 })
      expect(server.count('/a')).toBe(0)

      const client = await bareWebSocketClientThatNeverAutoAttaches(page, url)
      try {
        const list = (await client.send('Target.getTargets')) as {
          result: { targetInfos: { targetId: string; type: string; url: string }[] }
        }
        expect(list.result.targetInfos.every((t) => t.type === 'page')).toBe(true)
        const target = list.result.targetInfos.find((t) => t.url.includes('/a'))
        expect(target).toBeTruthy()
        expect(server.count('/a')).toBe(0)

        const attached = (await client.send('Target.attachToTarget', {
          targetId: target?.targetId,
          flatten: true
        })) as { result?: { sessionId?: string } }
        expect(attached.result?.sessionId).toBeTruthy()

        await expect.poll(() => server.count('/a'), { timeout: 40_000 }).toBeGreaterThan(0)
        await expect(page.locator(BROWSER.tabAgent)).toHaveCount(1)
      } finally {
        client.close()
      }
    } finally {
      await server.close()
    }
  })

  // PLATFORM§17
  test('a tab the user opened is not handed to a client, so a Playwright goto lands on a page of its own and leaves the user’s page where it was', async ({
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      const url = await session(page, env)
      await openBrowser(page)
      const mine = server.page('/mine', '<title>Mine</title><body>mine</body>')
      await openTabOn(page, mine)
      await expect(tabByTitle(page, 'Mine')).toHaveCount(1, { timeout: 30_000 })

      const browser = await chromium.connectOverCDP(url)
      try {
        const ctx = browser.contexts()[0]
        expect(ctx.pages().map((p) => p.url())).toEqual([])

        const driven = await ctx.newPage()
        await driven.goto(server.page('/theirs', '<title>Theirs</title><body>t</body>'))
        await expect(tabByTitle(page, 'Theirs')).toHaveCount(1, { timeout: 30_000 })
        await expect(tabByTitle(page, 'Mine')).toHaveCount(1)
        await expect(openTabs(page)).toHaveCount(2)
      } finally {
        await browser.close().catch(() => {})
      }
    } finally {
      await server.close()
    }
  })

  test('BB-47/59: /clear swaps the tab set under a connected client, connection intact, because the endpoint belongs to the tab', async ({
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const url = await session(page, env)
    let browser: Browser | null = null
    try {
      const pending = chromium.connectOverCDP(url)
      browser = await pending

      const p = await browser.contexts()[0].newPage()
      const gone = new Promise<void>((r) => p.on('close', () => r()))

      await runIn(page, centerTerm(page), '/clear')

      await gone
      expect(browser.isConnected()).toBe(true)

      const fresh = await browser.contexts()[0].newPage()
      expect(fresh).toBeTruthy()
    } finally {
      await browser?.close().catch(() => {})
    }
  })

  test('BB-60: a driven page survives the Browser column opening and closing', async ({
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      const url = await session(page, env)
      await closeBrowser(page)
      const pending = chromium.connectOverCDP(url)
      const browser = await pending
      try {
        const p = await browser.contexts()[0].newPage()
        await p.goto(server.page('/mark', '<body><div id="out">idle</div></body>'))
        await p.evaluate(() => {
          document.getElementById('out')!.textContent = 'kept'
        })

        for (const step of ['open', 'close', 'open'] as const) {
          if (step === 'open') await openBrowser(page)
          else await closeBrowser(page)
          await page.waitForTimeout(500)

          expect(await p.textContent('#out')).toBe('kept')
          const shot = await p.screenshot({ timeout: 30_000 })
          expect(shot.length).toBeGreaterThan(200)
        }
        expect(server.count('/mark')).toBe(1)
      } finally {
        await browser.close().catch(() => {})
      }
    } finally {
      await server.close()
    }
  })

  // PLATFORM§9
  test('S1: two off-screen driven pages can be captured at the same time, the stage holding every guest', async ({
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      const url = await session(page, env)
      await closeBrowser(page)
      const pending = chromium.connectOverCDP(url)
      const browser = await pending
      try {
        const ctx = browser.contexts()[0]
        const first = await ctx.newPage()
        await first.goto(server.page('/shot-a', '<title>A</title><body>aaa</body>'))
        const second = await ctx.newPage()
        await second.goto(server.page('/shot-b', '<title>B</title><body>bbb</body>'))

        const shots = await Promise.all([
          first.screenshot({ timeout: 45_000 }),
          second.screenshot({ timeout: 45_000 })
        ])
        for (const shot of shots) expect(shot.length).toBeGreaterThan(200)
      } finally {
        await browser.close().catch(() => {})
      }
    } finally {
      await server.close()
    }
  })

  test('BB-38/39: the tab cap refuses a client rather than close a page it is driving', async ({
    env
  }) => {
    test.setTimeout(300_000)
    env.launchEnv.KOLOFT_BROWSER_TAB_CAP = '2'
    const started = await launchApp(env)
    try {
      const host = await started.firstWindow()
      await host.waitForLoadState('domcontentloaded')
      await waitBooted(host)
      await startSessionIn(host, 'ws-a')
      const url = await cdpEndpointOf(env)

      const pending = chromium.connectOverCDP(url)
      const browser = await pending
      try {
        const ctx = browser.contexts()[0]
        const first = await ctx.newPage()
        const second = await ctx.newPage()
        expect(ctx.pages().length).toBeGreaterThanOrEqual(2)

        await expect(ctx.newPage()).rejects.toThrow()
        expect(first.isClosed()).toBe(false)
        expect(second.isClosed()).toBe(false)
        await openBrowser(host)
        await expect(openTabs(host)).toHaveCount(2)

        await second.close()
        await expect(openTabs(host)).toHaveCount(1, { timeout: 30_000 })
        const third = await ctx.newPage()
        expect(third).toBeTruthy()
      } finally {
        await browser.close().catch(() => {})
      }
    } finally {
      await started.close().catch(() => {})
    }
  })

  async function waitUntilTheNewBlankTabIsCurrent(page: Page, tabsBefore: number): Promise<void> {
    await expect(openTabs(page)).toHaveCount(tabsBefore + 1, { timeout: 30_000 })
    await expect(page.locator(`${BROWSER.tabActive} ${BROWSER.tabLabel}`)).toHaveText('New tab', {
      timeout: 30_000
    })
  }

  async function openTabOn(page: Page, url: string): Promise<void> {
    const before = await openTabs(page).count()
    await newWebTab(page)
    await waitUntilTheNewBlankTabIsCurrent(page, before)
    await expect(addressField(page)).toBeVisible({ timeout: 20_000 })
    await typeInAddressBar(page, url)
  }

  test('BB-40: the live-guest budget steps over the guest a client is driving', async ({ env }) => {
    test.setTimeout(300_000)
    setGuestLimit(env, 2)
    const server = await startEchoServer()
    const started = await launchApp(env)
    try {
      const host = await started.firstWindow()
      await host.waitForLoadState('domcontentloaded')
      await waitBooted(host)
      await startSessionIn(host, 'ws-a')
      const url = await cdpEndpointOf(env)

      const pending = chromium.connectOverCDP(url)
      const browser = await pending
      try {
        const driven = await browser.contexts()[0].newPage()
        const drivenUrl = server.page(
          '/driven',
          '<title>Driven</title><body><div id="out">driven</div></body>'
        )
        await driven.goto(drivenUrl)

        await openBrowser(host)
        await openTabOn(host, server.page('/u1', '<title>U1</title><body>u1</body>'))
        await expect(tabByTitle(host, 'U1')).toHaveCount(1, { timeout: 30_000 })
        await openTabOn(host, server.page('/u2', '<title>U2</title><body>u2</body>'))
        await expect(tabByTitle(host, 'U2')).toHaveCount(1, { timeout: 30_000 })

        await expect
          .poll(
            async () =>
              (await guestContents(started)).filter((g) => g.url.includes('/driven')).length,
            { timeout: 20_000 }
          )
          .toBe(1)
        expect(await driven.title()).toBe('Driven')
        expect(await driven.locator('#out').textContent()).toBe('driven')
      } finally {
        await browser.close().catch(() => {})
      }
    } finally {
      await started.close().catch(() => {})
      await server.close()
    }
  })

  test('a handshake over already-loaded tabs does not pay a settle wait per tab', async ({
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      const url = await session(page, env)
      await openBrowser(page)
      for (const name of ['P1', 'P2', 'P3']) {
        await openTabOn(
          page,
          server.page(`/${name.toLowerCase()}`, `<title>${name}</title><body>${name}</body>`)
        )
        await expect(tabByTitle(page, name)).toHaveCount(1, { timeout: 30_000 })
      }

      const HANDSHAKE_BOUND_WELL_UNDER_ONE_GRACE_PER_TAB_MS = 6_000
      const started = Date.now()
      const pending = chromium.connectOverCDP(url)
      const browser = await pending
      try {
        const pages = browser.contexts()[0].pages()
        const took = Date.now() - started
        expect(pages.length).toBeGreaterThanOrEqual(3)
        expect(took).toBeLessThan(HANDSHAKE_BOUND_WELL_UNDER_ONE_GRACE_PER_TAB_MS)
      } finally {
        await browser.close().catch(() => {})
      }
    } finally {
      await server.close()
    }
  })

  test('BB-68: a cross-origin iframe is reachable through its own sub-session', async ({
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      const url = await session(page, env)
      server.page('/frame-child', '<body><div id="inner">from the iframe</div></body>')
      const sameServerOtherOriginChild = server.localhostUrl('/frame-child')
      const parent = server.page(
        '/frame-parent',
        `<body><h1>parent</h1><iframe src="${sameServerOtherOriginChild}" width="300" height="200"></iframe></body>`
      )

      const pending = chromium.connectOverCDP(url)
      const browser = await pending
      try {
        const p = await browser.contexts()[0].newPage()
        await p.goto(parent)

        await expect.poll(() => p.frames().length, { timeout: 30_000 }).toBeGreaterThan(1)
        const frame = p.frames().find((f) => f.url().includes('/frame-child'))
        expect(frame).toBeTruthy()
        expect(await frame!.textContent('#inner')).toContain('from the iframe')
      } finally {
        await browser.close().catch(() => {})
      }
    } finally {
      await server.close()
    }
  })

  test('BB-61: a crash of a driven page is reported, and the tab survives it', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      const url = await session(page, env)
      const pending = chromium.connectOverCDP(url)
      const browser = await pending
      try {
        const p = await browser.contexts()[0].newPage()
        await p.goto(server.url('/a'))
        await openBrowser(page)
        await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })

        await crashGuest(app, '/a')

        const outcome = await Promise.race([
          new Promise<string>((r) => p.on('crash', () => r('crash'))),
          new Promise<string>((r) => p.on('close', () => r('close'))),
          p
            .title()
            .then(() => 'answered')
            .catch(() => 'error')
        ])
        expect(outcome).not.toBe('answered')
        expect(browser.isConnected()).toBe(true)
        await expect(openTabs(page)).toHaveCount(1)
      } finally {
        await browser.close().catch(() => {})
      }
    } finally {
      await server.close()
    }
  })
})
