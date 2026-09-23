import type { Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { test, expect } from '../helpers/app'
import {
  BROWSER,
  addressValue,
  guestByUrl,
  guestPages,
  newWebTab,
  openBrowser,
  openTabs,
  pinnedTab,
  tabTitles,
  typeInAddressBar
} from '../helpers/browser'
import { startEchoServer, type FixtureServer } from '../helpers/fixtureServer'
import { startSessionIn } from '../helpers/p1'

const PROBE_PAGE = `<!doctype html><meta charset=utf-8><title>Probe</title><body>
<a id=link href="/second">second page</a>
<button id=full>full</button>
<div id=out></div>
<script>
  window.__ask = async (what) => {
    if (what === 'mic') return navigator.mediaDevices.getUserMedia({audio:true}).then(()=>'ok',e=>e.name)
    if (what === 'cam') return navigator.mediaDevices.getUserMedia({video:true}).then(()=>'ok',e=>e.name)
    if (what === 'notify') return Notification.requestPermission()
    if (what === 'geo') return new Promise(r=>navigator.geolocation.getCurrentPosition(()=>r('ok'),e=>r('denied')))
    if (what === 'clipread') return navigator.clipboard.readText().then(()=>'ok',e=>e.name)
    if (what === 'screen') return navigator.mediaDevices.getDisplayMedia().then(()=>'ok',e=>e.name)
    return 'unknown'
  }
  document.getElementById('full').onclick = () => {
    document.body.requestFullscreen().then(
      () => { window.__fs = 'ok' },
      (e) => { window.__fs = 'rejected:' + e.name + ':' + e.message }
    )
  }
  window.__notifState = () => Notification.permission
  window.__mark = 'fresh'
</script></body>`

const SECOND_PAGE = `<!doctype html><meta charset=utf-8><title>Second</title><body>second</body>`

let server: FixtureServer

test.beforeAll(async () => {
  server = await startEchoServer()
  server.page('/probe', PROBE_PAGE)
  server.page('/second', SECOND_PAGE)
})

test.afterAll(async () => {
  await server?.close()
})

const SMALL = (): string => server.url('/download?name=small.txt&body=hello')
const SLOW = (): string => server.url('/download-slow?name=big.bin&ms=8000')

const FILES_LABEL = 'Files'

const DEVICE_FREE_PROMPT = 'geo'
const CLOSE_BUTTON_RELATIVE_TO_TAB = '.x'

async function browserUp(page: Page): Promise<void> {
  await startSessionIn(page, 'ws-a')
  await openBrowser(page)
}

async function openTabOn(page: Page, url?: string): Promise<void> {
  await newWebTab(page)
  await expect(page.locator(BROWSER.addressField).first()).toBeVisible({ timeout: 20_000 })
  if (url !== undefined) await typeInAddressBar(page, url)
}

async function webTabUp(page: Page): Promise<void> {
  await browserUp(page)
  await openTabOn(page)
}

async function openProbe(page: Page, app: Parameters<typeof guestPages>[0]): Promise<Page> {
  await browserUp(page)
  await openTabOn(page, server.url('/probe'))
  const g = await guestByUrl(app, '/probe')
  await g.waitForFunction(() => (window as unknown as { __mark?: string }).__mark === 'fresh')
  return g
}

test.describe('Black-box: the browser close-out, inside the Workbench web tab', () => {
  test.describe('permission prompts', () => {
    // PLATFORM§11
    async function mediaInputKinds(guest: Page): Promise<string[]> {
      return guest.evaluate(() =>
        navigator.mediaDevices.enumerateDevices().then(
          (devices) =>
            [...new Set(devices.map((d) => d.kind as string))].filter(
              (kind) => kind === 'audioinput' || kind === 'videoinput'
            ),
          () => [] as string[]
        )
      )
    }

    async function needsMediaInput(guest: Page, kind: 'audioinput' | 'videoinput'): Promise<void> {
      const found = await mediaInputKinds(guest)
      test.skip(
        !found.includes(kind),
        `no ${kind} on this machine — enumerateDevices reported [${found.join(', ') || 'none'}]. ` +
          'Chromium rejects getUserMedia with NotFoundError before any permission handler runs, ' +
          'so no prompt can appear on any build. Not flakiness; runs again on a box with the device.'
      )
    }

    test('BB-M01/M02: a page asking for the microphone shows a prompt, and Allow really hands it over', async ({
      page,
      app
    }) => {
      const g = await openProbe(page, app)
      await needsMediaInput(g, 'audioinput')
      const asked = g.evaluate(() =>
        (window as never as { __ask(w: string): Promise<string> }).__ask('mic')
      )

      const bar = page.locator(BROWSER.permissionBar)
      await expect(bar).toBeVisible()
      await expect(bar).toContainText('microphone')
      await expect(bar).toContainText(new URL(server.url('/probe')).origin)

      await page.locator(BROWSER.permissionAllow).click()
      await expect(bar).toBeHidden()
      expect(await asked).not.toBe('NotAllowedError')
    })

    test('BB-M03: click Deny and the page gets a denial', async ({ page, app }) => {
      const g = await openProbe(page, app)
      await needsMediaInput(g, 'audioinput')
      const asked = g.evaluate(() =>
        (window as never as { __ask(w: string): Promise<string> }).__ask('mic')
      )
      await page.locator(BROWSER.permissionDeny).click()
      expect(await asked).toBe('NotAllowedError')
    })

    test('BB-M04: all five permissions ask, and the prompt names the right one', async ({
      page,
      app
    }) => {
      const g = await openProbe(page, app)
      await needsMediaInput(g, 'videoinput')
      for (const [what, text] of [
        ['cam', 'camera'],
        ['notify', 'notifications'],
        ['geo', 'location'],
        ['clipread', 'clipboard']
      ] as const) {
        const asked = g.evaluate(
          (w) => (window as never as { __ask(w: string): Promise<string> }).__ask(w),
          what
        )
        await expect(page.locator(BROWSER.permissionBar)).toContainText(text)
        await page.locator(BROWSER.permissionDeny).click()
        await asked
      }
    })

    test('BB-M05/M06/C03: once answered it does not ask again, and only for the one that was answered', async ({
      page,
      app
    }) => {
      const g = await openProbe(page, app)
      const ask = (w: string): Promise<string> =>
        g.evaluate((x) => (window as never as { __ask(w: string): Promise<string> }).__ask(x), w)

      const first = ask('notify')
      await expect(page.locator(BROWSER.permissionBar)).toContainText('notifications')
      await page.locator(BROWSER.permissionAllow).click()
      expect(await first).toBe('granted')

      const second = ask('notify')
      expect(await second).toBe('granted')
      await expect(page.locator(BROWSER.permissionBar)).toBeHidden()

      const location = ask('geo')
      await expect(page.locator(BROWSER.permissionBar)).toContainText('location')
      await page.locator(BROWSER.permissionDeny).click()
      await location
    })

    test('BB-M07/C54: an unsupported permission is refused out loud', async ({ page, app }) => {
      const g = await openProbe(page, app)
      // PLATFORM§11
      void g
        .evaluate(() => (window as never as { __ask(w: string): Promise<string> }).__ask('screen'))
        .catch(() => {})
      const refused = page.locator(BROWSER.permissionRefused)
      await expect(refused).toBeVisible()
      await expect(refused).toContainText(new URL(server.url('/probe')).origin)
    })

    test('BB-C44: the address bar still works while the prompt bar is up', async ({
      page,
      app
    }) => {
      const g = await openProbe(page, app)
      void g
        .evaluate(
          (w) => (window as never as { __ask(w: string): Promise<string> }).__ask(w),
          DEVICE_FREE_PROMPT
        )
        .catch(() => {})
      await expect(page.locator(BROWSER.permissionBar)).toBeVisible()

      await typeInAddressBar(page, server.url('/second'))
      await expect.poll(() => addressValue(page)).toContain('/second')
    })

    test('manual find: after the page navigates away, an unanswered prompt bar must not linger', async ({
      page,
      app
    }) => {
      const g = await openProbe(page, app)
      void g
        .evaluate(
          (w) => (window as never as { __ask(w: string): Promise<string> }).__ask(w),
          DEVICE_FREE_PROMPT
        )
        .catch(() => {})
      await expect(page.locator(BROWSER.permissionBar)).toBeVisible()

      await typeInAddressBar(page, server.url('/second'))
      await expect(page.locator(BROWSER.permissionBar)).toBeHidden()
    })

    test('BB-C45: closing the asking tab takes its prompt bar away', async ({ page, app }) => {
      const g = await openProbe(page, app)
      void g
        .evaluate(
          (w) => (window as never as { __ask(w: string): Promise<string> }).__ask(w),
          DEVICE_FREE_PROMPT
        )
        .catch(() => {})
      await expect(page.locator(BROWSER.permissionBar)).toBeVisible()

      await openTabs(page).first().locator(CLOSE_BUTTON_RELATIVE_TO_TAB).click()
      await expect(page.locator(BROWSER.permissionBar)).toBeHidden()
    })
  })

  test.describe('downloads', () => {
    test('BB-C12/M08: no download icon until something has been downloaded', async ({ page }) => {
      await webTabUp(page)
      await expect(page.locator(BROWSER.downloadButton)).toHaveCount(0)

      await typeInAddressBar(page, SMALL())
      await expect(page.locator(BROWSER.downloadButton)).toBeVisible({ timeout: 20_000 })
    })

    test('BB-M11: a finished file is in the list and really lands on disk', async ({
      page,
      env
    }) => {
      await webTabUp(page)
      await typeInAddressBar(page, SMALL())
      await page.locator(BROWSER.downloadButton).click()

      const row = page.locator(BROWSER.downloadRow).first()
      await expect(row).toContainText('small.txt')
      await expect(row).toContainText('Completed')
      await expect(row.getByRole('button', { name: 'Show in Finder' })).toBeVisible()

      await expect
        .poll(() => fs.existsSync(path.join(env.downloadDir, 'small.txt')), { timeout: 15_000 })
        .toBe(true)
    })

    test('BB-M09/M10: an in-progress download is visible, and after Cancel it never turns into Done', async ({
      page
    }) => {
      await webTabUp(page)
      await typeInAddressBar(page, SLOW())
      await page.locator(BROWSER.downloadButton).click()

      const row = page.locator(BROWSER.downloadRow).first()
      const cancel = row.getByRole('button', { name: 'Cancel' })
      await expect(cancel).toBeVisible()
      await cancel.click()

      await expect(row).toContainText('Cancelled')
      await page.waitForTimeout(1500)
      await expect(row).not.toContainText('Completed')
    })

    test('BB-C08: Clear history only clears the list, the files stay', async ({ page, env }) => {
      await webTabUp(page)
      await typeInAddressBar(page, SMALL())
      await page.locator(BROWSER.downloadButton).click()
      await expect(page.locator(BROWSER.downloadRow)).toHaveCount(1)

      await page.locator(BROWSER.downloadClear).click()
      await expect(page.locator(BROWSER.downloadRow)).toHaveCount(0)

      expect(fs.existsSync(path.join(env.downloadDir, 'small.txt'))).toBe(true)
    })

    test('BB-C53: the downloads panel can be closed, and is never open together with the three-dot menu', async ({
      page
    }) => {
      await webTabUp(page)
      await typeInAddressBar(page, SMALL())
      await page.locator(BROWSER.downloadButton).click()
      await expect(page.locator(BROWSER.downloadPanel)).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(page.locator(BROWSER.downloadPanel)).toBeHidden()

      await page.locator(BROWSER.downloadButton).click()
      await page.locator(BROWSER.overflowButton).click()
      await expect(page.locator(BROWSER.downloadPanel)).toBeHidden()
      await expect(page.locator(BROWSER.overflowMenu)).toBeVisible()
    })
  })

  test.describe('tab ordering', () => {
    async function threeTabs(page: Page): Promise<void> {
      await browserUp(page)
      for (const p of ['/probe', '/second', '/probe?x=2']) {
        await openTabOn(page, server.url(p))
      }
      await expect(openTabs(page)).toHaveCount(3)
    }

    test('BB-M16/C20/C21: a tab lands where it is dropped, the active tab stays, the page does not reload', async ({
      page,
      app
    }) => {
      await browserUp(page)
      await openTabOn(page, server.url('/probe'))
      const g = await guestByUrl(app, '/probe')
      await g.evaluate(() => {
        ;(window as unknown as { __mark: string }).__mark = 'kept'
      })
      await openTabOn(page, server.url('/second'))
      await expect(openTabs(page)).toHaveCount(2)

      await expect.poll(() => tabTitles(page)).toEqual([FILES_LABEL, 'Probe', 'Second'])
      const activeBefore = await page.locator(BROWSER.tabActive).innerText()

      await openTabs(page).last().dragTo(openTabs(page).first())

      await expect.poll(() => tabTitles(page)).toEqual([FILES_LABEL, 'Second', 'Probe'])
      expect(await page.locator(BROWSER.tabActive).innerText()).toBe(activeBefore)
      await expect(page.locator(BROWSER.tab).first()).toHaveClass(/pinned/)
      const marks = await Promise.all(
        guestPages(app).map((p) =>
          p.evaluate(() => (window as unknown as { __mark?: string }).__mark).catch(() => undefined)
        )
      )
      expect(marks).toContain('kept')
    })

    test('BB-C43: with drag added, clicking a tab to switch and clicking × to close still work', async ({
      page
    }) => {
      await threeTabs(page)
      const tabs = openTabs(page)
      await expect(tabs).toHaveCount(3)

      await tabs.first().click()
      await expect(page.locator(BROWSER.tabActive)).toHaveText(await tabs.first().innerText())

      await tabs.nth(1).locator(CLOSE_BUTTON_RELATIVE_TO_TAB).click()
      await expect(tabs).toHaveCount(2)
      await expect(pinnedTab(page)).toHaveCount(1)
    })
  })

  test.describe('the three-dot menu', () => {
    test('BB-M22/C34: the menu has Copy current URL, and Esc or clicking outside closes it', async ({
      page
    }) => {
      await browserUp(page)
      await openTabOn(page, server.url('/probe'))
      await page.locator(BROWSER.overflowButton).click()

      const menu = page.locator(BROWSER.overflowMenu)
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('menuitem', { name: 'Copy current URL' })).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
    })
  })

  test.describe('background tabs', () => {
    test('BB-M18/M28: ⌘+click opens a link in the background, the current page stays, the new tab gets an unread dot', async ({
      page,
      app
    }) => {
      const g = await openProbe(page, app)
      const activeBefore = await page.locator(BROWSER.tabActive).innerText()

      await g.locator('#link').click({ modifiers: ['Meta'] })

      await expect(openTabs(page)).toHaveCount(2)
      expect(await page.locator(BROWSER.tabActive).innerText()).toBe(activeBefore)
      await expect(page.locator(BROWSER.tabAgent)).toHaveCount(1)
    })

    test('BB-C26: a plain click still navigates in place, no new tab', async ({ page, app }) => {
      const g = await openProbe(page, app)
      await g.locator('#link').click()
      await expect(openTabs(page)).toHaveCount(1)
      await expect.poll(() => addressValue(page)).toContain('/second')
    })
  })

  test.describe('page fullscreen', () => {
    test('BB-M20/M21/C29: page fullscreen fills the window, Esc leaves it, the Koloft window never enters system fullscreen', async ({
      page,
      app
    }) => {
      // PLATFORM§8
      test.skip(
        process.env.KOLOFT_E2E_FULLSCREEN !== '1',
        'needs a visible window (hidden mode never settles requestFullscreen) — opt in with KOLOFT_E2E_FULLSCREEN=1'
      )
      const g = await openProbe(page, app)
      const wasFullscreen = await app.evaluate(
        async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFullScreen() ?? false
      )

      await g.locator('#full').click()
      await expect
        .poll(() => g.evaluate(() => (window as unknown as { __fs?: string }).__fs ?? 'pending'))
        .toBe('ok')
      await expect(page.locator(BROWSER.pageFullscreen)).toBeVisible()
      await expect(page.locator(BROWSER.tabStrip)).toBeHidden()
      await expect(page.locator('.aux-icons')).toBeHidden()

      expect(
        await app.evaluate(
          async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFullScreen() ?? false
        )
      ).toBe(wasFullscreen)

      await page.keyboard.press('Escape')
      await expect(page.locator(BROWSER.pageFullscreen)).toBeHidden()
      await expect(page.locator(BROWSER.tabStrip)).toBeVisible()
    })
  })
})
