import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, withOpenPath } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import { openSessionTerminal, panelTerm, runIn, startSessionIn, waitBooted } from './helpers/p1'
import {
  BROWSER,
  OVERLAY,
  downloadedFiles,
  dropOpenRequest,
  guestByUrl,
  openTabs,
  overlayUrl,
  readExternalOpens,
  readOpenCalls
} from './helpers/browser'
import { openSettings } from './helpers/extensions'
import { startEchoServer } from './helpers/fixtureServer'

async function runningSession(page: Page): Promise<void> {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
}

async function overlayShowing(page: Page, env: E2EEnv, url: string): Promise<void> {
  dropOpenRequest(env, { tabId: 'koloft-e2e-closed-tab', url })
  const entry = page.locator(OVERLAY.entry)
  const root = page.locator(OVERLAY.root)
  const onOverlayAnEarlierCaseLeftOpenOrParkedBehindEntry = async (): Promise<boolean> =>
    (await root.isVisible()) || (await entry.isVisible())
  await expect
    .poll(onOverlayAnEarlierCaseLeftOpenOrParkedBehindEntry, { timeout: 60_000 })
    .toBe(true)
  if (!(await root.isVisible())) await entry.click()
  await expect(root).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => overlayUrl(page), { timeout: 30_000 }).toContain(new URL(url).pathname)
}

