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

/**
 * The Workbench `web` kind's security boundaries (FR-37 — the merge changes
 * none of them; case ids are the original case list's SEC cluster).
 * Two of these guard bugs that were LIVE before the Browser landed — an unrestricted
 * `koloft-file://` read (SEC-1) and a host renderer that can be navigated onto a remote
 * origin (SEC-2, RCE via the preload bridge) — the rest pin the boundaries the feature
 * introduced: the OS hand-off whitelist, the address bar's scheme whitelist, the
 * partition every guest must carry, storage isolation, download filename sanitisation,
 * and the open-requests drop directory.
 *
 * Every oracle is the one its case names. "Nothing left Koloft" is read from the two
 * recording choke points (the fake `open` on PATH and KOLOFT_EXTERNAL_OPENS_FILE) and is
 * only ever asserted after a positive barrier, never on its own.
 */

/** One guest's configuration as the host recorded it at `will-attach-webview` time. */
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

/**
 * The Given every case here shares: a running session with the panel showing.
 *
 * `openBrowser` chooses T1 vs T2 now rather than a surface, and the panel is open by
 * DEFAULT after the merge (`workbench.defaultOpen`, FR-06), so it is usually a no-op.
 */
async function workbenchSession(page: Page, env: E2EEnv): Promise<void> {
  gitInit(env.workspaces.a)
  await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
  await startSessionIn(page, 'ws-a')
  await expect(globeIcon(page)).toBeVisible({ timeout: 30_000 })
  await openBrowser(page)
}

/** …plus the blank `web` tab whose address bar is the entry point for every url below.
 *  FR-52: the panel opens on the pinned `files` tab, whose kind bar has no address field
 *  at all, so one has to be minted before anything can be typed. */
async function browserSession(page: Page, env: E2EEnv): Promise<void> {
  await workbenchSession(page, env)
  await newWebTab(page)
  await expect(page.locator(BROWSER.addressField).first()).toBeVisible({ timeout: 20_000 })
}

/**
 * Everything that reached an OS hand-off, whichever choke point recorded it: the
 * recording fake `open` on PATH (the shim's passthrough) and the app's own
 * external-open file (what openExternal/openPath append under KOLOFT_SUPPRESS_OS_OPEN).
 * A case that says "openCalls gains no entry" means "nothing left Koloft", and under the
 * suite's suppression seam that fact can land in either file.
 */
function osHandoffs(env: E2EEnv): string[] {
  return [...readOpenCalls(env), ...readExternalOpens(env)]
}

/**
 * Stamp every live xterm instance and return their ids. A later read tells a SURVIVING
 * instance from a fresh one mounted under the same pty id — a renderer reload would
 * otherwise refill `__koloftTerms` with identical-looking keys and read as "unchanged".
 */
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

/** The stamped instances that are still there. An unreachable renderer counts as none. */
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

/**
 * The running session's pty tab id, read from the shim's own registration drop
 * (`<userData>/sessions/<regId>.json`). BB-C57 impersonates a co-user process, and a
 * co-user process reads the tab id from exactly this directory — same trust boundary,
 * same umask.
 */
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
          } catch {
            /* a record still being written */
          }
        }
        return ''
      },
      { timeout: 20_000 }
    )
    .not.toBe('')
  return tabId
}

// BB-C15 [SEC-1 regression] — the privileged `koloft-file://` protocol reads any path the
// user can read, so a page that reaches it can exfiltrate ~/.ssh/id_rsa. What stands in the
// way is the PARTITION: the built-in browser's own session refuses the scheme outright
// (index.ts, the `koloft-file` handler that answers 403 there), and this is the case that
// holds it to that. (removed the roots whitelist the handler used to apply in the
// window's own session; the partition refusal is untouched and is what this proves.)
test('BB-C15: a page in the built-in browser cannot read local files via koloft-file://', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  // the secret sits OUTSIDE the workspace root the page is loaded from
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

  // the page has finished trying — the barrier before the negative assertions
  const result = guest.locator('#result')
  await expect(result).not.toBeEmpty({ timeout: 20_000 })

  const shown = (await result.textContent()) ?? ''
  expect(shown).not.toContain('koloft-e2e-secret-private-key')
  expect(shown).not.toMatch(/^status:200/)
})

