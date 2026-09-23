import fs from 'fs'
import path from 'path'
import { test, expect } from './helpers/app'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  centerTerm,
  clickAppMenuItem,
  focusOwner,
  islandBorderColors,
  litIsland,
  openSessionTerminal,
  panelTerm,
  startSessionIn
} from './helpers/p1'
import {
  BROWSER_MENU_IDS,
  addressField,
  guestByUrl,
  newWebTab,
  rendererZoomFactor,
  typeInAddressBar
} from './helpers/browser'
import { WORKBENCH, openFileTab, wbActiveTab, workbenchPanel } from './helpers/workbench'
import { startEchoServer, type FixtureServer } from './helpers/fixtureServer'

let server: FixtureServer

test.beforeAll(async () => {
  server = await startEchoServer()
})

test.afterAll(async () => {
  await server?.close()
})

async function toggleWorkbench(app: ElectronApplication, page: Page): Promise<void> {
  await clickAppMenuItem(app, page, 'toggle-browser')
}

async function toggleFull(app: ElectronApplication, page: Page): Promise<void> {
  await clickAppMenuItem(app, page, 'toggle-focus-mode')
}

async function sessionWithWebTab(page: Page, url: string): Promise<void> {
  await startSessionIn(page, 'ws-a')
  await newWebTab(page)
  await expect(addressField(page)).toBeVisible({ timeout: 20_000 })
  await typeInAddressBar(page, url)
}

// PLATFORM§10
function activeTag(page: Page): Promise<string> {
  return page.evaluate(() => (document.activeElement as HTMLElement | null)?.tagName ?? 'NONE')
}

async function clickNonFocusableFoldIconKeepingPick(page: Page): Promise<void> {
  await page.locator('.ws-head', { hasText: 'ws-b' }).locator('.fico').click()
}

