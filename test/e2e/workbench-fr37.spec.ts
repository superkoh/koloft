import type { Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { clickAppMenuItem, startSessionIn } from './helpers/p1'
import { BROWSER, newWebTab, typeInAddressBar } from './helpers/browser'
import { activeKind, workbenchPanel } from './helpers/workbench'
import { startEchoServer, startHttpsServer } from './helpers/fixtureServer'

// PLATFORM§8
async function guestWidth(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const el = document.querySelector('.wb-panel webview') as unknown as {
      executeJavaScript?: (s: string) => Promise<number>
    } | null
    return (await el?.executeJavaScript?.('window.innerWidth')) ?? -1
  })
}

test.describe('Workbench web tab: the certificate interstitial and the zoom ladder', () => {
  test('FR-37: a self-signed host raises the interstitial, and Proceed really loads the page', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startHttpsServer()
    env.extraArgs = [...(env.extraArgs ?? []), server.hostResolverSwitch]
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await startSessionIn(page, 'ws-a')
      await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

      await newWebTab(page)
      await typeInAddressBar(page, server.aliasUrl('koloft-a.test', '/echo'))

      const cert = page.locator(BROWSER.certInterstitial)
      await expect(cert).toBeVisible({ timeout: 30_000 })
      await expect(cert).toContainText('Your connection is not private')
      await expect(cert).toContainText('koloft-a.test')
      await expect(page.locator(BROWSER.errorPage)).toHaveCount(0)

      await cert.locator('button', { hasText: 'Proceed anyway' }).click()
      await expect(cert).toHaveCount(0, { timeout: 30_000 })
      await expect.poll(() => server.requests.length, { timeout: 30_000 }).toBeGreaterThan(0)
    } finally {
      await app.close().catch(() => {})
      await server.close()
    }
  })

  test('FR-37: the zoom ladder steps and clamps, and reset returns to 1', async ({ app, page }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await startSessionIn(page, 'ws-a')
      await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
      await newWebTab(page)
      await typeInAddressBar(page, server.page('/zoom', '<h1>zoom</h1>'))
      await expect.poll(() => activeKind(page), { timeout: 30_000 }).toBe('web')
      await expect.poll(() => server.count('/zoom'), { timeout: 30_000 }).toBeGreaterThan(0)
      const base = await guestWidth(page)
      expect(base).toBeGreaterThan(100)

      const menu = (id: string): Promise<void> => clickAppMenuItem(app, page, id)
      const atZoom = async (z: number): Promise<void> => {
        await expect
          .poll(() => guestWidth(page), { timeout: 20_000 })
          .toBeGreaterThan(Math.round(base / z) - 2)
        expect(await guestWidth(page)).toBeLessThan(Math.round(base / z) + 2)
      }

      await menu('browser-zoom-in')
      await atZoom(1.1)
      await menu('browser-zoom-in')
      await atZoom(1.25)
      await menu('browser-zoom-out')
      await atZoom(1.1)

      for (let i = 0; i < 12; i++) await menu('browser-zoom-out')
      await atZoom(0.5)

      await menu('browser-zoom-reset')
      await atZoom(1)
    } finally {
      await server.close()
    }
  })
})
