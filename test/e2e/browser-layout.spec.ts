import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import {
  BROWSER,
  BROWSER_MENU_IDS,
  activeKind,
  addressField,
  browserSurface,
  globeIcon,
  guestByUrl,
  guestContents,
  newWebTab,
  openBrowser,
  openTabs,
  pinnedTab,
  rendererZoomFactor,
  typeInAddressBar
} from './helpers/browser'
import { WORKBENCH, openInBrowse, wbActiveTab } from './helpers/workbench'
import {
  clickAppMenuItem,
  gitCommitAll,
  gitInit,
  processAlive,
  sendShortcut,
  startSessionIn,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { startEchoServer } from './helpers/fixtureServer'

const FAIL_FAST_IF_ICON_MISSING_MS = 20_000
const PANEL_MIN_WIDTH_PX = 440
const TUI_MIN_WIDTH_PX = 380

async function sessionWithWorkbench(page: Page, env: E2EEnv): Promise<void> {
  gitInit(env.workspaces.a)
  await startSessionIn(page, 'ws-a')
  await expect(globeIcon(page)).toBeVisible({ timeout: FAIL_FAST_IF_ICON_MISSING_MS })
  await openBrowser(page)
}

function commitSoFileOpensAsCodeNotDiff(env: E2EEnv): void {
  gitCommitAll(env.workspaces.a)
}

async function sessionWithWebTab(page: Page, env: E2EEnv, url: string): Promise<void> {
  await sessionWithWorkbench(page, env)
  await newWebTab(page)
  await expect(addressField(page)).toBeVisible({ timeout: 20_000 })
  await typeInAddressBar(page, url)
}

// PLATFORM§10
function activeElementInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.activeElement as HTMLElement | null
    return !!el && (el.matches(sel) || el.closest(sel) !== null)
  }, selector)
}

async function findTotal(page: Page): Promise<number> {
  const txt = (await page.locator('.find-bar:visible .find-count').innerText()).trim()
  const m = txt.match(/(\d+)\s*\/\s*(\d+)/)
  return m ? Number(m[2]) : 0
}

async function searchWith(page: Page, query: string): Promise<void> {
  await page.locator('.find-bar:visible .find-input').fill(query)
}

async function guestZoom(
  app: Parameters<typeof guestContents>[0],
  urlPart: string
): Promise<number> {
  const hit = (await guestContents(app)).find((g) => g.url.includes(urlPart))
  return hit ? hit.zoomFactor : 0
}