test.describe('Workbench focus ring: the keys belong to whichever island is lit, and an island is lit exactly when the focus is inside it', () => {
  // PLATFORM§10
  test('T-FX-01: a click inside a guest makes the <webview> the host’s activeElement and lights the panel', async ({
    app,
    page
  }) => {
    test.setTimeout(240_000)
    const url = server.page('/fx01', '<!doctype html><title>FX01</title><p id="p">hello')
    await sessionWithWebTab(page, url)
    const guest = await guestByUrl(app, '/fx01')

    await guest.locator('#p').click({ timeout: 20_000 })

    expect(await activeTag(page)).toBe('WEBVIEW')
    expect(await litIsland(page)).toBe('panel')
  })

  test('T-FX-02: the accent ring follows the focus — conversation, then panel, then neither', async ({
    app,
    page
  }) => {
    test.setTimeout(240_000)
    await startSessionIn(page, 'ws-a')

    await centerTerm(page).click()
    await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('tui')
    await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('none')
    const onTui = await islandBorderColors(page)
    expect(onTui.panel).not.toBe(onTui.accent)

    await toggleWorkbench(app, page)
    await expect(workbenchPanel(page)).toBeHidden()
    await toggleWorkbench(app, page)
    await expect(workbenchPanel(page)).toBeVisible()
    await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('panel')
    const onPanel = await islandBorderColors(page)
    expect(onPanel.panel).toBe(onPanel.accent)
    expect(onPanel.tui).not.toBe(onPanel.accent)

    await clickNonFocusableFoldIconKeepingPick(page)
    await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('none')

    const url = server.page('/fx02', '<!doctype html><title>FX02</title><p id="p">hi')
    await newWebTab(page)
    await typeInAddressBar(page, url)
    const guest = await guestByUrl(app, '/fx02')
    await guest.locator('#p').click({ timeout: 20_000 })
    await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('panel')

    await clickNonFocusableFoldIconKeepingPick(page)
    await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('none')
  })

  test('T-FX-02b: ⌘⌥→ off a shell carries the caret, so the next Esc reaches the ladder', async ({
    app,
    page
  }) => {
    test.setTimeout(300_000)
    await startSessionIn(page, 'ws-a')
    await openSessionTerminal(app, page)
    await panelTerm(page).click()
    await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('panel')

    await page.keyboard.press('Meta+Alt+ArrowRight')
    await expect(wbActiveTab(page)).toHaveClass(/pinned/, { timeout: 20_000 })
    await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('panel')
    expect(await page.evaluate(() => document.activeElement?.closest('.wb-term') !== null)).toBe(
      false
    )

    await page.keyboard.press('Escape')
    await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('tui')
    await expect(workbenchPanel(page)).toBeVisible()
  })

  test('T-FX-03: ⌘R reloads the guest only while the panel is lit', async ({ app, page }) => {
    test.setTimeout(300_000)
    const url = server.page('/fx03', '<!doctype html><title>FX03</title><p id="p">hi')
    await sessionWithWebTab(page, url)
    await guestByUrl(app, '/fx03')
    await expect.poll(() => server.count('/fx03'), { timeout: 20_000 }).toBe(1)

    await centerTerm(page).click()
    await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('tui')
    await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('none')
    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.reload)
    await page.waitForTimeout(5000)
    expect(server.count('/fx03')).toBe(1)

    await toggleWorkbench(app, page)
    await toggleWorkbench(app, page)
    await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('panel')
    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.reload)
    await expect.poll(() => server.count('/fx03'), { timeout: 20_000 }).toBe(2)
  })

  test('T-FX-04: with the panel lit on a non-web tab, ⌘R is inert and ⌘± zooms the window', async ({
    app,
    page
  }) => {
    test.setTimeout(300_000)
    const url = server.page('/fx04', '<!doctype html><title>FX04</title><p id="p">hi')
    await sessionWithWebTab(page, url)
    await guestByUrl(app, '/fx04')
    await expect.poll(() => server.count('/fx04'), { timeout: 20_000 }).toBe(1)
    expect(await rendererZoomFactor(app)).toBe(1)

    await page.locator(WORKBENCH.tabFiles).click()
    await workbenchPanel(page).click({ position: { x: 5, y: 5 } })
    await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('panel')

    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.reload)
    await page.waitForTimeout(5000)
    expect(server.count('/fx04')).toBe(1)

    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.zoomIn)
    // PLATFORM§8
    await expect.poll(() => rendererZoomFactor(app), { timeout: 20_000 }).not.toBe(1)
  })

  test('T-FX-05: ⇧⌘B lands the caret per kind on the way in, and back in the conversation on the way out', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(420_000)
    const url = server.page('/fx05', '<!doctype html><title>FX05</title><p id="p">hi')
    await sessionWithWebTab(page, url)
    await guestByUrl(app, '/fx05')

    const roundTrip = async (): Promise<void> => {
      await toggleWorkbench(app, page)
      await expect(workbenchPanel(page)).toBeHidden()
      await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('tui')
      await toggleWorkbench(app, page)
      await expect(workbenchPanel(page)).toBeVisible()
    }

    await roundTrip()
    await expect.poll(() => activeTag(page), { timeout: 15_000 }).toBe('WEBVIEW')
    await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('panel')

    await page.locator(WORKBENCH.tabFiles).click()
    await roundTrip()
    await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('panel')
    expect(await activeTag(page)).not.toBe('WEBVIEW')

    const doc = path.join(env.workspaces.a, 'fx05.md')
    fs.writeFileSync(doc, '# FX05\n\nbody\n')
    await openFileTab(page, env, doc)
    await roundTrip()
    await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('panel')

    await openSessionTerminal(app, page)
    await roundTrip()
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null
            return !!el && el.tagName === 'TEXTAREA' && el.closest('.wb-term') !== null
          }),
        { timeout: 15_000 }
      )
      .toBe(true)

    await toggleWorkbench(app, page)
    await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('tui')
  })

  test('T-FX-06: ⌘⏎ moves the caret into the panel and leaves it there on the way back', async ({
    app,
    page
  }) => {
    test.setTimeout(240_000)
    await startSessionIn(page, 'ws-a')
    await centerTerm(page).click()
    await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('tui')

    await toggleFull(app, page)
    await expect(page.locator(WORKBENCH.panel)).toHaveClass(/full/)
    await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('panel')

    await toggleFull(app, page)
    await expect(page.locator(WORKBENCH.panel)).not.toHaveClass(/full/)
    await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('panel')
    expect(await litIsland(page)).toBe('panel')
  })

  test('T-FX-07: Esc inside a guest belongs to the page, not to the panel’s ladder', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    await startSessionIn(page, 'ws-a')

    const url = server.page(
      '/fx07',
      '<!doctype html><title>FX07</title><p id="p">hi</p>' +
        '<script>window.__esc=false;addEventListener("keydown",e=>{if(e.key==="Escape")window.__esc=true})</script>'
    )
    await newWebTab(page)
    await typeInAddressBar(page, url)
    const guest = await guestByUrl(app, '/fx07')
    await guest.locator('#p').click({ timeout: 20_000 })
    await guest.keyboard.press('Escape')

    await expect
      .poll(() => guest.evaluate(() => (window as unknown as { __esc: boolean }).__esc), {
        timeout: 15_000
      })
      .toBe(true)
    await expect(workbenchPanel(page)).toBeVisible()
    await expect(page.locator(WORKBENCH.panel)).not.toHaveClass(/full/)
  })
})