test.describe("App-level browser overlay: a page no session's Browser can show lands inside Koloft, never in the OS", () => {
  test('BB-02: the island’s `open` still lands in the live session’s Browser', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await runningSession(page)
      await openSessionTerminal(app, page)
      await runIn(page, panelTerm(page), withOpenPath(env, `open '${server.localhostUrl('/a')}'`))

      await expect(page.locator(BROWSER.surface)).toBeVisible({ timeout: 40_000 })
      await guestByUrl(app, `:${server.port}/a`)
      expect(await page.locator(OVERLAY.root).count()).toBe(0)
      expect(await page.locator(OVERLAY.entry).count()).toBe(0)
      expect(readExternalOpens(env)).toEqual([])
    } finally {
      await server.close()
    }
  })

  test('BB-06/09: late opens are taken in the background — toast + ONE unread entry that shows the last page', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    const server = await startEchoServer()
    try {
      dropOpenRequest(env, { tabId: 'koloft-e2e-closed-tab', url: server.localhostUrl('/a') })

      await expect(page.locator(OVERLAY.entryUnread)).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('.toast')).toBeVisible({ timeout: 5_000 })
      expect(await page.locator(OVERLAY.root).count()).toBe(0)
      expect(server.count('/a')).toBe(0)
      expect(readExternalOpens(env)).toEqual([])

      dropOpenRequest(env, { tabId: 'koloft-e2e-closed-tab-2', url: server.localhostUrl('/b') })
      await expect(page.locator(OVERLAY.entry)).toHaveCount(1)
      await expect(page.locator(OVERLAY.entryUnread)).toHaveCount(1)

      await page.locator(OVERLAY.entry).click()
      await expect(page.locator(OVERLAY.root)).toBeVisible({ timeout: 20_000 })
      await expect.poll(() => overlayUrl(page), { timeout: 30_000 }).toContain('/b')
      await expect.poll(() => server.count('/b'), { timeout: 30_000 }).toBeGreaterThan(0)
      await expect(page.locator(OVERLAY.entryUnread)).toHaveCount(0)
    } finally {
      await server.close()
    }
  })

  // PLATFORM§6
  test('a page already waiting when Koloft starts is never swallowed, though the startup sweep hands it over before the renderer listens', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    const started = await launchApp(env)
    try {
      const host = await started.firstWindow()
      dropOpenRequest(env, { tabId: 'koloft-e2e-closed-tab', url: server.localhostUrl('/a') })
      await host.waitForLoadState('domcontentloaded')

      await expect(host.locator(OVERLAY.entryUnread)).toBeVisible({ timeout: 40_000 })
      expect(readExternalOpens(env)).toEqual([])
      await host.locator(OVERLAY.entry).click()
      await expect(host.locator(OVERLAY.root)).toBeVisible({ timeout: 20_000 })
      await expect.poll(() => server.count('/a'), { timeout: 30_000 }).toBeGreaterThan(0)
    } finally {
      await started.close().catch(() => {})
      await server.close()
    }
  })

  test('BB-10: Settings→About’s releases link opens IN Koloft, over Settings; Esc closes only it', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    env.launchEnv.KOLOFT_RELEASES_URL = server.url('/a')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await openSettings(page)
      await page.locator('.set-ni', { hasText: 'About' }).click()
      await page.getByRole('button', { name: /Open releases page/ }).click()

      await expect(page.locator(OVERLAY.root)).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => overlayUrl(page), { timeout: 30_000 }).toContain('/a')
      expect(readExternalOpens(env)).toEqual([])

      await page.keyboard.press('Escape')
      await expect(page.locator(OVERLAY.root)).toHaveCount(0)
      await expect(page.locator('.modal').first()).toBeVisible()
    } finally {
      await app.close().catch(() => {})
      await server.close()
    }
  })

  test('BB-11: the update modal’s View release opens the cached page in the overlay', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    const fixture = path.join(env.home, 'update-fixture.json')
    fs.writeFileSync(fixture, '[]')
    env.launchEnv.KOLOFT_UPDATE_FIXTURE = fixture
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      // PLATFORM§4
      const running = await app.evaluate(({ app }) => app.getVersion())
      const m = running.match(/^(\d+)\.(\d+)\.(\d+)/)
      if (!m) throw new Error(`cannot parse version: ${running}`)
      const next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
      fs.writeFileSync(
        fixture,
        JSON.stringify([
          {
            tag_name: `v${next}`,
            name: `Koloft v${next}`,
            body: '## What’s Changed\n\n- something\n',
            html_url: server.url('/b'),
            draft: false,
            prerelease: false,
            assets: [
              {
                name: `Koloft-${next}-arm64.dmg`,
                browser_download_url: 'https://example.invalid/Koloft.dmg'
              }
            ]
          }
        ])
      )
      await page.waitForFunction(
        () =>
          (window as unknown as { __koloftShortcutsReady?: boolean }).__koloftShortcutsReady ===
          true,
        undefined,
        { timeout: 20_000 }
      )
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('shortcut:check-update')
      })
      await page.locator('.update-modal').waitFor({ state: 'visible', timeout: 30_000 })
      await page.getByRole('button', { name: /View release/ }).click()

      await expect(page.locator(OVERLAY.root)).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => overlayUrl(page), { timeout: 30_000 }).toContain('/b')
      expect(readExternalOpens(env)).toEqual([])
    } finally {
      await app.close().catch(() => {})
      await server.close()
    }
  })

  test('BB-12: ↗ hands the overlay’s page to the system browser — exactly once', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    const server = await startEchoServer()
    try {
      const url = server.localhostUrl('/a')
      await overlayShowing(page, env, url)
      await page.locator(OVERLAY.external).click()

      await expect
        .poll(() => [...readExternalOpens(env), ...readOpenCalls(env)], { timeout: 20_000 })
        .toEqual([url])
    } finally {
      await server.close()
    }
  })

  test('BB-13: a second landing replaces the page; Back returns to the first', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    const server = await startEchoServer()
    try {
      await overlayShowing(page, env, server.localhostUrl('/a'))
      dropOpenRequest(env, { tabId: 'koloft-e2e-closed-tab-2', url: server.localhostUrl('/b') })
      await expect.poll(() => overlayUrl(page), { timeout: 30_000 }).toContain('/b')
      await expect(page.locator(OVERLAY.root)).toHaveCount(1)

      await page.locator(OVERLAY.back).click()
      await expect.poll(() => overlayUrl(page), { timeout: 30_000 }).toContain('/a')
    } finally {
      await server.close()
    }
  })

  test('BB-14: window.open inside the overlay navigates in place, never into a strip', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await runningSession(page)
      await overlayShowing(page, env, server.url('/popup?target=/next'))
      const guest = await guestByUrl(app, '/popup')
      await guest.locator('#open-popup').click()

      await expect.poll(() => overlayUrl(page), { timeout: 30_000 }).toBe(server.url('/next'))
      expect(await page.locator(OVERLAY.root).count()).toBe(1)
      expect(await openTabs(page).count()).toBe(0)
      expect(readExternalOpens(env)).toEqual([])
    } finally {
      await server.close()
    }
  })

  test('BB-15: an overlay page’s alert is answered on the overlay’s own modal', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(120_000)
    const server = await startEchoServer()
    try {
      await overlayShowing(page, env, server.url('/dialogs'))
      const guest = await guestByUrl(app, '/dialogs')
      void guest.locator('#do-alert').click()

      await expect(page.locator(OVERLAY.modal)).toBeVisible({ timeout: 30_000 })
      expect(await page.locator(BROWSER.modal).count()).toBe(1)
      await page.locator(OVERLAY.modal).getByRole('button', { name: 'OK' }).click()
      await expect(guest.locator('#result')).toHaveText('alert-returned', { timeout: 20_000 })
    } finally {
      await server.close()
    }
  })

  test('BB-16: page permissions in the overlay are refused, with no prompt bar', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(120_000)
    const server = await startEchoServer()
    try {
      await overlayShowing(page, env, server.url('/permission'))
      const guest = await guestByUrl(app, '/permission')

      await guest.locator('#ask-mic').click()
      await expect(guest.locator('#mic')).toContainText('denied:', { timeout: 30_000 })
      await guest.locator('#ask-notify').click()
      await expect(guest.locator('#notify')).toHaveText('denied', { timeout: 30_000 })
      expect(await page.locator(BROWSER.permissionBar).count()).toBe(0)
    } finally {
      await server.close()
    }
  })

  test('BB-17: a download from the overlay lands in Koloft’s download dir', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    const server = await startEchoServer()
    try {
      await overlayShowing(page, env, server.url('/a'))
      dropOpenRequest(env, {
        tabId: 'koloft-e2e-closed-tab-2',
        url: server.url('/download?name=overlay.txt')
      })

      await expect.poll(() => downloadedFiles(env), { timeout: 40_000 }).toContain('overlay.txt')
      expect(readExternalOpens(env)).toEqual([])
    } finally {
      await server.close()
    }
  })

  test('BB-18: a mailto: link in the overlay is handed to the OS', async ({ app, page, env }) => {
    test.setTimeout(120_000)
    const server = await startEchoServer()
    try {
      await overlayShowing(page, env, server.url('/link?href=mailto:someone@example.com'))
      const guest = await guestByUrl(app, '/link')
      await guest.locator('#link').click()

      await expect
        .poll(() => readExternalOpens(env).join('\n'), { timeout: 30_000 })
        .toContain('mailto:someone@example.com')
    } finally {
      await server.close()
    }
  })

  test('BB-67: a confirmation layer sits ABOVE the overlay and takes the click', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(120_000)
    const server = await startEchoServer()
    try {
      await overlayShowing(page, env, server.url('/a'))
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('ext:permission-request', {
          kind: 'permission',
          id: 'koloft-e2e-ask',
          name: 'Koloft probe',
          permissions: ['tabs'],
          origins: []
        })
      })

      const confirm = page.locator('.ext-confirm')
      await expect(confirm).toBeVisible({ timeout: 20_000 })
      const box = await confirm.boundingBox()
      expect(box).not.toBeNull()
      const onTop = await page.evaluate(
        ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.ext-confirm'),
        { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
      )
      expect(onTop).toBe(true)
      await expect(page.locator(OVERLAY.root)).toBeVisible()
    } finally {
      await server.close()
    }
  })
})
