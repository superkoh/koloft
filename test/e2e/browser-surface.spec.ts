import http from 'http'
import type { Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { setGuestLimit, type E2EEnv } from './helpers/env'
import { gitInit, startSessionIn } from './helpers/p1'
import {
  BROWSER,
  addressValue,
  guestByUrl,
  guestContents,
  globeIcon,
  navButton,
  navDisabled,
  newWebTab,
  openBrowser,
  openTabs,
  pinnedTab,
  readExternalOpens,
  readOpenCalls,
  typeInAddressBar
} from './helpers/browser'
import { wbFrozenTabs, wbTabByTitle } from './helpers/workbench'
import { startEchoServer, type FixtureServer } from './helpers/fixtureServer'

const FAIL_FAST_IF_ICON_MISSING_MS = 20_000
const PAST_SLOW_RESPONSE_COMPLETION_MS = 9_000
const NO_AUTO_RETRY_WINDOW_MS = 4_000

function titled(name: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head>` +
    `<body><h1 id="mark">${name}</h1></body></html>`
  )
}

async function sessionWithWorkbench(page: Page, env: E2EEnv): Promise<void> {
  await startSessionIn(page, 'ws-a')
  await expect(globeIcon(page)).toBeVisible({ timeout: FAIL_FAST_IF_ICON_MISSING_MS })
  await openBrowser(page)
}

async function openTabOn(page: Page, url: string): Promise<void> {
  await newWebTab(page)
  await expect(page.locator(BROWSER.addressField).first()).toBeVisible({ timeout: 20_000 })
  await typeInAddressBar(page, url)
}

async function openLoadedTab(page: Page, server: FixtureServer, name: string): Promise<void> {
  const url = server.page(`/${name.toLowerCase()}`, titled(name))
  await openTabOn(page, url)
  await expect(page.locator(`${BROWSER.tabActive} ${BROWSER.tabLabel}`)).toHaveText(name, {
    timeout: 30_000
  })
  await expect(wbTabByTitle(page, name)).toHaveCount(1, { timeout: 30_000 })
}

test.describe('Workbench web tabs: address bar and history, back/forward, reload/stop, progress, the ↗ hand-off, empty and error pages, the 8-tab cap and the live-guest cap', () => {
  test('BB-M04: typing a URL in the address bar and submitting loads it in the active tab', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const server = await startEchoServer()
    try {
      await sessionWithWorkbench(page, env)

      const url = server.localhostUrl('/a')
      await openTabOn(page, url)

      await guestByUrl(app, `:${server.port}/a`)
      await expect.poll(() => server.count('/a'), { timeout: 20_000 }).toBeGreaterThanOrEqual(1)
      await expect
        .poll(() => addressValue(page), { timeout: 15_000 })
        .toMatch(new RegExp(`localhost:${server.port}/a`))
    } finally {
      await server.close()
    }
  })

  test('BB-M04c: the address bar offers a visited page by its title, and picking it navigates there', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const server = await startEchoServer()
    try {
      await sessionWithWorkbench(page, env)

      await openTabOn(page, server.page('/z', titled('Zebra')))
      await expect(page.locator(`${BROWSER.tabActive} ${BROWSER.tabLabel}`)).toHaveText('Zebra', {
        timeout: 30_000
      })

      await newWebTab(page)
      await typeInAddressBar(page, 'zeb', { submit: false })
      const row = page.locator(BROWSER.suggestRow).filter({ hasText: '/z' })
      await expect(row).toHaveCount(1, { timeout: 20_000 })

      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')

      await expect.poll(() => server.count('/z'), { timeout: 20_000 }).toBe(2)
      await expect
        .poll(() => addressValue(page), { timeout: 20_000 })
        .toMatch(new RegExp(`:${server.port}/z$`))
    } finally {
      await server.close()
    }
  })

  test('BB-M07: an in-page link click navigates the tab, and Back returns to the prior page', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const server = await startEchoServer()
    try {
      await sessionWithWorkbench(page, env)
      await openTabOn(page, server.url('/a'))
      const guest = await guestByUrl(app, `:${server.port}/a`)

      await guest.locator('#to-b').click()
      await expect.poll(() => addressValue(page), { timeout: 20_000 }).toContain('/b')
      await expect.poll(() => server.count('/b'), { timeout: 20_000 }).toBeGreaterThanOrEqual(1)

      await navButton(page, 'Back').click()
      await expect.poll(() => addressValue(page), { timeout: 20_000 }).toContain('/a')
    } finally {
      await server.close()
    }
  })

  test('BB-M08: back/forward reflect history and are disabled at the ends', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const server = await startEchoServer()
    try {
      await sessionWithWorkbench(page, env)
      await openTabOn(page, server.url('/a'))
      const guest = await guestByUrl(app, `:${server.port}/a`)

      expect(await navDisabled(page, 'Back')).toBe(true)
      expect(await navDisabled(page, 'Forward')).toBe(true)

      await guest.locator('#to-b').click()
      await expect.poll(() => addressValue(page), { timeout: 20_000 }).toContain('/b')
      await expect.poll(() => navDisabled(page, 'Back'), { timeout: 15_000 }).toBe(false)
      expect(await navDisabled(page, 'Forward')).toBe(true)

      await navButton(page, 'Back').click()
      await expect.poll(() => addressValue(page), { timeout: 20_000 }).toContain('/a')
      await expect.poll(() => navDisabled(page, 'Forward'), { timeout: 15_000 }).toBe(false)
    } finally {
      await server.close()
    }
  })

  test('BB-M09: Reload re-fetches the guest, and a load in flight can be stopped', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    gitInit(env.workspaces.a)
    const server = await startEchoServer()
    try {
      await sessionWithWorkbench(page, env)
      await openTabOn(page, server.url('/a'))
      const guest = await guestByUrl(app, `:${server.port}/a`)
      await expect.poll(() => server.count('/a'), { timeout: 20_000 }).toBe(1)

      await navButton(page, 'Reload').click()
      await expect.poll(() => server.count('/a'), { timeout: 20_000 }).toBe(2)

      await typeInAddressBar(page, server.url('/slow?ms=5000'))
      await expect(navButton(page, 'Stop')).toBeVisible({ timeout: 20_000 })
      await navButton(page, 'Stop').click()
      await expect(navButton(page, 'Reload')).toBeVisible({ timeout: 20_000 })

      await page.waitForTimeout(PAST_SLOW_RESPONSE_COMPLETION_MS)
      expect(await guest.locator('#slow-head').count()).toBe(1)
      expect(await guest.locator('#slow-done').count()).toBe(0)
    } finally {
      await server.close()
    }
  })

  test('BB-M10: a load in progress shows a progress indicator that clears on completion', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    gitInit(env.workspaces.a)
    const server = await startEchoServer()
    try {
      await sessionWithWorkbench(page, env)
      await openTabOn(page, server.url('/a'))
      const guest = await guestByUrl(app, `:${server.port}/a`)

      await typeInAddressBar(page, server.url('/slow?ms=6000'))
      await expect(page.locator(BROWSER.progress)).toBeVisible({ timeout: 20_000 })

      await expect(guest.locator('#slow-done')).toBeVisible({ timeout: 40_000 })
      await expect(page.locator(BROWSER.progress)).toHaveCount(0, { timeout: 20_000 })
    } finally {
      await server.close()
    }
  })

  test('BB-M11: the ↗ external-open button hands the current URL to the system browser', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const server = await startEchoServer()
    try {
      await sessionWithWorkbench(page, env)
      const url = server.localhostUrl('/a')
      await openTabOn(page, url)
      await guestByUrl(app, `:${server.port}/a`)

      await navButton(page, 'Open in system browser').click()

      await expect
        .poll(() => [...readExternalOpens(env), ...readOpenCalls(env)], { timeout: 20_000 })
        .toEqual([url])
    } finally {
      await server.close()
    }
  })

  test('BB-C32: a blank web tab shows the three-entry empty state with the address bar focused', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    await sessionWithWorkbench(page, env)

    await expect(openTabs(page)).toHaveCount(0)
    await expect(pinnedTab(page)).toHaveClass(/\bon\b/)

    await newWebTab(page)

    await expect(openTabs(page)).toHaveCount(1)
    const empty = page.locator(BROWSER.emptyState)
    await expect(empty).toBeVisible({ timeout: 20_000 })
    await expect(empty).toContainText(/⌘\s*L/)
    await expect(empty).toContainText(/terminal/i)
    await expect(empty).toContainText(/Claude|agent/i)
    await expect
      .poll(
        () => page.evaluate(() => document.activeElement?.closest('.wb-panel .baddr') !== null),
        {
          timeout: 15_000
        }
      )
      .toBe(true)
  })

  test('BB-M22: a load failure shows the standard error page with a working Retry, and nothing retries on its own', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    gitInit(env.workspaces.a)
    const parked = await startEchoServer()
    const port = parked.port
    const url = parked.url('/a')
    await parked.close()

    const hits: string[] = []
    const revived = http.createServer((req, res) => {
      hits.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><html><head><title>Revived</title></head><body><h1 id="revived">koloft-e2e-retry-ok</h1></body></html>'
      )
    })
    try {
      await sessionWithWorkbench(page, env)
      await openTabOn(page, url)

      const errorPage = page.locator(BROWSER.errorPage)
      await expect(errorPage).toBeVisible({ timeout: 30_000 })
      await expect(errorPage).toContainText(/ERR_[A-Z_]+/)
      await expect(page.locator(BROWSER.retry)).toBeVisible()

      await new Promise<void>((ok) => revived.listen(port, '127.0.0.1', ok))
      await page.waitForTimeout(NO_AUTO_RETRY_WINDOW_MS)
      expect(hits).toEqual([])

      await page.locator(BROWSER.retry).click()
      const guest = await guestByUrl(app, `:${port}/a`)
      await expect(guest.locator('#revived')).toBeVisible({ timeout: 20_000 })
    } finally {
      await new Promise<void>((ok) => revived.close(() => ok()))
    }
  })

  test('BB-C01: a user re-open of an existing URL reuses and activates that tab', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    gitInit(env.workspaces.a)
    const server = await startEchoServer()
    try {
      await sessionWithWorkbench(page, env)
      await openTabOn(page, server.url('/link?href=/b&blank=1'))
      const opener = await guestByUrl(app, `:${server.port}/link`)
      await opener.locator('#link').click()
      await expect(openTabs(page)).toHaveCount(2, { timeout: 30_000 })
      await expect(wbTabByTitle(page, 'Page B')).toHaveCount(1)
      await wbTabByTitle(page, 'Link').click()
      await expect(wbTabByTitle(page, 'Link')).toHaveClass(/\bon\b/, { timeout: 20_000 })

      await opener.locator('#link').click()

      await expect(wbTabByTitle(page, 'Page B')).toHaveClass(/\bon\b/, { timeout: 30_000 })
      await expect(openTabs(page)).toHaveCount(2)
    } finally {
      await server.close()
    }
  })

  test('BB-C04: a per-session tab count of 8 is allowed', async ({ page, env }) => {
    test.setTimeout(300_000)
    gitInit(env.workspaces.a)
    const server = await startEchoServer()
    try {
      await sessionWithWorkbench(page, env)
      for (let i = 1; i <= 7; i++) await openLoadedTab(page, server, `T${i}`)
      await expect(openTabs(page)).toHaveCount(7)

      await openLoadedTab(page, server, 'T8')

      await expect(openTabs(page)).toHaveCount(8)
      await expect(wbTabByTitle(page, 'T1')).toHaveCount(1)
      await expect(pinnedTab(page)).toHaveCount(1)
    } finally {
      await server.close()
    }
  })

  test('BB-C05: opening a 9th tab evicts the oldest-unseen non-current tab with a toast', async ({
    page,
    env
  }) => {
    test.setTimeout(300_000)
    gitInit(env.workspaces.a)
    const server = await startEchoServer()
    try {
      await sessionWithWorkbench(page, env)
      for (let i = 1; i <= 8; i++) await openLoadedTab(page, server, `T${i}`)
      await expect(openTabs(page)).toHaveCount(8)

      await openTabOn(page, server.page('/t9', titled('T9')))

      await expect(page.locator('.toast')).toHaveText(/t1/i, { timeout: 20_000 })
      await expect(wbTabByTitle(page, 'T1')).toHaveCount(0)
      await expect(wbFrozenTabs(page)).toHaveCount(0)
      await expect(wbTabByTitle(page, 'T9')).toHaveCount(1, { timeout: 30_000 })
      await expect(openTabs(page)).toHaveCount(8)
    } finally {
      await server.close()
    }
  })

  test('BB-C06: the global live-guest count at the cap is allowed', async ({ env }) => {
    test.setTimeout(300_000)
    gitInit(env.workspaces.a)
    setGuestLimit(env, 2)
    const server = await startEchoServer()
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await sessionWithWorkbench(page, env)

      await openLoadedTab(page, server, 'T1')
      await openLoadedTab(page, server, 'T2')

      await expect(wbFrozenTabs(page)).toHaveCount(0)
      await expect
        .poll(async () => (await guestContents(app)).filter((g) => /\/t[12]$/.test(g.url)).length, {
          timeout: 20_000
        })
        .toBe(2)
    } finally {
      await app.close().catch(() => {})
      await server.close()
    }
  })

  test('BB-C07: exceeding the global live-guest cap freezes the LRU guest, which reloads on reopen', async ({
    env
  }) => {
    test.setTimeout(300_000)
    gitInit(env.workspaces.a)
    setGuestLimit(env, 2)
    const server = await startEchoServer()
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await sessionWithWorkbench(page, env)

      await openLoadedTab(page, server, 'T1')
      await openLoadedTab(page, server, 'T2')
      expect(server.count('/t1')).toBe(1)

      await openLoadedTab(page, server, 'T3')

      await expect(wbTabByTitle(page, 'T1')).toHaveClass(/\bfrozen\b/, { timeout: 30_000 })
      await expect(openTabs(page)).toHaveCount(3)
      await expect(wbTabByTitle(page, 'T1')).toContainText('T1')

      await wbTabByTitle(page, 'T1').click()
      await expect.poll(() => server.count('/t1'), { timeout: 30_000 }).toBe(2)
    } finally {
      await app.close().catch(() => {})
      await server.close()
    }
  })
})