// BB-C16 [SEC-2 regression] — the renderer runs a preload that exposes terminal:create
// and the account tokens, and it is reinjected after every navigation: a single
// successful navigation onto a remote origin is RCE + token theft. Neither an external
// link inside a markdown preview nor a scripted location assignment may move it, and
// "the renderer is fine" has to be proven on the live xterm instances too — a silent
// reload would look identical from the URL alone.
test('BB-C16: the Koloft renderer never navigates away from its app origin', async ({
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

    // the markdown preview, opened the way a user opens one — through the pinned `files`
    // tab's Browse half, which is where the former sidebar tree's job lives now (FR-44)
    await openInBrowse(page, path.join(env.workspaces.a, 'sec2.md'))
    await expect(page.locator(`${WORKBENCH.readingBody} .md-body`)).toBeVisible({
      timeout: 20_000
    })

    const appOrigin = page.url()
    const terms = await stampTerms(page)
    expect(terms.length).toBeGreaterThan(0)

    // ① the external md link
    await page.locator(`${WORKBENCH.readingBody} .md-body a`, { hasText: 'external' }).click()
    // barrier: the link landed in Browser (a guest fetched it), not nowhere
    await expect.poll(() => server.count('/p'), { timeout: 30_000 }).toBeGreaterThan(0)
    await guestByUrl(app, '/p')

    expect(page.url()).toBe(appOrigin)
    expect(await survivingTerms(page)).toEqual(terms)

    // ② a scripted navigation of the renderer itself
    await page.evaluate(() => {
      setTimeout(() => {
        window.location.href = 'http://evil.example/'
      }, 0)
    })
    // no positive signal exists for a navigation that must never happen — settle
    await page.waitForTimeout(3000)

    expect(page.url()).toBe(appOrigin)
    expect(await survivingTerms(page)).toEqual(terms)
  } finally {
    await server.close()
  }
})

// BB-C17 — the address bar is a scheme whitelist (SEC-13). `javascript:` typed into it
// is self-XSS against whatever page is loaded: it must neither be navigated to nor run.
test('BB-C17: the address bar rejects a javascript: URL', async ({ app, page, env }) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    await browserSession(page, env)
    const loaded = server.url('/a')
    await typeInAddressBar(page, loaded)
    await guestByUrl(app, loaded)

    await typeInAddressBar(page, 'javascript:alert(1)')
    // a refusal has no positive signal of its own; give the navigation/eval every
    // chance to happen before asserting that neither did
    await page.waitForTimeout(3000)

    // not navigated to
    const urls = (await guestContents(app)).map((g) => g.url)
    expect(urls.filter((u) => u.startsWith('javascript:'))).toEqual([])
    // not executed — the alert never reached the dialog surface
    await expect(page.locator(BROWSER.modal)).toHaveCount(0)
  } finally {
    await server.close()
  }
})

// BB-C19 — SEC-4: a remote page must not be able to make Koloft hand an arbitrary
// `file://` target to the OS. Clicking such a link is dropped with a prompt; the OS
// never sees it.
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

    // the user is told. The PRD fixes "drop + notify" but not its markup, so this accepts
    // either notice surface the app owns (the toast channel or the DOM modal).
    await expect(page.locator('.toast, .bmodal').first()).toBeVisible({ timeout: 20_000 })

    // dropped: no guest went to the file:// target …
    const urls = (await guestContents(app)).map((g) => g.url)
    expect(urls.filter((u) => u.startsWith('file:///Applications'))).toEqual([])
    // … and nothing was handed to the OS
    expect(osHandoffs(env).filter((l) => l.includes('Evil.app'))).toEqual([])
  } finally {
    await server.close()
  }
})

// BB-C20 — SEC-4 again, on the scheme axis: only http/https/mailto/tel are eligible for
// an OS hand-off, so a `zoommtg://` link in a remote page is dropped with a prompt
// rather than relayed to whatever handler the machine has registered.
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

    // the user is told (markup not fixed by the PRD — either notice surface counts)
    await expect(page.locator('.toast, .bmodal').first()).toBeVisible({ timeout: 20_000 })

    const urls = (await guestContents(app)).map((g) => g.url)
    expect(urls.filter((u) => u.startsWith('zoommtg:'))).toEqual([])
    expect(osHandoffs(env).filter((l) => l.includes('koloft-e2e-meeting'))).toEqual([])
  } finally {
    await server.close()
  }
})

// BB-C21 — the other half of SEC-4: `mailto:`/`tel:` ARE on the hand-off whitelist, but
// only a user click may fire one. A page that assigns the same scheme to location by
// itself gets nothing.
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

    // ① the page triggers the scheme itself — no user gesture anywhere
    await guest.evaluate(() => {
      setTimeout(() => {
        window.location.href = 'mailto:auto@koloft.test'
      }, 0)
    })
    await page.waitForTimeout(1500)

    // ② the user clicks the link
    await guest.locator('#link').click()

    // the user click reaches the OS — and doubles as the barrier proving the hand-off
    // path works at all, so the absence below is not vacuous
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

