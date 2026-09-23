import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import { gitInit, startSessionIn } from './helpers/p1'
import {
  BROWSER,
  downloadedFiles,
  dropOpenRequest,
  globeIcon,
  guestByUrl,
  guestContents,
  newWebTab,
  openBrowser,
  openTabs,
  readExternalOpens,
  readOpenCalls,
  typeInAddressBar,
  webviewAttrs
} from './helpers/browser'
import { startEchoServer } from './helpers/fixtureServer'
import { WORKBENCH, openInBrowse } from './helpers/workbench'

const NO_NAVIGATION_SETTLE_MS = 3000
const PAGE_SELF_TRIGGER_SETTLE_MS = 1500
const LATE_DROP_SETTLE_MS = 2000

interface GuestAttach {
  partition: string
  webpreferences: string
  disablewebsecurity: boolean
  sandbox: boolean | null
  webSecurity: boolean | null
  allowFileAccessFromFiles: boolean | null
  nodeIntegration: boolean | null
  preload: string
}

async function workbenchSession(page: Page, env: E2EEnv): Promise<void> {
  gitInit(env.workspaces.a)
  await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
  await startSessionIn(page, 'ws-a')
  await expect(globeIcon(page)).toBeVisible({ timeout: 30_000 })
  await openBrowser(page)
}

async function browserSession(page: Page, env: E2EEnv): Promise<void> {
  await workbenchSession(page, env)
  await newWebTab(page)
  await expect(page.locator(BROWSER.addressField).first()).toBeVisible({ timeout: 20_000 })
}

function osHandoffs(env: E2EEnv): string[] {
  return [...readOpenCalls(env), ...readExternalOpens(env)]
}

function stampTerms(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const reg =
      (window as unknown as { __koloftTerms?: Record<string, Record<string, unknown>> })
        .__koloftTerms ?? {}
    const ids = Object.keys(reg).sort()
    for (const id of ids) reg[id].__koloftSecStamp = id
    return ids
  })
}

function survivingTerms(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      const reg =
        (window as unknown as { __koloftTerms?: Record<string, Record<string, unknown>> })
          .__koloftTerms ?? {}
      return Object.keys(reg)
        .sort()
        .filter((id) => reg[id].__koloftSecStamp === id)
    })
    .catch(() => ['<renderer unreachable — it navigated away from the app origin>'])
}

async function sessionTabId(env: E2EEnv): Promise<string> {
  const dir = path.join(env.userData, 'sessions')
  let tabId = ''
  await expect
    .poll(
      () => {
        if (!fs.existsSync(dir)) return ''
        const files = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => path.join(dir, f))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
        for (const f of files) {
          try {
            const rec = JSON.parse(fs.readFileSync(f, 'utf8')) as { tabId?: string }
            if (rec.tabId) {
              tabId = rec.tabId
              return tabId
            }
          } catch {}
        }
        return ''
      },
      { timeout: 20_000 }
    )
    .not.toBe('')
  return tabId
}

