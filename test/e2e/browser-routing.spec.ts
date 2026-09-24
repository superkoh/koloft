import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import {
  auxIcon,
  centerTerm,
  clickAppMenuItem,
  FAKE_SESSION_TITLE,
  focusOwner,
  openSessionTerminal,
  panelTerm,
  runIn,
  startSessionIn,
  waitBooted
} from './helpers/p1'
import {
  OVERLAY,
  BROWSER,
  BROWSER_MENU_IDS,
  activeKind,
  addressField,
  addressValue,
  browserSurface,
  clickTerminalLink,
  downloadedFiles,
  globeHasUnread,
  globeIcon,
  guestByUrl,
  guestContents,
  newWebTab,
  openBrowser,
  openTabs,
  openViaAgent,
  readOpenCalls,
  typeInAddressBar,
  windowStates
} from './helpers/browser'
import {
  WORKBENCH,
  openInBrowse,
  showBrowse,
  wbActiveTab,
  wbTabTitles,
  wbUnreadTabs
} from './helpers/workbench'
import { hostResolverSwitch, startEchoServer } from './helpers/fixtureServer'

const NO_ROUTE_SETTLE_MS = 3000
const ADDRESS_BAR_REFUSAL_SETTLE_MS = 2500

async function guestUrls(app: ElectronApplication): Promise<string[]> {
  return (await guestContents(app)).map((g) => g.url)
}

// PLATFORM§2
async function runningSession(page: Page): Promise<void> {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await expect(page.locator('.ws-tab', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
    timeout: 40_000
  })
  await expect(auxIcon(page, 'Workbench')).toHaveAttribute('aria-disabled', 'false', {
    timeout: 60_000
  })
}

async function browserSession(page: Page): Promise<void> {
  await runningSession(page)
  await expect(globeIcon(page)).toBeVisible({ timeout: 30_000 })
  await openBrowser(page)
}

async function addressBarSession(page: Page): Promise<void> {
  await browserSession(page)
  await newWebTab(page)
  await expect(addressField(page)).toBeVisible({ timeout: 20_000 })
}

async function agentOpen(page: Page, target: string): Promise<void> {
  await openViaAgent(page, target)
  await expect(centerTerm(page)).toContainText('opened', { timeout: 30_000 })
}

async function addressText(page: Page): Promise<string> {
  return (await addressValue(page)).replace(/\s+/g, '')
}

function previewScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.querySelector('.fv-read .file-pane-body')
    if (!root) return -1
    let max = (root as HTMLElement).scrollTop
    for (const n of Array.from(root.querySelectorAll('*'))) {
      max = Math.max(max, (n as HTMLElement).scrollTop)
    }
    return max
  })
}

function termIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(
      (window as unknown as { __koloftTerms?: Record<string, unknown> }).__koloftTerms ?? {}
    ).sort()
  )
}

async function seedWorkspaceFile(
  page: Page,
  env: E2EEnv,
  rel: string,
  body: string
): Promise<void> {
  fs.writeFileSync(path.join(env.workspaces.a, rel), body)
  await showBrowse(page)
  await expect(page.locator(`${WORKBENCH.browseRows}.ft-file`, { hasText: rel })).toBeVisible({
    timeout: 30_000
  })
}