test.describe('Workbench layout and keyboard: one panel holds both kinds without rebuilding either, width floors, Focus mode, and ⌘T/⌘W/⌘R/⌘F/⌘± reach the focused island', () => {
  test('BB-M12: swapping the panel between the Files tab and a web tab rebuilds neither', async ({
    page,
    env
  }) => {
    test.setTimeout(240_000)
    gitInit(env.workspaces.a)
    await startSessionIn(page, 'ws-a')

    fs.writeFileSync(
      path.join(env.workspaces.a, 'long.txt'),
      Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    )
    commitSoFileOpensAsCodeNotDiff(env)
    await openInBrowse(page, path.join(env.workspaces.a, 'long.txt'))
    const codeBody = page.locator(`${BROWSER.surface} .code-body`).first()
    await expect(codeBody).toBeVisible({ timeout: 20_000 })
    await codeBody.evaluate((el) => {
      el.scrollTop = 1200
    })
    await expect.poll(() => codeBody.evaluate((el) => el.scrollTop)).toBe(1200)
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
    await expect(pinnedTab(page)).toHaveClass(/\bon\b/)

    await newWebTab(page)
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('web')
    await expect(pinnedTab(page)).not.toHaveClass(/\bon\b/)
    await expect(codeBody).toHaveCount(1)

    await pinnedTab(page).click({ timeout: 30_000 })
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('long.txt')
    await expect.poll(() => codeBody.evaluate((el) => el.scrollTop)).toBe(1200)
  })

  test('BB-C48: expanding the panel when no file is open still mounts it and its gutter', async ({
    page,
    env
  }) => {
    test.setTimeout(240_000)
    gitInit(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(globeIcon(page)).toBeVisible({ timeout: 20_000 })

    await expect(page.locator(WORKBENCH.readingTitle)).toHaveCount(0)
    await globeIcon(page).click({ timeout: 30_000 })
    await expect(browserSurface(page)).toBeHidden({ timeout: 20_000 })
    await expect(page.locator('.center-row .gutter-v')).toHaveCount(0)

    await globeIcon(page).click({ timeout: 30_000 })

    await expect(browserSurface(page)).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
    await expect(page.locator('.center-row .gutter-v')).toHaveCount(1)
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveCount(0)
  })

  test('BB-C55: the window minimum width is 1020, and an old 900-wide bounds is not clamped on restore', async ({
    env
  }) => {
    test.setTimeout(240_000)

    const app1 = await launchApp(env)
    try {
      const page1 = await app1.firstWindow()
      await page1.waitForLoadState('domcontentloaded')
      await app1.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].setBounds({ x: 100, y: 100, width: 700, height: 800 })
      })
      const width = await app1.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds().width
      )
      expect(width).toBeGreaterThanOrEqual(1020)
    } finally {
      await app1.close().catch(() => {})
    }

    fs.writeFileSync(
      path.join(env.userData, 'window-state.json'),
      JSON.stringify({ bounds: { x: 60, y: 60, width: 900, height: 700 } })
    )
    const app2 = await launchApp(env)
    try {
      const page2 = await app2.firstWindow()
      await page2.waitForLoadState('domcontentloaded')
      const bounds = await app2.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getBounds()
      )
      expect(bounds.width).toBe(900)
    } finally {
      await app2.close().catch(() => {})
    }
  })

  test(`BB-C56: the Workbench panel cannot be dragged narrower than ${PANEL_MIN_WIDTH_PX}px, below which most sites switch to their mobile layout`, async ({
    page,
    env
  }) => {
    test.setTimeout(240_000)
    await sessionWithWorkbench(page, env)

    const paneWidthOnDisk = (): number | undefined => {
      const file = path.join(env.userData, 'settings.json')
      if (!fs.existsSync(file)) return undefined
      return (JSON.parse(fs.readFileSync(file, 'utf8')) as { workbenchWidth?: number })
        .workbenchWidth
    }

    const gutter = page.locator('.center-row .gutter-v')
    await expect(gutter).toHaveCount(1)
    const grip = (await gutter.boundingBox())!
    const winW = await page.evaluate(() => window.innerWidth)
    const y = grip.y + grip.height / 2
    await page.mouse.move(grip.x + 2, y)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(grip.x + ((winW - 20 - grip.x) * i) / 10, y)
      await page.waitForTimeout(60)
    }
    await page.mouse.up()

    await expect.poll(paneWidthOnDisk, { timeout: 20_000 }).toBe(PANEL_MIN_WIDTH_PX)
    const tui = (await page.locator('.term-island').boundingBox())!
    expect(tui.width).toBeGreaterThanOrEqual(TUI_MIN_WIDTH_PX)
  })

  test('BB-C67: ⌘⏎ Focus fills the center-row, and switching sessions exits Focus automatically', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(420_000)
    gitInit(env.workspaces.a)
    gitInit(env.workspaces.b)
    await startSessionIn(page, 'ws-a')
    await startSessionIn(page, 'ws-b')

    await wsRows(page, 'ws-a').first().click()
    await expect(globeIcon(page)).toBeVisible({ timeout: 20_000 })
    await openBrowser(page)

    const centerRow = page.locator('.center-row')
    const tui = page.locator('.term-island')
    await expect(tui).toBeVisible()

    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.focusMode)
    await expect(tui).toBeHidden({ timeout: 20_000 })
    const rowBox = (await centerRow.boundingBox())!
    const panelBox = (await browserSurface(page).boundingBox())!
    expect(panelBox.width).toBeGreaterThan(rowBox.width * 0.9)

    const restore = browserSurface(page).locator('[aria-label^="Restore"]').first()
    await expect(restore).toBeVisible({ timeout: 20_000 })
    await expect(restore).toHaveAttribute('aria-pressed', 'true')
    await restore.click({ timeout: 30_000 })
    await expect(tui).toBeVisible({ timeout: 20_000 })
    await expect(browserSurface(page)).toBeVisible()
    const expand = browserSurface(page).locator('[aria-label^="Full width"]').first()
    await expect(expand).toBeVisible({ timeout: 20_000 })
    await expect(expand).toHaveAttribute('aria-pressed', 'false')

    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.focusMode)
    await expect(tui).toBeHidden({ timeout: 20_000 })
    await wsRows(page, 'ws-b').first().click()
    await expect(tui).toBeVisible({ timeout: 30_000 })
  })

  // PLATFORM§7
  test('BB-C35: ⌘T opens a new blank web tab, address bar focused, when the focus is inside a guest page', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      await sessionWithWebTab(page, env, server.url('/a'))
      const guest = await guestByUrl(app, server.url('/a'))
      const before = await openTabs(page).count()

      await guest.locator('#page-a').click({ timeout: 20_000 })
      await guest.keyboard.press('Meta+t')

      await expect(openTabs(page)).toHaveCount(before + 1, { timeout: 20_000 })
      await expect
        .poll(() => activeElementInside(page, BROWSER.addressBar), { timeout: 20_000 })
        .toBe(true)
    } finally {
      await server.close()
    }
  })

  test('BB-C36: ⌘W closes the current tab, and on the pinned Files tab the real ⌘W does nothing — it never falls through to close the session', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      await sessionWithWebTab(page, env, server.url('/a'))
      const [session] = await waitForCalls(env, 1)
      await newWebTab(page)
      await typeInAddressBar(page, server.url('/b'))
      await expect(openTabs(page)).toHaveCount(2, { timeout: 20_000 })

      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.closeTab)
      await expect(openTabs(page)).toHaveCount(1, { timeout: 20_000 })

      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.closeTab)
      await expect(openTabs(page)).toHaveCount(0, { timeout: 20_000 })
      await expect(browserSurface(page)).toBeVisible()
      await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')

      await pinnedTab(page).click({ timeout: 20_000 })
      await expect
        .poll(() => activeElementInside(page, BROWSER.surface), { timeout: 20_000 })
        .toBe(true)
      await sendShortcut(app, 'shortcut:close-tab')
      await page.waitForTimeout(1500)
      await expect(browserSurface(page)).toBeVisible()
      await expect(page.locator(BROWSER.tab)).toHaveCount(1)
      expect(processAlive(session.pid)).toBe(true)
    } finally {
      await server.close()
    }
  })

  test('F5: a click in the tab strip (or the address bar) alone gives ⌘W to the Workbench, never to a waiting session that would close without a confirm', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      await sessionWithWebTab(page, env, server.url('/a'))
      const [session] = await waitForCalls(env, 1)
      const row = wsRows(page, 'ws-a').first()
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 40_000 })

      await newWebTab(page)
      await typeInAddressBar(page, server.url('/b'))
      await expect(openTabs(page)).toHaveCount(2, { timeout: 20_000 })

      await openTabs(page).first().click({ timeout: 20_000 })
      await expect
        .poll(() => activeElementInside(page, BROWSER.surface), { timeout: 20_000 })
        .toBe(true)

      await sendShortcut(app, 'shortcut:close-tab')
      await expect(openTabs(page)).toHaveCount(1, { timeout: 20_000 })
      expect(processAlive(session.pid)).toBe(true)
      await expect(row).not.toHaveClass(/\bcold\b/)
      await expect(page.locator('.modal-backdrop')).toHaveCount(0)

      await addressField(page).click({ timeout: 20_000 })
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(openTabs(page)).toHaveCount(0, { timeout: 20_000 })
      await expect(browserSurface(page)).toBeVisible()
      await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
      expect(processAlive(session.pid)).toBe(true)
    } finally {
      await server.close()
    }
  })

  test('BB-C37: ⌘R with the Browser focused reloads only the guest, not the whole Koloft renderer', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      await sessionWithWebTab(page, env, server.url('/a'))
      await guestByUrl(app, server.url('/a'))
      await expect.poll(() => server.count('/a'), { timeout: 20_000 }).toBe(1)

      const termIds = await page.evaluate(() => {
        const w = window as unknown as {
          __koloftTerms: Record<string, { __bbMark?: boolean }>
          __bbRendererMark?: boolean
        }
        w.__bbRendererMark = true
        for (const t of Object.values(w.__koloftTerms)) t.__bbMark = true
        return Object.keys(w.__koloftTerms)
      })
      expect(termIds.length).toBeGreaterThan(0)

      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.reload)

      await expect.poll(() => server.count('/a'), { timeout: 20_000 }).toBe(2)
      const after = await page.evaluate(() => {
        const w = window as unknown as {
          __koloftTerms: Record<string, { __bbMark?: boolean }>
          __bbRendererMark?: boolean
        }
        return {
          rendererAlive: w.__bbRendererMark === true,
          ids: Object.keys(w.__koloftTerms),
          allMarked: Object.values(w.__koloftTerms).every((t) => t.__bbMark === true)
        }
      })
      expect(after.rendererAlive).toBe(true)
      expect(after.ids).toEqual(termIds)
      expect(after.allMarked).toBe(true)
    } finally {
      await server.close()
    }
  })

  test('BB-C60: find-in-page (⌘F) is arbitrated to the active tab’s kind and does not cross kinds', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      gitInit(env.workspaces.a)
      await startSessionIn(page, 'ws-a')

      fs.writeFileSync(
        path.join(env.workspaces.a, 'findable.md'),
        '# findable\n\npreviewonlymarker lives in the file pane\n'
      )
      await openInBrowse(page, path.join(env.workspaces.a, 'findable.md'))
      await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('findable.md', {
        timeout: 20_000
      })

      const findUrl = server.page(
        '/find',
        '<!doctype html><html><head><meta charset="utf-8"><title>Find</title></head>' +
          '<body><h1 id="find-target">guestonlymarker</h1></body></html>'
      )
      await expect(globeIcon(page)).toBeVisible({ timeout: 20_000 })
      await openBrowser(page)
      await newWebTab(page)
      await typeInAddressBar(page, findUrl)
      await guestByUrl(app, findUrl)
      expect(await activeKind(page)).toBe('web')

      await wbActiveTab(page).click({ timeout: 20_000 })
      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.findInPage)
      await expect(page.locator('.find-bar:visible')).toHaveCount(1, { timeout: 20_000 })
      await searchWith(page, 'guestonlymarker')
      await expect.poll(() => findTotal(page), { timeout: 20_000 }).toBeGreaterThan(0)
      await searchWith(page, 'previewonlymarker')
      await expect.poll(() => findTotal(page), { timeout: 20_000 }).toBe(0)

      await pinnedTab(page).click({ timeout: 30_000 })
      await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.findInPage)
      await expect(page.locator('.find-bar:visible')).toHaveCount(1, { timeout: 20_000 })
      await searchWith(page, 'previewonlymarker')
      await expect.poll(() => findTotal(page), { timeout: 20_000 }).toBeGreaterThan(0)
    } finally {
      await server.close()
    }
  })

  test('BB-C68: ⌘±/⌘0 page zoom applies to the guest, not to the Koloft renderer (the zoom step itself is not pinned)', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      await sessionWithWebTab(page, env, server.url('/a'))
      await guestByUrl(app, server.url('/a'))
      expect(await rendererZoomFactor(app)).toBe(1)

      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.zoomIn)
      await expect.poll(() => guestZoom(app, '/a'), { timeout: 20_000 }).not.toBe(1)
      expect(await rendererZoomFactor(app)).toBe(1)

      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.zoomReset)
      await expect.poll(() => guestZoom(app, '/a'), { timeout: 20_000 }).toBe(1)
      expect(await rendererZoomFactor(app)).toBe(1)
    } finally {
      await server.close()
    }
  })
})