test.describe('Session Browser security boundaries: local file reads, renderer navigation, OS hand-off and scheme whitelists, partition isolation, download names, the open-requests folder', () => {
  test('BB-C15: a page in the built-in browser cannot read local files via koloft-file://, because the guest partition refuses the scheme', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const secret = path.join(env.home, '.ssh', 'id_rsa')
    fs.mkdirSync(path.dirname(secret), { recursive: true })
    fs.writeFileSync(secret, 'koloft-e2e-secret-private-key\n')

    const target = `koloft-file://localhost${secret}`
    const pageFile = path.join(env.workspaces.a, 'docs', 'read-secret.html')
    fs.writeFileSync(
      pageFile,
      '<!doctype html><html><head><meta charset="utf-8"><title>read secret</title></head><body>' +
        '<pre id="result"></pre><script>\n' +
        'var out = document.getElementById("result");\n' +
        'setTimeout(function () { if (!out.textContent) out.textContent = "timeout" }, 5000);\n' +
        'fetch(' +
        JSON.stringify(target) +
        ').then(function (r) {\n' +
        '  return r.text().then(function (t) { out.textContent = "status:" + r.status + "|" + t })\n' +
        '}).catch(function (e) { out.textContent = "error:" + e.name })\n' +
        '</script></body></html>\n'
    )

    await browserSession(page, env)
    await typeInAddressBar(page, `file://${pageFile}`)
    const guest = await guestByUrl(app, 'read-secret.html')

    const result = guest.locator('#result')
    await expect(result).not.toBeEmpty({ timeout: 20_000 })

    const shown = (await result.textContent()) ?? ''
    expect(shown).not.toContain('koloft-e2e-secret-private-key')
    expect(shown).not.toMatch(/^status:200/)
  })

  test('BB-C16: the Koloft renderer never navigates away from its app origin, and its live terminals are never reloaded', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      gitInit(env.workspaces.a)
      const external = server.url('/p')
      fs.writeFileSync(
        path.join(env.workspaces.a, 'sec2.md'),
        `# sec2\n\nan [external](${external}) link\n`
      )
      await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
      await startSessionIn(page, 'ws-a')

      await openInBrowse(page, path.join(env.workspaces.a, 'sec2.md'))
      await expect(page.locator(`${WORKBENCH.readingBody} .md-body`)).toBeVisible({
        timeout: 20_000
      })

      const appOrigin = page.url()
      const terms = await stampTerms(page)
      expect(terms.length).toBeGreaterThan(0)

      await page.locator(`${WORKBENCH.readingBody} .md-body a`, { hasText: 'external' }).click()
      await expect.poll(() => server.count('/p'), { timeout: 30_000 }).toBeGreaterThan(0)
      await guestByUrl(app, '/p')

      expect(page.url()).toBe(appOrigin)
      expect(await survivingTerms(page)).toEqual(terms)

      await page.evaluate(() => {
        setTimeout(() => {
          window.location.href = 'http://evil.example/'
        }, 0)
      })
      await page.waitForTimeout(NO_NAVIGATION_SETTLE_MS)

      expect(page.url()).toBe(appOrigin)
      expect(await survivingTerms(page)).toEqual(terms)
    } finally {
      await server.close()
    }
  })

  test('BB-C17: the address bar rejects a javascript: URL', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await browserSession(page, env)
      const loaded = server.url('/a')
      await typeInAddressBar(page, loaded)
      await guestByUrl(app, loaded)

      await typeInAddressBar(page, 'javascript:alert(1)')
      await page.waitForTimeout(NO_NAVIGATION_SETTLE_MS)

      const urls = (await guestContents(app)).map((g) => g.url)
      expect(urls.filter((u) => u.startsWith('javascript:'))).toEqual([])
      await expect(page.locator(BROWSER.modal)).toHaveCount(0)
    } finally {
      await server.close()
    }
  })

  test('BB-C19: a guest navigation to file:///…Evil.app is dropped, not handed to openExternal', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await browserSession(page, env)
      const evil = 'file:///Applications/Evil.app'
      const linkPage = server.url(`/link?href=${encodeURIComponent(evil)}`)
      await typeInAddressBar(page, linkPage)
      const guest = await guestByUrl(app, '/link')

      await guest.locator('#link').click()

      await expect(page.locator('.toast, .bmodal').first()).toBeVisible({ timeout: 20_000 })

      const urls = (await guestContents(app)).map((g) => g.url)
      expect(urls.filter((u) => u.startsWith('file:///Applications'))).toEqual([])
      expect(osHandoffs(env).filter((l) => l.includes('Evil.app'))).toEqual([])
    } finally {
      await server.close()
    }
  })

  test('BB-C20: a non-whitelisted scheme link in a guest is dropped with a prompt, not handed to the OS', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await browserSession(page, env)
      const scheme = 'zoommtg://koloft-e2e-meeting'
      const linkPage = server.url(`/link?href=${encodeURIComponent(scheme)}`)
      await typeInAddressBar(page, linkPage)
      const guest = await guestByUrl(app, '/link')

      await guest.locator('#link').click()

      await expect(page.locator('.toast, .bmodal').first()).toBeVisible({ timeout: 20_000 })

      const urls = (await guestContents(app)).map((g) => g.url)
      expect(urls.filter((u) => u.startsWith('zoommtg:'))).toEqual([])
      expect(osHandoffs(env).filter((l) => l.includes('koloft-e2e-meeting'))).toEqual([])
    } finally {
      await server.close()
    }
  })

  test('BB-C21: mailto:/tel: links are handed to the OS only on a user click', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await browserSession(page, env)
      const linkPage = server.url(`/link?href=${encodeURIComponent('mailto:user@koloft.test')}`)
      await typeInAddressBar(page, linkPage)
      const guest = await guestByUrl(app, '/link')

      await guest.evaluate(() => {
        setTimeout(() => {
          window.location.href = 'mailto:auto@koloft.test'
        }, 0)
      })
      await page.waitForTimeout(PAGE_SELF_TRIGGER_SETTLE_MS)

      await guest.locator('#link').click()

      await expect
        .poll(() => osHandoffs(env).filter((l) => l.includes('user@koloft.test')).length, {
          timeout: 20_000
        })
        .toBe(1)
      expect(osHandoffs(env).filter((l) => l.includes('auto@koloft.test'))).toEqual([])
    } finally {
      await server.close()
    }
  })

  test('BB-C23: a download with a path-traversal filename is sanitized to a basename and never auto-opened', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await browserSession(page, env)

      const escaped = path.resolve(env.downloadDir, '..', '..', 'evil.sh')
      await typeInAddressBar(
        page,
        server.url(
          `/download?name=${encodeURIComponent('../../evil.sh')}&body=${encodeURIComponent('koloft-e2e-first')}`
        )
      )
      await expect.poll(() => downloadedFiles(env), { timeout: 30_000 }).toEqual(['evil.sh'])
      expect(fs.existsSync(escaped)).toBe(false)

      await typeInAddressBar(
        page,
        server.url(`/download?name=evil.sh&body=${encodeURIComponent('koloft-e2e-second')}`)
      )
      await expect.poll(() => downloadedFiles(env).length, { timeout: 30_000 }).toBe(2)

      const files = downloadedFiles(env)
      for (const f of files) expect(f).not.toContain('/')
      expect(fs.readFileSync(path.join(env.downloadDir, 'evil.sh'), 'utf8')).toContain(
        'koloft-e2e-first'
      )
      expect(new Set(files).size).toBe(2)

      expect(osHandoffs(env).filter((l) => l.includes('evil.sh'))).toEqual([])
    } finally {
      await server.close()
    }
  })

  test("BB-C26: the guest partition is isolated from Koloft's own renderer storage", async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await browserSession(page, env)

      await typeInAddressBar(page, server.url('/cookie?name=koloft_guest&value=1'))
      const setter = await guestByUrl(app, '/cookie')
      await expect(setter.locator('#cookie-set')).toHaveText('koloft_guest=1', { timeout: 20_000 })

      await app.evaluate(
        ({ session }, origin) =>
          session.defaultSession.cookies.set({ url: origin, name: 'koloft_host', value: '1' }),
        server.origin
      )

      await typeInAddressBar(page, server.url('/echo'))
      const echo = await guestByUrl(app, '/echo')
      await expect(echo.locator('#cookie')).toContainText('koloft_guest=1', { timeout: 20_000 })
      expect((await echo.locator('#cookie').textContent()) ?? '').not.toContain('koloft_host')

      const hostCookies = await app.evaluate(({ session }) =>
        session.defaultSession.cookies.get({}).then((cs) => cs.map((c) => c.name))
      )
      expect(hostCookies).toContain('koloft_host')
      expect(hostCookies).not.toContain('koloft_guest')
    } finally {
      await server.close()
    }
  })

  test('BB-C27: every guest is created with the locked security attribute set, on the koloft-browser partition and never the default session', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await app.evaluate(({ BrowserWindow }) => {
        const g = globalThis as unknown as { __koloftGuestAttaches?: GuestAttach[] }
        g.__koloftGuestAttaches = []
        BrowserWindow.getAllWindows()[0]?.webContents.on(
          'will-attach-webview',
          (_e, webPreferences, params) => {
            const p = webPreferences as unknown as Record<string, unknown>
            g.__koloftGuestAttaches?.push({
              partition: String(params.partition ?? p.partition ?? ''),
              webpreferences: String(params.webpreferences ?? ''),
              // PLATFORM§8
              disablewebsecurity: String(params.disablewebsecurity) === 'true',
              sandbox: (p.sandbox as boolean | undefined) ?? null,
              webSecurity: (p.webSecurity as boolean | undefined) ?? null,
              allowFileAccessFromFiles: (p.allowFileAccessFromFiles as boolean | undefined) ?? null,
              nodeIntegration: (p.nodeIntegration as boolean | undefined) ?? null,
              preload: p.preload ? String(p.preload) : ''
            })
          }
        )
      })

      await browserSession(page, env)
      const loaded = server.url('/a')
      await typeInAddressBar(page, loaded)
      await guestByUrl(app, loaded)

      const attrs = await webviewAttrs(page)
      expect(attrs.length).toBeGreaterThan(0)
      for (const a of attrs) {
        expect(a.partition).toBe('persist:koloft-browser')
        expect(a).not.toHaveProperty('disablewebsecurity')
        expect(a).not.toHaveProperty('preload')
        expect(a.nodeintegration ?? 'false').toBe('false')
      }

      const attaches = await app.evaluate(
        () =>
          (globalThis as unknown as { __koloftGuestAttaches?: GuestAttach[] })
            .__koloftGuestAttaches ?? []
      )
      expect(attaches.length).toBeGreaterThan(0)
      for (const g of attaches) {
        expect(g.partition).toBe('persist:koloft-browser')
        expect(g.disablewebsecurity).toBe(false)
        expect(g.preload).toBe('')
        expect(g.nodeIntegration).not.toBe(true)
        expect(g.webSecurity).not.toBe(false)
        expect(g.allowFileAccessFromFiles).not.toBe(true)
        expect(g.sandbox === true || /sandbox=(yes|true|1)/.test(g.webpreferences)).toBe(true)
      }

      const argv = (await app.evaluate(() => process.argv)).join(' ')
      expect(argv).not.toContain('--disable-web-security')
      expect(argv).not.toContain('--allow-file-access-from-files')

      const guests = await app.evaluate(({ webContents, session }) =>
        webContents
          .getAllWebContents()
          .filter((w) => w.getType() === 'webview')
          .map((w) => ({
            url: w.getURL(),
            onBrowserPartition: w.session === session.fromPartition('persist:koloft-browser'),
            onDefaultSession: w.session === session.defaultSession
          }))
      )
      expect(guests.length).toBeGreaterThan(0)
      for (const g of guests) {
        expect(g.onBrowserPartition).toBe(true)
        expect(g.onDefaultSession).toBe(false)
      }
    } finally {
      await server.close()
    }
  })

  test('BB-C57: a URL delivered through the open-requests directory gets the same scheme validation as the address bar', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await workbenchSession(page, env)
      const tabId = await sessionTabId(env)

      const refused = [
        'javascript:alert(1)',
        'data:text/html,<h1>koloft</h1>',
        'koloft-file://localhost/etc/hosts'
      ]
      for (const target of refused) {
        dropOpenRequest(env, { tabId, path: target, url: target })
      }
      const accepted = server.url('/p')
      dropOpenRequest(env, { tabId, path: accepted, url: accepted })
      await expect.poll(() => openTabs(page).count(), { timeout: 30_000 }).toBeGreaterThan(0)
      await page.waitForTimeout(LATE_DROP_SETTLE_MS)

      expect(await openTabs(page).count()).toBe(1)

      const urls = (await guestContents(app)).map((g) => g.url)
      const handoffs = osHandoffs(env)
      for (const scheme of ['javascript:', 'data:', 'koloft-file:']) {
        expect(urls.filter((u) => u.startsWith(scheme))).toEqual([])
        expect(handoffs.filter((l) => l.includes(scheme))).toEqual([])
      }
    } finally {
      await server.close()
    }
  })
})