test.describe('URL routing and the open shim: where a target lands (a web tab, the reading area, the OS, or nowhere) and who may put it there', () => {
  test('BB-M01: agent `open http://localhost:PORT` lands a background Browser tab and never reaches the system browser', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await browserSession(page)
      await agentOpen(page, server.localhostUrl('/a'))

      await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
      await expect(wbUnreadTabs(page)).toHaveCount(1)
      expect((await wbTabTitles(page))[1]).toContain('localhost')

      expect(server.count()).toBe(0)
      expect(readOpenCalls(env).filter((l) => l.includes('http://'))).toEqual([])
      expect(await page.locator(OVERLAY.root).count()).toBe(0)
      expect(await page.locator(OVERLAY.entry).count()).toBe(0)
    } finally {
      await server.close()
    }
  })

  test('BB-M28: agent `open <bare .html path>` lands a background Browser tab, never Safari', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await browserSession(page)
    await agentOpen(page, 'docs/page.html')

    await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
    await expect(wbUnreadTabs(page)).toHaveCount(1)
    expect((await wbTabTitles(page))[1]).toContain('page.html')

    expect((await guestUrls(app)).filter((u) => u.includes('page.html'))).toEqual([])
    expect(readOpenCalls(env).filter((l) => l.includes('page.html'))).toEqual([])
  })

  test('BB-C11: an agent file-open never takes the panel away from the active web tab, while a user `open` of the same file from a shell still lands in Files', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await addressBarSession(page)
    expect(await activeKind(page)).toBe('web')
    const tabsBefore = await openTabs(page).count()

    await agentOpen(page, 'README.md')
    await page.waitForTimeout(NO_ROUTE_SETTLE_MS)

    expect(await activeKind(page)).toBe('web')
    expect(await openTabs(page).count()).toBe(tabsBefore)
    await expect(browserSurface(page)).toBeVisible()
    expect(await globeHasUnread(page)).toBe(false)

    await openSessionTerminal(app, page)
    // PLATFORM§2
    await runIn(
      page,
      panelTerm(page),
      `export PATH="${env.shimDir}:${env.fakeBin}:$PATH"; hash -r; cd '${env.workspaces.a}'; open README.md`
    )
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.md', { timeout: 30_000 })
  })

  test('BB-C14: agent request of a `file://` URL routes by extension, not by scheme bypass', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await browserSession(page)

    await agentOpen(page, `file://${env.workspaces.a}/README.md`)
    await showBrowse(page)
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.md', { timeout: 30_000 })
    await expect(openTabs(page)).toHaveCount(0)

    await agentOpen(page, `file://${env.workspaces.a}/docs/page.html`)
    await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
    expect((await wbTabTitles(page))[1]).toContain('page.html')
    await expect(wbUnreadTabs(page)).toHaveCount(1)
  })

  test('BB-C13: agent `open` of a non-http scheme still passes through to the OS unchanged', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await browserSession(page)
    await agentOpen(page, 'zoommtg://example')

    await expect
      .poll(() => readOpenCalls(env).join('\n'), { timeout: 30_000 })
      .toContain('zoommtg://example')
    await expect(openTabs(page)).toHaveCount(0)
  })

  test('BB-C50: an unsupported (non-web, non-previewable) `open` still passes through to the real `open`', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await runningSession(page)
    await agentOpen(page, 'notes.xyz')

    await expect
      .poll(() => readOpenCalls(env).join('\n'), { timeout: 30_000 })
      .toContain('notes.xyz')
    expect(await openTabs(page).count()).toBe(0)
    await showBrowse(page)
    expect(await page.locator(WORKBENCH.readingTitle).count()).toBe(0)
  })

  test('BB-M03: clicking a URL in the terminal opens it foreground in Browser without disturbing the TUI', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await runningSession(page)
      const url = server.localhostUrl('/a')
      await runIn(page, centerTerm(page), url)
      await expect(centerTerm(page)).toContainText('handled', { timeout: 30_000 })
      expect(await focusOwner(page)).toBe('tui')

      await clickTerminalLink(page, url)

      await expect(browserSurface(page)).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('web')
      await expect
        .poll(() => addressText(page), { timeout: 30_000 })
        .toContain(`localhost:${server.port}/a`)
      await expect.poll(() => server.count('/a'), { timeout: 30_000 }).toBeGreaterThan(0)
      expect(await focusOwner(page)).toBe('tui')
      await page.keyboard.type('koloft-e2e-still-typing')
      await page.keyboard.press('Enter')
      await expect(centerTerm(page)).toContainText('koloft-e2e-still-typing', { timeout: 30_000 })
      expect(readOpenCalls(env).filter((l) => l.includes('http://'))).toEqual([])
    } finally {
      await server.close()
    }
  })

  // PLATFORM§21
  test('a URL printed as a REAL hyperlink (OSC 8) routes into Koloft like any other, never through xterm’s own confirm + window.open', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    const dialogs: string[] = []
    page.on('dialog', (d) => {
      dialogs.push(d.message())
      void d.dismiss().catch(() => {})
    })
    try {
      await runningSession(page)
      const url = server.localhostUrl('osc8')
      await openSessionTerminal(app, page)
      const urlPrefixSoTheEchoIsNotALink = server.localhostUrl('')
      await runIn(
        page,
        panelTerm(page),
        `b='${urlPrefixSoTheEchoIsNotALink}'; printf '\\033]8;;%sosc8\\007%sosc8\\033]8;;\\007\\n' "$b" "$b"`
      )

      await clickTerminalLink(page, url, '.wb-panel')

      await expect(browserSurface(page)).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('web')
      await expect
        .poll(() => addressText(page), { timeout: 30_000 })
        .toContain(`localhost:${server.port}/osc8`)
      await expect.poll(() => server.count('/osc8'), { timeout: 30_000 }).toBeGreaterThan(0)
      expect(dialogs).toEqual([])
      expect(readOpenCalls(env).filter((l) => l.includes('http://'))).toEqual([])
    } finally {
      await server.close()
    }
  })

  test('BB-M06: a non-URL address-bar entry becomes a DuckDuckGo search', async ({ env }) => {
    test.setTimeout(180_000)
    env.extraArgs.push(hostResolverSwitch(['duckduckgo.com']))
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await addressBarSession(page)

      await typeInAddressBar(page, 'error message text')

      const targets = async (): Promise<string[]> => [
        await addressValue(page),
        ...(await guestUrls(app))
      ]
      await expect
        .poll(
          async () => (await targets()).some((u) => /^https?:\/\/[^/]*duckduckgo\.com\//.test(u)),
          {
            timeout: 30_000
          }
        )
        .toBe(true)
      const searched = (await targets()).filter((u) => /duckduckgo\.com/.test(u))
      expect(
        searched.some((u) =>
          decodeURIComponent(u).replace(/\+/g, ' ').includes('error message text')
        )
      ).toBe(true)
      expect((await targets()).some((u) => u.startsWith('http://error'))).toBe(false)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M21: an http(s) URL pointing at a `.pdf` renders in place, with no download', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await addressBarSession(page)
      await typeInAddressBar(page, server.url('/doc.pdf'))

      await expect.poll(() => server.count('/doc.pdf'), { timeout: 30_000 }).toBeGreaterThan(0)
      await expect
        .poll(async () => (await guestUrls(app)).some((u) => u.endsWith('.pdf')), {
          timeout: 30_000
        })
        .toBe(true)
      expect(await page.locator(BROWSER.errorPage).count()).toBe(0)
      expect(downloadedFiles(env)).toEqual([])
    } finally {
      await server.close()
    }
  })

  test('BB-M27: opening the same URL twice yields a single tab', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await runningSession(page)
      const url = server.localhostUrl('/a')

      await runIn(page, centerTerm(page), url)
      await clickTerminalLink(page, url)
      await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })

      await runIn(page, centerTerm(page), url)
      await clickTerminalLink(page, url)

      await expect(openTabs(page)).toHaveCount(1)
      await expect(wbActiveTab(page)).toHaveCount(1)
      await expect
        .poll(() => addressText(page), { timeout: 20_000 })
        .toContain(`localhost:${server.port}/a`)
    } finally {
      await server.close()
    }
  })

  test('a middle-click on a link in a guest page opens it as a background tab and keeps the current page', async ({
    app,
    page
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await addressBarSession(page)
      const target = server.url('/a')
      await typeInAddressBar(page, server.url(`/link?href=${encodeURIComponent(target)}`))
      const guest = await guestByUrl(app, '/link')
      await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
      const activeBefore = await page.locator(BROWSER.tabActive).innerText()

      await guest.locator('#link').click({ button: 'middle' })

      await expect(openTabs(page)).toHaveCount(2, { timeout: 30_000 })
      await expect(wbUnreadTabs(page)).toHaveCount(1)
      expect(await page.locator(BROWSER.tabActive).innerText()).toBe(activeBefore)
      expect(guest.url()).toContain('/link')
      await expect.poll(() => addressText(page)).toContain('/link')
    } finally {
      await server.close()
    }
  })

  test('BB-C18: the address bar rejects `data:`, `koloft-file:`, `devtools:`, and `chrome:` schemes', async ({
    env
  }) => {
    test.setTimeout(240_000)
    env.extraArgs.push(hostResolverSwitch(['duckduckgo.com']))
    const app = await launchApp(env)
    const server = await startEchoServer()
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await addressBarSession(page)
      const loaded = server.url('/a')
      await typeInAddressBar(page, loaded)
      await guestByUrl(app, loaded)

      for (const input of [
        'data:text/html,x',
        'koloft-file://localhost/etc/hosts',
        'devtools://x',
        'chrome://settings'
      ]) {
        await typeInAddressBar(page, input)
        await page.waitForTimeout(ADDRESS_BAR_REFUSAL_SETTLE_MS)
        const scheme = input.slice(0, input.indexOf(':') + 1)
        expect((await guestUrls(app)).filter((u) => u.startsWith(scheme))).toEqual([])
      }
      expect(await guestUrls(app)).toContain(loaded)
    } finally {
      await server.close()
      await app.close().catch(() => {})
    }
  })

  test('BB-C28: `chrome://` and `devtools://` are hard-blocked with no navigation', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await addressBarSession(page)

      const linkPage = server.url(
        `/link?href=${encodeURIComponent('devtools://devtools/bundled/inspector.html')}`
      )
      await typeInAddressBar(page, linkPage)
      const guest = await guestByUrl(app, '/link')
      await guest.locator('#link').click()
      await page.waitForTimeout(NO_ROUTE_SETTLE_MS)
      expect((await guestUrls(app)).filter((u) => u.startsWith('devtools:'))).toEqual([])

      await agentOpen(page, 'chrome://settings')
      expect((await guestUrls(app)).filter((u) => u.startsWith('chrome:'))).toEqual([])
    } finally {
      await server.close()
    }
  })

  test('BB-C30: `data:` is allowed only from a user source, not from the address bar or agent', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await addressBarSession(page)
      const userData = 'data:text/html,koloft-e2e-data-user'

      await typeInAddressBar(page, server.url(`/link?href=${encodeURIComponent(userData)}`))
      const guest = await guestByUrl(app, '/link')
      await guest.locator('#link').click()
      await expect
        .poll(async () => (await guestUrls(app)).some((u) => u.includes('koloft-e2e-data-user')), {
          timeout: 30_000
        })
        .toBe(true)

      await agentOpen(page, 'data:text/html,koloft-e2e-data-agent')
      expect((await guestUrls(app)).filter((u) => u.includes('koloft-e2e-data-agent'))).toEqual([])

      await typeInAddressBar(page, 'data:text/html,koloft-e2e-data-addr')
      await page.waitForTimeout(NO_ROUTE_SETTLE_MS)
      expect((await guestUrls(app)).filter((u) => u.includes('koloft-e2e-data-addr'))).toEqual([])
    } finally {
      await server.close()
    }
  })

  test('BB-C31: a `file://` URL pointing at a directory shows the Chromium directory listing', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await addressBarSession(page)
    const dir = `file://${env.workspaces.a}/docs/`

    await typeInAddressBar(page, dir)

    const guest = await guestByUrl(app, `${env.workspaces.a}/docs/`)
    await expect(guest.locator('body')).toContainText('page.html', { timeout: 30_000 })
    expect(await page.locator(BROWSER.errorPage).count()).toBe(0)
    expect(downloadedFiles(env)).toEqual([])
  })

  test('BB-C29: `about:blank` is a legal new-tab initial state', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    await browserSession(page)

    await newWebTab(page)
    await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })

    expect(await page.locator(BROWSER.errorPage).count()).toBe(0)
    await expect(addressField(page)).toBeVisible()
    for (const u of await guestUrls(app)) expect(['', 'about:blank']).toContain(u)
  })

  test('BB-C25: a guest `window.close()` closes only its own tab, never the host window (its second tab comes from View ▸ New Browser Tab, the one witness that menu tab commands reach the panel)', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await addressBarSession(page)
      await typeInAddressBar(page, server.url('/a'))
      await guestByUrl(app, '/a')

      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.newTab)
      await typeInAddressBar(page, server.url('/close?n=1'))
      const first = await guestByUrl(app, '/close?n=1')
      await expect(openTabs(page)).toHaveCount(2, { timeout: 30_000 })

      await first.locator('#close-me').click()

      await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
      expect((await windowStates(app)).length).toBe(1)
      await expect(browserSurface(page)).toBeVisible()

      await typeInAddressBar(page, server.url('/close?n=2'))
      const last = await guestByUrl(app, '/close?n=2')
      await last.locator('#close-me').click()
      await expect(openTabs(page)).toHaveCount(0, { timeout: 30_000 })
      await expect(browserSurface(page)).toBeVisible()
      await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
      expect((await windowStates(app)).length).toBe(1)
    } finally {
      await server.close()
    }
  })

  test('BB-C52: an md `#anchor` link scrolls within Preview without navigating the renderer', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await runningSession(page)
    await seedWorkspaceFile(
      page,
      env,
      'mdanchor.md',
      '# Anchor fixture\n\n[jump to section](#section)\n\n' +
        Array.from({ length: 200 }, (_, i) => `filler line ${i}`).join('\n\n') +
        '\n\n## Section\n\nkoloft-e2e-anchor-body\n'
    )
    await openInBrowse(page, path.join(env.workspaces.a, 'mdanchor.md'))
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('mdanchor.md', {
      timeout: 30_000
    })
    const rendererUrl = page.url()
    const terms = await termIds(page)
    expect(await previewScrollTop(page)).toBe(0)

    await page.locator(`${WORKBENCH.readingBody} a`, { hasText: 'jump to section' }).click()

    await expect.poll(() => previewScrollTop(page), { timeout: 20_000 }).toBeGreaterThan(0)
    expect(page.url()).toBe(rendererUrl)
    expect(await termIds(page)).toEqual(terms)
  })

  test('BB-C53: an md relative link to a previewable file opens that file in Preview', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await runningSession(page)
    await seedWorkspaceFile(page, env, 'mdtarget.md', '# Target\n\nkoloft-e2e-md-target-body\n')
    await seedWorkspaceFile(
      page,
      env,
      'mdrelative.md',
      '# Relative\n\n[go to target](./mdtarget.md)\n'
    )
    await openInBrowse(page, path.join(env.workspaces.a, 'mdrelative.md'))
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('mdrelative.md', {
      timeout: 30_000
    })
    const rendererUrl = page.url()

    await page.locator(`${WORKBENCH.readingBody} a`, { hasText: 'go to target' }).click()

    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('mdtarget.md', {
      timeout: 30_000
    })
    await expect(page.locator(WORKBENCH.readingBody)).toContainText('koloft-e2e-md-target-body')
    expect(page.url()).toBe(rendererUrl)
  })

  test('BB-C54: an md external link opens in Browser, not in the renderer', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await runningSession(page)
      const url = server.url('/a')
      await seedWorkspaceFile(page, env, 'mdexternal.md', `# External\n\n[open the page](${url})\n`)
      await openInBrowse(page, path.join(env.workspaces.a, 'mdexternal.md'))
      await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('mdexternal.md', {
        timeout: 30_000
      })
      const rendererUrl = page.url()

      await page.locator(`${WORKBENCH.readingBody} a`, { hasText: 'open the page' }).click()

      await expect(browserSurface(page)).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('web')
      await expect
        .poll(() => addressText(page), { timeout: 30_000 })
        .toContain(`${server.host}:${server.port}/a`)
      await expect.poll(() => server.count('/a'), { timeout: 30_000 }).toBeGreaterThan(0)
      expect(page.url()).toBe(rendererUrl)
    } finally {
      await server.close()
    }
  })
})
