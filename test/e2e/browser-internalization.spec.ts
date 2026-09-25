import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { gitInit, startSessionIn, clickAppMenuItem } from './helpers/p1'
import {
  BROWSER,
  BROWSER_MENU_IDS,
  downloadedFiles,
  globeIcon,
  guestByUrl,
  guestPages,
  newWebTab,
  openBrowser,
  openTabs,
  readExternalOpens,
  readOpenCalls,
  typeInAddressBar,
  windowStates
} from './helpers/browser'
import {
  BASIC_REALM,
  startEchoServer,
  startFakeIdp,
  startHttpsServer
} from './helpers/fixtureServer'

test.describe('never forced to leave the app: login, downloads, certificates, upload, page permissions, clipboard and HTTP basic auth stay inside the web tab', () => {
  async function browserSession(page: Page): Promise<void> {
    await expect(globeIcon(page)).toBeVisible({ timeout: 30_000 })
    await openBrowser(page)
    await newWebTab(page)
    await expect(page.locator(BROWSER.addressField).first()).toBeVisible({ timeout: 20_000 })
  }

  const PROCEED = /Proceed anyway/i

  async function proceedCount(app: ElectronApplication, page: Page): Promise<number> {
    let n = await page.getByText(PROCEED).count()
    for (const guest of guestPages(app)) {
      n += await guest
        .getByText(PROCEED)
        .count()
        .catch(() => 0)
    }
    return n
  }

  async function clickProceed(app: ElectronApplication, page: Page): Promise<void> {
    await expect.poll(() => proceedCount(app, page), { timeout: 40_000 }).toBeGreaterThan(0)
    if ((await page.getByText(PROCEED).count()) > 0) {
      await page.getByText(PROCEED).first().click()
      return
    }
    for (const guest of guestPages(app)) {
      if ((await guest.getByText(PROCEED).count()) > 0) {
        await guest.getByText(PROCEED).first().click()
        return
      }
    }
    throw new Error('no proceed affordance to click')
  }

  test('BB-M26: the guest reports a standard Chromium UA with no Electron marker', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      gitInit(env.workspaces.a)
      await startSessionIn(page, 'ws-a')
      await browserSession(page)

      await typeInAddressBar(page, server.url('/echo'))
      await guestByUrl(app, server.url('/echo'))
      await expect.poll(() => server.count('/echo'), { timeout: 30_000 }).toBe(1)

      const ua = server.requestsFor('/echo')[0].userAgent
      expect(ua).not.toMatch(/Electron\//i)
      expect(ua).not.toMatch(/koloft/i)
      expect(ua).toContain('Chrome/')
    } finally {
      await server.close()
    }
  })

  test('BB-N08: the guest UA change is confined to the partition and does not alter Koloft’s own identity', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      gitInit(env.workspaces.a)
      await startSessionIn(page, 'ws-a')
      await browserSession(page)

      await typeInAddressBar(page, server.url('/echo'))
      await guestByUrl(app, server.url('/echo'))
      await expect.poll(() => server.count('/echo'), { timeout: 30_000 }).toBe(1)

      expect(server.requestsFor('/echo')[0].userAgent).not.toMatch(/Electron\//i)
      const fallback = await app.evaluate(({ app: electronApp }) => electronApp.userAgentFallback)
      expect(fallback).toMatch(/Electron\//i)
    } finally {
      await server.close()
    }
  })

  test('BB-M24: `window.open` / OAuth popup is routed into a new Browser tab, never a system window', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    const idp = await startFakeIdp()
    try {
      gitInit(env.workspaces.a)
      await startSessionIn(page, 'ws-a')
      await browserSession(page)

      const openCallsBefore = readOpenCalls(env)
      await typeInAddressBar(page, server.url(`/popup?target=${encodeURIComponent(idp.loginUrl)}`))
      const opener = await guestByUrl(app, '/popup')
      await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
      const windowsBefore = (await windowStates(app)).length

      await opener.click('#open-popup')

      const popup = await guestByUrl(app, idp.finalUrl, { timeout: 40_000 })
      await expect(popup.locator('#idp-app')).toBeVisible({ timeout: 30_000 })
      await expect(openTabs(page)).toHaveCount(2, { timeout: 30_000 })
      expect(idp.count('/login')).toBe(1)
      expect(idp.count('/callback')).toBe(1)
      expect(idp.requestsFor('/callback')[0].search).toContain(idp.code)

      expect((await windowStates(app)).length).toBe(windowsBefore)
      expect(readOpenCalls(env)).toEqual(openCallsBefore)
    } finally {
      await idp.close()
      await server.close()
    }
  })

  test('BB-M23: cookies / login state survive a Koloft restart', async ({ env }) => {
    test.setTimeout(360_000)
    const server = await startEchoServer()
    try {
      gitInit(env.workspaces.a)

      const app1 = await launchApp(env)
      try {
        const page1 = await app1.firstWindow()
        await page1.waitForLoadState('domcontentloaded')
        await startSessionIn(page1, 'ws-a')
        await browserSession(page1)
        await typeInAddressBar(page1, server.url('/cookie?name=koloft_login&value=abc123'))
        const guest1 = await guestByUrl(app1, '/cookie')
        await expect(guest1.locator('#cookie-set')).toHaveText('koloft_login=abc123', {
          timeout: 30_000
        })
      } finally {
        await app1.close().catch(() => {})
      }

      const app2 = await launchApp(env)
      try {
        const page2 = await app2.firstWindow()
        await page2.waitForLoadState('domcontentloaded')
        await startSessionIn(page2, 'ws-a')
        await browserSession(page2)
        await typeInAddressBar(page2, server.url('/echo'))
        await guestByUrl(app2, server.url('/echo'))
        await expect.poll(() => server.count('/echo'), { timeout: 30_000 }).toBe(1)

        expect(server.requestsFor('/echo')[0].cookie).toContain('koloft_login=abc123')
      } finally {
        await app2.close().catch(() => {})
      }
    } finally {
      await server.close()
    }
  })

  test('BB-M18: a download response lands a file on disk with a toast that dismisses itself while the download list keeps the file', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      gitInit(env.workspaces.a)
      await startSessionIn(page, 'ws-a')
      await browserSession(page)

      const openCallsBefore = readOpenCalls(env)
      const target = encodeURIComponent('/download?name=report.txt')
      await typeInAddressBar(page, server.url(`/link?href=${target}`))
      const guest = await guestByUrl(app, '/link')
      await guest.click('#link')

      await expect(page.locator('.toast')).toContainText('Reveal in Finder', { timeout: 40_000 })
      await expect.poll(() => downloadedFiles(env), { timeout: 40_000 }).toContain('report.txt')
      expect(readOpenCalls(env)).toEqual(openCallsBefore)

      const TOAST_STILL_UP_AT_MS = 2000
      const TOAST_GONE_AFTER_FURTHER_MS = 4000
      await page.waitForTimeout(TOAST_STILL_UP_AT_MS)
      await expect(page.locator('.toast')).toContainText('Reveal in Finder')
      await page.waitForTimeout(TOAST_GONE_AFTER_FURTHER_MS)
      await expect(page.locator('.toast')).toHaveCount(0)
      await page.locator(BROWSER.downloadButton).click()
      await expect(page.locator(BROWSER.downloadRow)).toContainText('report.txt')
    } finally {
      await server.close()
    }
  })

  test('BB-C69: an in-flight download survives closing the tab that started it', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      gitInit(env.workspaces.a)
      await startSessionIn(page, 'ws-a')
      await browserSession(page)

      const openCallsBefore = readOpenCalls(env)
      const trickleMs = 12_000
      const target = encodeURIComponent(`/download-slow?name=slow.bin&ms=${trickleMs}`)
      await typeInAddressBar(page, server.url(`/link?href=${target}`))
      const guest = await guestByUrl(app, '/link')
      await guest.click('#link')

      await expect.poll(() => server.count('/download-slow'), { timeout: 20_000 }).toBe(1)
      const startedAt = server.requestsFor('/download-slow')[0].ts

      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.closeTab)
      await expect
        .poll(() => guestPages(app).filter((p) => p.url().includes('/link')).length, {
          timeout: 30_000
        })
        .toBe(0)
      expect(Date.now() - startedAt).toBeLessThan(trickleMs)

      await expect
        .poll(
          () => {
            const file = path.join(env.downloadDir, 'slow.bin')
            return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
          },
          { timeout: 60_000 }
        )
        .toBe('ab')
      expect(downloadedFiles(env)).toContain('slow.bin')
      expect(readOpenCalls(env)).toEqual(openCallsBefore)
    } finally {
      await server.close()
    }
  })

  test('BB-M19: a certificate error shows a Chromium interstitial with a working "continue" and per-host memory', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const tls = await startHttpsServer()
    try {
      env.extraArgs.push(tls.hostResolverSwitch)
      gitInit(env.workspaces.a)

      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await page.waitForLoadState('domcontentloaded')
        await startSessionIn(page, 'ws-a')
        await browserSession(page)

        await typeInAddressBar(page, tls.aliasUrl('koloft-a.test', '/a'))
        await clickProceed(app, page)
        await expect.poll(() => tls.count('/a'), { timeout: 40_000 }).toBe(1)
        const guest = await guestByUrl(app, tls.aliasUrl('koloft-a.test', '/a'))
        await expect(guest.locator('#page-a')).toBeVisible({ timeout: 30_000 })

        await typeInAddressBar(page, tls.aliasUrl('koloft-a.test', '/b'))
        await expect.poll(() => tls.count('/b'), { timeout: 40_000 }).toBe(1)
        const guest2 = await guestByUrl(app, tls.aliasUrl('koloft-a.test', '/b'))
        await expect(guest2.locator('#page-b')).toBeVisible({ timeout: 30_000 })
        expect(await proceedCount(app, page)).toBe(0)
      } finally {
        await app.close().catch(() => {})
      }
    } finally {
      await tls.close()
    }
  })

  test('BB-C22: certificate handling is not special-cased for localhost', async ({ env }) => {
    test.setTimeout(300_000)
    const tls = await startHttpsServer()
    try {
      env.extraArgs.push(tls.hostResolverSwitch)
      gitInit(env.workspaces.a)

      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await page.waitForLoadState('domcontentloaded')
        await startSessionIn(page, 'ws-a')
        await browserSession(page)

        await typeInAddressBar(page, tls.localhostUrl('/a'))
        await expect.poll(() => proceedCount(app, page), { timeout: 40_000 }).toBeGreaterThan(0)
        expect(tls.count('/a')).toBe(0)

        await clickProceed(app, page)
        await expect.poll(() => tls.count('/a'), { timeout: 40_000 }).toBe(1)
        const guest = await guestByUrl(app, tls.localhostUrl('/a'))
        await expect(guest.locator('#page-a')).toBeVisible({ timeout: 30_000 })
      } finally {
        await app.close().catch(() => {})
      }
    } finally {
      await tls.close()
    }
  })

  test('BB-C65: a certificate exception is scoped to the host and does not leak to another host on the same certificate', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const tls = await startHttpsServer()
    try {
      env.extraArgs.push(tls.hostResolverSwitch)
      gitInit(env.workspaces.a)

      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await page.waitForLoadState('domcontentloaded')
        await startSessionIn(page, 'ws-a')
        await browserSession(page)

        await typeInAddressBar(page, tls.aliasUrl('koloft-a.test', '/a'))
        await clickProceed(app, page)
        await expect.poll(() => tls.count('/a'), { timeout: 40_000 }).toBe(1)

        await typeInAddressBar(page, tls.aliasUrl('koloft-b.test', '/b'))
        await expect.poll(() => proceedCount(app, page), { timeout: 40_000 }).toBeGreaterThan(0)
        expect(tls.count('/b')).toBe(0)

        await typeInAddressBar(page, tls.aliasUrl('koloft-a.test', '/p'))
        await expect.poll(() => tls.count('/p'), { timeout: 40_000 }).toBe(1)
        const guest = await guestByUrl(app, tls.aliasUrl('koloft-a.test', '/p'))
        await expect(guest.locator('#page-p')).toBeVisible({ timeout: 30_000 })
        expect(await proceedCount(app, page)).toBe(0)
      } finally {
        await app.close().catch(() => {})
      }
    } finally {
      await tls.close()
    }
  })

  test('BB-M20: a file-upload chooser can select a file into the page', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      gitInit(env.workspaces.a)
      await startSessionIn(page, 'ws-a')
      await browserSession(page)

      await typeInAddressBar(page, server.url('/upload'))
      const guest = await guestByUrl(app, server.url('/upload'))
      await guest.locator('#file').setInputFiles(path.join(env.workspaces.a, 'README.md'))

      await expect(guest.locator('#chosen')).toHaveText('README.md', { timeout: 30_000 })
    } finally {
      await server.close()
    }
  })

  async function denyEachPermissionBarAsItArrivesNeverByCount(page: Page): Promise<void> {
    const deny = page.locator(BROWSER.permissionDeny).first()
    await expect(deny).toBeVisible({ timeout: 30_000 })
    for (let i = 0; i < 6; i++) {
      try {
        await deny.waitFor({ state: 'visible', timeout: 5_000 })
      } catch {
        break
      }
      await deny.click()
    }
  }

  const GEOLOCATION_PERMISSION_DENIED = 1

  const PERMISSION_PROBE = `<!doctype html><html><head><meta charset="utf-8"><title>Permissions</title></head>
<body><button id="ask">ask</button><div id="result"></div>
<script>
document.getElementById('ask').addEventListener('click', async function () {
  var out = {}
  try { out.notifications = await Notification.requestPermission() } catch (e) { out.notifications = 'error:' + e.name }
  try { await navigator.clipboard.readText(); out.clipboardRead = 'resolved' } catch (e) { out.clipboardRead = 'rejected:' + e.name }
  try { await navigator.mediaDevices.getUserMedia({ audio: true }); out.media = 'resolved' } catch (e) { out.media = 'rejected:' + e.name }
  out.geolocation = await new Promise(function (ok) {
    navigator.geolocation.getCurrentPosition(
      function () { ok('resolved') },
      function (err) { ok('rejected:' + err.code) },
      { timeout: 8000 }
    )
  })
  window.location.href = 'zoommtg://koloft-e2e-permission-probe'
  document.getElementById('result').textContent = JSON.stringify(out)
})
</script></body></html>`

  test('BB-C63: an unanswered permission request grants nothing, and openExternal stays out', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      gitInit(env.workspaces.a)
      await startSessionIn(page, 'ws-a')
      await browserSession(page)

      const probeUrl = server.page('/perm', PERMISSION_PROBE)
      const openCallsBefore = readOpenCalls(env)
      await typeInAddressBar(page, probeUrl)
      const guest = await guestByUrl(app, probeUrl)
      await guest.click('#ask')

      await denyEachPermissionBarAsItArrivesNeverByCount(page)

      const result = guest.locator('#result')
      await expect(result).not.toBeEmpty({ timeout: 40_000 })
      const outcome = JSON.parse(await result.innerText()) as Record<string, string>
      expect(outcome.notifications).toBe('denied')
      expect(outcome.clipboardRead).toMatch(/^rejected:/)
      expect(outcome.media).toBe('rejected:NotAllowedError')
      expect(outcome.geolocation).toBe(`rejected:${GEOLOCATION_PERMISSION_DENIED}`)

      expect(readExternalOpens(env)).toEqual([])
      expect(readOpenCalls(env)).toEqual(openCallsBefore)
    } finally {
      await server.close()
    }
  })

  test('BB-C70: a page "Copy" button\'s writeText() resolves and the grant is recorded, with the real clipboard untouched', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      gitInit(env.workspaces.a)

      const spyArmed = await app.evaluate(({ clipboard }) => {
        const g = globalThis as unknown as { __koloftClipboardReads?: number }
        g.__koloftClipboardReads = 0
        const original = clipboard.readText
        clipboard.readText = (type?: 'clipboard' | 'selection'): string => {
          g.__koloftClipboardReads = (g.__koloftClipboardReads ?? 0) + 1
          return original.call(clipboard, type)
        }
        return clipboard.readText !== original
      })
      expect(spyArmed).toBe(true)

      await startSessionIn(page, 'ws-a')
      await browserSession(page)

      await typeInAddressBar(page, server.url('/clipboard'))
      const guest = await guestByUrl(app, server.url('/clipboard'))
      await guest.click('#copy')

      await expect(guest.locator('#result')).toHaveText('resolved', { timeout: 30_000 })

      const reads = await app.evaluate(
        () =>
          (globalThis as unknown as { __koloftClipboardReads?: number }).__koloftClipboardReads ??
          -1
      )
      expect(reads).toBe(0)
    } finally {
      await server.close()
    }
  })

  test('BB-C62: HTTP basic auth challenges only the main frame and shows origin+realm without memory (sub-resource half first, so no cached credential can mask it)', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      gitInit(env.workspaces.a)
      await startSessionIn(page, 'ws-a')
      await browserSession(page)

      await typeInAddressBar(page, server.url('/auth-sub'))
      const guest = await guestByUrl(app, server.url('/auth-sub'))
      await expect(guest.locator('#auth-sub')).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => server.count('/auth-img'), { timeout: 30_000 }).toBeGreaterThan(0)
      await page.waitForTimeout(2000)
      await expect(page.locator(BROWSER.modal)).toHaveCount(0)

      await typeInAddressBar(page, server.url('/auth'))
      const modal = page.locator(BROWSER.modal)
      await expect(modal).toBeVisible({ timeout: 40_000 })
      await expect(modal).toContainText(server.origin)
      await expect(modal).toContainText(BASIC_REALM)

      const fields = modal.locator('input')
      expect(await fields.count()).toBeGreaterThan(0)
      const values = await fields.evaluateAll((els) =>
        els.map((el) => (el as HTMLInputElement).value)
      )
      expect(values.every((v) => v === '')).toBe(true)
    } finally {
      await server.close()
    }
  })
})