// BB-C23 — SEC-9: `item.getFilename()` is attacker-controlled. A suggested
// `../../evil.sh` must be reduced to its basename (no writing outside the download
// dir), a colliding name must be uniquified instead of silently overwriting, and a
// finished download is never auto-opened.
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
    // written under KOLOFT_DOWNLOAD_DIR under the sanitized basename alone
    await expect.poll(() => downloadedFiles(env), { timeout: 30_000 }).toEqual(['evil.sh'])
    // and nowhere above it
    expect(fs.existsSync(escaped)).toBe(false)

    // a second download whose name collides with the file just written
    await typeInAddressBar(
      page,
      server.url(`/download?name=evil.sh&body=${encodeURIComponent('koloft-e2e-second')}`)
    )
    await expect.poll(() => downloadedFiles(env).length, { timeout: 30_000 }).toBe(2)

    const files = downloadedFiles(env)
    for (const f of files) expect(f).not.toContain('/')
    // uniquified, not overwritten: the first file still holds the first body
    expect(fs.readFileSync(path.join(env.downloadDir, 'evil.sh'), 'utf8')).toContain(
      'koloft-e2e-first'
    )
    expect(new Set(files).size).toBe(2)

    // never auto-opened
    expect(osHandoffs(env).filter((l) => l.includes('evil.sh'))).toEqual([])
  } finally {
    await server.close()
  }
})

// BB-C26 — D11/SEC-6: the guests live in `persist:koloft-browser`, Koloft's own renderer in
// its default session. Neither may see the other's cookies, or a page a session opened
// could read state belonging to the app itself.
test("BB-C26: the guest partition is isolated from Koloft's own renderer storage", async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    await browserSession(page, env)

    // the guest sets a cookie on the fixture origin
    await typeInAddressBar(page, server.url('/cookie?name=koloft_guest&value=1'))
    const setter = await guestByUrl(app, '/cookie')
    await expect(setter.locator('#cookie-set')).toHaveText('koloft_guest=1', { timeout: 20_000 })

    // Koloft's own renderer session holds a cookie of its own on the very same origin
    await app.evaluate(
      ({ session }, origin) =>
        session.defaultSession.cookies.set({ url: origin, name: 'koloft_host', value: '1' }),
      server.origin
    )

    // what the guest sends on its next request: its own cookie, never Koloft's
    await typeInAddressBar(page, server.url('/echo'))
    const echo = await guestByUrl(app, '/echo')
    await expect(echo.locator('#cookie')).toContainText('koloft_guest=1', { timeout: 20_000 })
    expect((await echo.locator('#cookie').textContent()) ?? '').not.toContain('koloft_host')

    // and what Koloft's own session can see: its own cookie, never the guest's
    const hostCookies = await app.evaluate(({ session }) =>
      session.defaultSession.cookies.get({}).then((cs) => cs.map((c) => c.name))
    )
    expect(hostCookies).toContain('koloft_host')
    expect(hostCookies).not.toContain('koloft_guest')
  } finally {
    await server.close()
  }
})

// BB-C27 — SEC-5/SEC-6: the locked guest attribute set. A guest created without the
// partition falls back to the default session silently — which is where the privileged
// `koloft-file://` protocol lives, so a missed partition re-opens BB-C15 from inside a
// remote page.
test('BB-C27: every guest is created with the locked security attribute set', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    // Installed before any guest exists: EVERY <webview> attach passes through this
    // event whatever code path created it, so it reports the configuration of guests a
    // second, partition-less creation path would produce too (SEC-6).
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
            // the VALUE, not the key: Electron normalizes params and always carries this
            // key, so `'disablewebsecurity' in params` is true even for a guest that never
            // asked for it — an oracle that cannot tell a safe guest from an unsafe one.
            // Attribute values arrive as strings, so compare as one.
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

    // ① the <webview> tags as they stand in the host document
    const attrs = await webviewAttrs(page)
    expect(attrs.length).toBeGreaterThan(0)
    for (const a of attrs) {
      expect(a.partition).toBe('persist:koloft-browser')
      expect(a).not.toHaveProperty('disablewebsecurity')
      expect(a).not.toHaveProperty('preload')
      expect(a.nodeintegration ?? 'false').toBe('false')
    }

    // ② the preferences each guest was actually attached with
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

    // the two prefs that can also be turned off process-wide, where a per-guest value
    // would never show it
    const argv = (await app.evaluate(() => process.argv)).join(' ')
    expect(argv).not.toContain('--disable-web-security')
    expect(argv).not.toContain('--allow-file-access-from-files')

    // ③ no live guest fell back to the default session (where koloft-file:// lives)
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

// BB-C57 — SEC-14: `userData/opens` is a plain-umask directory, so its trust boundary
// is "any process of this user". Same-user is not a licence to skip validation: a URL
// dropped there runs the same scheme whitelist the address bar does.
test('BB-C57: a URL delivered through the open-requests directory gets the same scheme validation as the address bar', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    // no blank `web` tab in this Given: the whole assertion is how many tabs the dropped
    // requests minted, so the strip has to start with none of the user's own
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
    // a routable url dropped exactly the same way IS accepted — the barrier proving the
    // directory was processed at all, so the refusals below are not vacuous
    const accepted = server.url('/p')
    dropOpenRequest(env, { tabId, path: accepted, url: accepted })
    await expect.poll(() => openTabs(page).count(), { timeout: 30_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(2000)

    // only the routable one became a tab
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
