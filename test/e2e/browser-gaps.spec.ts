import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { setGuestLimit, type E2EEnv } from './helpers/env'
import {
  auxIcon,
  centerTerm,
  clickAppMenuItem,
  gitInit,
  runIn,
  startSessionIn,
  wsRows
} from './helpers/p1'
import {
  BROWSER,
  BROWSER_MENU_IDS,
  activeKind,
  activeSurface,
  addressField,
  addressValue,
  browserSurface,
  crashGuest,
  downloadedFiles,
  dropOpenRequest,
  globeHasUnread,
  globeIcon,
  guestByUrl,
  guestContents,
  guestPages,
  newWebTab,
  openBrowser,
  openTabs,
  openViaAgent,
  pinnedTab,
  readExternalOpens,
  readOpenCalls,
  typeInAddressBar,
  windowStates
} from './helpers/browser'
import {
  WORKBENCH,
  openInBrowse,
  wbFrozenTabs,
  wbTabByTitle,
  wbTabTitles,
  wbUnreadTabs
} from './helpers/workbench'
import {
  BASIC_CREDENTIALS,
  startEchoServer,
  startHttpsServer,
  type FixtureServer
} from './helpers/fixtureServer'

test.describe('Workbench browser cases between the other browser specs: agent opens, keys, session tab sets, dedup and caps, devtools, crash, dialogs, clear-data, and the zero-external-open flow', () => {
  const PINNED_FILES_TAB_LABEL = 'Files'
  const PER_SESSION_TAB_CAP = 8
  const FLOOD_OPENS = 12
  const UNIQUELY_TITLED_HISTORY_FRAGMENT = 'storag'

  function titled(name: string): string {
    return (
      `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head>` +
      `<body><h1 id="mark">${name}</h1></body></html>`
    )
  }

  async function runningSession(page: Page, env: E2EEnv): Promise<void> {
    gitInit(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
  }

  async function browserSession(page: Page, env: E2EEnv): Promise<void> {
    await runningSession(page, env)
    await showWorkbench(page)
  }

  async function showWorkbench(page: Page): Promise<void> {
    await expect(globeIcon(page)).toBeVisible({ timeout: 30_000 })
    await openBrowser(page)
  }

  async function addressBarSession(page: Page, env: E2EEnv): Promise<void> {
    await browserSession(page, env)
    await newWebTab(page)
    await expect(addressField(page)).toBeVisible({ timeout: 20_000 })
  }

  async function openTabOn(page: Page, url: string): Promise<void> {
    await newWebTab(page)
    await expect(addressField(page)).toBeVisible({ timeout: 20_000 })
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

  function terminalScrollback(page: Page): Promise<string> {
    return page.evaluate(() => {
      interface Line {
        translateToString(trim?: boolean): string
      }
      interface Buf {
        length: number
        getLine(i: number): Line | undefined
      }
      const reg =
        (window as unknown as { __koloftTerms?: Record<string, { buffer?: { active?: Buf } }> })
          .__koloftTerms ?? {}
      let out = ''
      for (const term of Object.values(reg)) {
        const buf = term?.buffer?.active
        if (!buf) continue
        let text = ''
        for (let i = 0; i < buf.length; i++) {
          text += `${buf.getLine(i)?.translateToString(true) ?? ''}\n`
        }
        if (text.includes('[fake-claude]')) out += text
      }
      return out
    })
  }

  async function openedCount(page: Page): Promise<number> {
    return ((await terminalScrollback(page)).match(/\]\s+opened\s/g) ?? []).length
  }

  async function agentOpen(page: Page, target: string): Promise<void> {
    const before = await openedCount(page)
    await openViaAgent(page, target)
    await expect.poll(() => openedCount(page), { timeout: 40_000 }).toBeGreaterThan(before)
  }

  async function guestUrls(app: ElectronApplication): Promise<string[]> {
    return (await guestContents(app)).map((g) => g.url)
  }

  // PLATFORM§10
  function activeElementInside(page: Page, selector: string): Promise<boolean> {
    return page.evaluate((sel) => {
      const el = document.activeElement as HTMLElement | null
      return !!el && (el.matches(sel) || el.closest(sel) !== null)
    }, selector)
  }

  async function tuiWidth(page: Page): Promise<number> {
    const box = await page.locator('.term-island').first().boundingBox()
    return box ? Math.round(box.width) : 0
  }

  test('BB-M02: user clicking the agent-created tab loads it for the first time and clears the unread marker', async ({
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      await browserSession(page, env)
      await agentOpen(page, server.localhostUrl('/a'))

      await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
      await expect(wbUnreadTabs(page)).toHaveCount(1)
      expect(server.count()).toBe(0)

      await openTabs(page).first().click()

      await expect.poll(() => server.count('/a'), { timeout: 30_000 }).toBe(1)
      expect(server.count()).toBe(1)
      await expect(openTabs(page).first()).toHaveClass(/\bon\b/, { timeout: 20_000 })
      await expect(wbUnreadTabs(page)).toHaveCount(0)
    } finally {
      await server.close()
    }
  })

  test('BB-M13: ⌘⇧B opens the Workbench and toggles it closed again, giving the TUI its width back', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    await runningSession(page, env)

    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.toggle)
    await expect(browserSurface(page)).toBeHidden({ timeout: 20_000 })
    const collapsedWidth = await tuiWidth(page)
    expect(collapsedWidth).toBeGreaterThan(0)

    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.toggle)

    await expect(browserSurface(page)).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
    await expect.poll(() => tuiWidth(page), { timeout: 20_000 }).toBeLessThan(collapsedWidth)

    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.toggle)

    await expect(browserSurface(page)).toBeHidden({ timeout: 20_000 })
    await expect.poll(() => tuiWidth(page), { timeout: 20_000 }).toBe(collapsedWidth)
  })

  test('BB-M14: switching sessions swaps the entire tab set', async ({ page }) => {
    test.setTimeout(360_000)
    const server = await startEchoServer()
    try {
      await startSessionIn(page, 'ws-a')
      await startSessionIn(page, 'ws-b')
      const rowA = wsRows(page, 'ws-a').first()
      const rowB = wsRows(page, 'ws-b').first()

      await rowA.click()
      await showWorkbench(page)
      await openLoadedTab(page, server, 'X')
      await openLoadedTab(page, server, 'Y')
      await expect.poll(() => wbTabTitles(page)).toEqual([PINNED_FILES_TAB_LABEL, 'X', 'Y'])

      await rowB.click()
      await expect(rowB).toHaveClass(/\bactive\b/, { timeout: 20_000 })
      await showWorkbench(page)
      await openLoadedTab(page, server, 'Z')
      await expect.poll(() => wbTabTitles(page)).toEqual([PINNED_FILES_TAB_LABEL, 'Z'])

      await rowA.click()
      await expect(rowA).toHaveClass(/\bactive\b/, { timeout: 20_000 })
      await showWorkbench(page)
      await expect.poll(() => wbTabTitles(page)).toEqual([PINNED_FILES_TAB_LABEL, 'X', 'Y'])

      await rowB.click()
      await expect(rowB).toHaveClass(/\bactive\b/, { timeout: 20_000 })
      await showWorkbench(page)
      await expect.poll(() => wbTabTitles(page)).toEqual([PINNED_FILES_TAB_LABEL, 'Z'])
    } finally {
      await server.close()
    }
  })

  test('BB-M15: the reading area no longer renders web pages — only the file’s own views remain', async ({
    page,
    env
  }) => {
    test.setTimeout(240_000)
    await runningSession(page, env)

    await openInBrowse(page, path.join(env.workspaces.a, 'README.md'))
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.md', { timeout: 30_000 })

    const segs = page.locator(
      `${WORKBENCH.panel} .fv-artifact-hd .seg[aria-label="View mode"] button`
    )
    await expect(segs).toHaveText(['Rendered', 'Diff', 'Source'])
    const col = page.locator(`${WORKBENCH.panel} .fv-read`)
    await expect(col).toHaveCount(1)
    expect(await col.locator('.baddr').count()).toBe(0)
    expect(await col.locator(BROWSER.tabStrip).count()).toBe(0)
    expect(await col.locator('[aria-label="Back"], [aria-label="Forward"]').count()).toBe(0)
    expect(await page.locator(BROWSER.addressBar).count()).toBe(0)

    await openInBrowse(page, path.join(env.workspaces.a, 'docs', 'page.html'))
    await page.waitForTimeout(4000)
    expect(
      await page
        .locator(`${WORKBENCH.panel} .fv-read webview, ${WORKBENCH.panel} .fv-read iframe`)
        .count()
    ).toBe(0)
    expect(await page.locator(WORKBENCH.readingTitle, { hasText: 'page.html' }).count()).toBe(0)
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('web')
  })

  test('BB-M25: a URL printed in the terminal is clickable (WebLinks addon present)', async ({
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      await runningSession(page, env)
      const url = server.localhostUrl('/a')

      await runIn(page, centerTerm(page), url)
      await expect.poll(() => terminalScrollback(page), { timeout: 40_000 }).toContain(url)

      const probe = await page.evaluate(async (target: string) => {
        interface Line {
          translateToString(trim?: boolean): string
        }
        interface Term {
          rows: number
          buffer?: { active?: { length: number; getLine(i: number): Line | undefined } }
          _core?: {
            _linkProviderService?: {
              linkProviders?: {
                provideLinks(y: number, cb: (links?: { text?: string }[]) => void): void
              }[]
            }
          }
        }
        const reg =
          (window as unknown as { __koloftTerms?: Record<string, Term> }).__koloftTerms ?? {}
        const holds = (t: Term): boolean => {
          const buf = t.buffer?.active
          if (!buf) return false
          for (let i = 0; i < buf.length; i++) {
            if ((buf.getLine(i)?.translateToString(true) ?? '').includes(target)) return true
          }
          return false
        }
        const term = Object.values(reg).find(holds)
        if (!term) return { printed: false, linkTexts: [] as string[] }

        const providers = term._core?._linkProviderService?.linkProviders ?? []
        const linkTexts: string[] = []
        for (let y = 1; y <= term.rows; y++) {
          for (const provider of providers) {
            const links = await new Promise<{ text?: string }[] | undefined>((resolve) => {
              let settled = false
              const done = (v?: { text?: string }[]): void => {
                if (settled) return
                settled = true
                resolve(v)
              }
              setTimeout(() => done(undefined), 400)
              try {
                provider.provideLinks(y, done)
              } catch {
                done(undefined)
              }
            })
            for (const link of links ?? []) linkTexts.push(String(link.text ?? ''))
          }
        }
        return { printed: true, linkTexts }
      }, url)

      expect(probe.printed).toBe(true)
      expect(probe.linkTexts.some((t) => t.includes(url))).toBe(true)
    } finally {
      await server.close()
    }
  })

  test('BB-C02: agent re-open of an existing URL only sets the unread dot, current tab unchanged', async ({
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      await browserSession(page, env)

      await openLoadedTab(page, server, 'A')
      await openLoadedTab(page, server, 'B')
      await wbTabByTitle(page, 'A').click()
      await expect(wbTabByTitle(page, 'A')).toHaveClass(/\bon\b/, { timeout: 20_000 })
      await expect(wbUnreadTabs(page)).toHaveCount(0)

      await agentOpen(page, server.url('/b'))

      await expect(wbTabByTitle(page, 'B')).toHaveClass(/\bagent\b/, { timeout: 30_000 })
      await expect(openTabs(page)).toHaveCount(2)
      await expect(wbTabByTitle(page, 'A')).toHaveClass(/\bon\b/)
      await expect(wbTabByTitle(page, 'B')).not.toHaveClass(/\bon\b/)
    } finally {
      await server.close()
    }
  })

  test('BB-C03: dedup ignores #hash but the per-session cap still blocks #1..#N tab-flooding', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      await addressBarSession(page, env)

      await typeInAddressBar(page, server.url('/p#one'))
      await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
      await openTabOn(page, server.page('/q', titled('Q')))
      await expect(openTabs(page)).toHaveCount(2, { timeout: 30_000 })

      await agentOpen(page, server.url('/p#two'))
      await expect(wbUnreadTabs(page)).toHaveCount(1, { timeout: 30_000 })
      await page.waitForTimeout(3000)
      expect(await openTabs(page).count()).toBe(2)

      const flood = server.page(
        '/flood',
        '<!doctype html><html><head><meta charset="utf-8"><title>Flood</title></head><body>' +
          '<button id="go">go</button><div id="fired"></div><script>' +
          'document.getElementById("go").addEventListener("click", function () {' +
          '  var n = 0;' +
          '  for (var i = 1; i <= ' +
          FLOOD_OPENS +
          '; i++) { window.open("/p#" + i, "_blank"); n++ }' +
          '  document.getElementById("fired").textContent = String(n)' +
          '})</script></body></html>'
      )
      await openTabOn(page, flood)
      const guest = await guestByUrl(app, '/flood')
      await guest.locator('#go').click()

      await expect(guest.locator('#fired')).toHaveText(String(FLOOD_OPENS), { timeout: 30_000 })
      await page.waitForTimeout(5000)
      expect(await openTabs(page).count()).toBeLessThanOrEqual(PER_SESSION_TAB_CAP)
    } finally {
      await server.close()
    }
  })

  test('BB-C09: an agent-opened tab is never loaded until the user opens it, even with the panel open', async ({
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      await browserSession(page, env)

      await agentOpen(page, server.localhostUrl('/a'))
      await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })

      expect(server.count()).toBe(0)
      await page.waitForTimeout(5000)
      expect(server.count()).toBe(0)
    } finally {
      await server.close()
    }
  })

  test('BB-C10: no agent action changes the current tab or the panel open/collapsed state, and the titlebar gives no signal', async ({
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      await browserSession(page, env)

      await openLoadedTab(page, server, 'A')
      await expect(wbTabByTitle(page, 'A')).toHaveClass(/\bon\b/, { timeout: 20_000 })

      await agentOpen(page, server.url('/b'))
      await agentOpen(page, server.url('/next'))

      await expect(wbUnreadTabs(page)).toHaveCount(2, { timeout: 40_000 })
      await expect(wbTabByTitle(page, 'A')).toHaveClass(/\bon\b/)
      expect(await activeKind(page)).toBe('web')
      await expect(browserSurface(page)).toBeVisible()

      await globeIcon(page).click()
      await expect(browserSurface(page)).toBeHidden({ timeout: 20_000 })

      await agentOpen(page, server.url('/p'))
      await page.waitForTimeout(5000)

      await expect(browserSurface(page)).toBeHidden()
      expect(await activeSurface(page)).toBeNull()
      expect(await globeHasUnread(page)).toBe(false)
      await expect(globeIcon(page)).not.toHaveClass(/\bon\b/)

      await showWorkbench(page)
      await expect(wbUnreadTabs(page)).toHaveCount(3, { timeout: 20_000 })
      await expect(wbTabByTitle(page, 'A')).toHaveClass(/\bon\b/)
    } finally {
      await server.close()
    }
  })

  test('BB-C08: the global live-guest cap is enforced across two sessions at once', async ({
    env
  }) => {
    test.setTimeout(420_000)
    setGuestLimit(env, 2)
    const server = await startEchoServer()
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await startSessionIn(page, 'ws-a')
      await startSessionIn(page, 'ws-b')
      const rowA = wsRows(page, 'ws-a').first()
      const rowB = wsRows(page, 'ws-b').first()

      await rowA.click()
      await expect(rowA).toHaveClass(/\bactive\b/, { timeout: 20_000 })
      await showWorkbench(page)
      await openLoadedTab(page, server, 'T1')

      await rowB.click()
      await expect(rowB).toHaveClass(/\bactive\b/, { timeout: 20_000 })
      await showWorkbench(page)
      await openLoadedTab(page, server, 'T2')
      const liveGuests = async (): Promise<number> =>
        (await guestContents(app)).filter((g) => g.url.startsWith(server.origin)).length
      await expect.poll(liveGuests, { timeout: 30_000 }).toBe(2)

      await openLoadedTab(page, server, 'T3')

      const samples: number[] = []
      for (let i = 0; i < 8; i++) {
        samples.push(await liveGuests())
        await page.waitForTimeout(250)
      }
      expect(Math.max(...samples)).toBeLessThanOrEqual(2)

      await rowA.click()
      await expect(rowA).toHaveClass(/\bactive\b/, { timeout: 20_000 })
      await showWorkbench(page)
      await expect(wbTabByTitle(page, 'T1')).toHaveClass(/\bfrozen\b/, { timeout: 30_000 })
    } finally {
      await app.close().catch(() => {})
      await server.close()
    }
  })

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
          for (const file of files) {
            try {
              const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as { tabId?: string }
              if (rec.tabId) {
                tabId = rec.tabId
                return tabId
              }
            } catch {
              continue
            }
          }
          return ''
        },
        { timeout: 30_000 }
      )
      .not.toBe('')
    return tabId
  }

  function apiFunctionPaths(page: Page): Promise<string[]> {
    return page.evaluate(() => {
      const out: string[] = []
      const walk = (obj: unknown, prefix: string, depth: number): void => {
        if (!obj || typeof obj !== 'object' || depth > 4) return
        for (const key of Object.keys(obj as Record<string, unknown>)) {
          const value = (obj as Record<string, unknown>)[key]
          const dotted = prefix ? `${prefix}.${key}` : key
          if (typeof value === 'function') out.push(dotted)
          else if (value && typeof value === 'object') walk(value, dotted, depth + 1)
        }
      }
      walk((window as unknown as { api?: unknown }).api, '', 0)
      return out.sort()
    })
  }

  test('BB-C12: the open-request channel and the preload bridge still cannot drive a page; only the gated CDP relay can', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      await addressBarSession(page, env)

      const probeUrl = server.page(
        '/probe',
        '<!doctype html><html><head><meta charset="utf-8"><title>Probe</title></head>' +
          '<body><div id="probe">untouched</div><a id="link" href="/b">go</a></body></html>'
      )
      await typeInAddressBar(page, probeUrl)
      const guest = await guestByUrl(app, '/probe')
      await expect(guest.locator('#probe')).toHaveText('untouched', { timeout: 30_000 })

      const tabId = await sessionTabId(env)
      const next = server.url('/next')
      dropOpenRequest(env, { tabId, path: next, url: next })
      await expect(openTabs(page)).toHaveCount(2, { timeout: 40_000 })

      dropOpenRequest(env, {
        tabId,
        path: probeUrl,
        url: probeUrl,
        js: 'document.getElementById("probe").textContent = "driven"',
        script: 'document.getElementById("probe").textContent = "driven"',
        action: 'click',
        selector: '#link'
      })
      await page.waitForTimeout(6000)

      expect(await guest.locator('#probe').textContent()).toBe('untouched')
      expect(guest.url()).toContain('/probe')

      const paths = await apiFunctionPaths(page)
      expect(paths.length).toBeGreaterThan(0)
      const guestScoped = paths.filter((p) => /browser|guest|webview|tab/i.test(p))
      const driving = guestScoped.filter((p) =>
        /execute|eval|script|insertcss|capture|screenshot|screencast|sendinput|mouse|click|hover|sendkey|typetext|fill|selector|innerhtml|outerhtml|innertext|textcontent|getdom|readdom/i.test(
          p
        )
      )
      expect(driving).toEqual([])
    } finally {
      await server.close()
    }
  })

  test('BB-C24: `target=_blank` never opens a system browser window', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      await addressBarSession(page, env)
      const openCallsBefore = readOpenCalls(env)
      const externalBefore = readExternalOpens(env)

      await typeInAddressBar(page, server.url('/link?href=/b&blank=1'))
      const opener = await guestByUrl(app, '/link')
      const windowsBefore = (await windowStates(app)).length

      await opener.locator('#link').click()

      await expect(openTabs(page)).toHaveCount(2, { timeout: 30_000 })
      await guestByUrl(app, `:${server.port}/b`)
      await expect.poll(() => server.count('/b'), { timeout: 30_000 }).toBeGreaterThan(0)
      expect((await windowStates(app)).length).toBe(windowsBefore)
      expect(readOpenCalls(env)).toEqual(openCallsBefore)
      expect(readExternalOpens(env)).toEqual(externalBefore)
    } finally {
      await server.close()
    }
  })

  test('BB-C33: with no selected running session the Workbench icon is disabled', async ({
    page
  }) => {
    test.setTimeout(120_000)
    await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 30_000 })
    await expect(page.locator('.ws-tab')).toHaveCount(0)

    await expect(page.locator('.aux-icons .aux-ico')).toHaveCount(1, { timeout: 20_000 })
    await expect(auxIcon(page, 'Preview')).toHaveCount(0)
    await expect(globeIcon(page)).toBeVisible({ timeout: 20_000 })
    await expect(globeIcon(page)).toHaveAttribute('aria-disabled', 'true')
    await expect(auxIcon(page, 'Terminal')).toHaveCount(0)
  })

  test('BB-C34: ⌘L pressed inside a focused guest focuses the host address bar with the url selected', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      await addressBarSession(page, env)
      await typeInAddressBar(page, server.url('/a'))
      const guest = await guestByUrl(app, `:${server.port}/a`)
      await guest.locator('#page-a').click({ timeout: 20_000 })

      await guest.keyboard.press('Meta+l')

      await expect
        .poll(() => activeElementInside(page, BROWSER.addressBar), { timeout: 20_000 })
        .toBe(true)
      const field = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        if (!el) return { editable: false, selectedAll: false }
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const len = el.value.length
          return {
            editable: !el.readOnly && !el.disabled,
            selectedAll: len > 0 && el.selectionStart === 0 && el.selectionEnd === len
          }
        }
        const text = (el.textContent ?? '').trim()
        return {
          editable: el.isContentEditable,
          selectedAll: text.length > 0 && (window.getSelection()?.toString().trim() ?? '') === text
        }
      })
      expect(field.editable).toBe(true)
      expect(field.selectedAll).toBe(true)
    } finally {
      await server.close()
    }
  })

  test('BB-C38: ⌘[ and ⌘] drive back/forward when the Browser is focused', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      await addressBarSession(page, env)
      await typeInAddressBar(page, server.url('/a'))
      const guest = await guestByUrl(app, `:${server.port}/a`)

      await guest.locator('#to-b').click()
      await expect.poll(() => addressValue(page), { timeout: 30_000 }).toContain('/b')

      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.back)
      await expect.poll(() => addressValue(page), { timeout: 30_000 }).toContain('/a')
      await expect
        .poll(async () => (await guestUrls(app)).some((u) => u.endsWith('/a')), { timeout: 30_000 })
        .toBe(true)

      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.forward)
      await expect.poll(() => addressValue(page), { timeout: 30_000 }).toContain('/b')
      await expect
        .poll(async () => (await guestUrls(app)).some((u) => u.endsWith('/b')), { timeout: 30_000 })
        .toBe(true)
    } finally {
      await server.close()
    }
  })

  test('BB-C44: a crashed guest shows a crash placeholder with a manual reload, no auto-reload', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      await addressBarSession(page, env)
      await typeInAddressBar(page, server.url('/a'))
      await guestByUrl(app, `:${server.port}/a`)
      await expect.poll(() => server.count('/a'), { timeout: 30_000 }).toBe(1)

      await crashGuest(app, `:${server.port}/a`)

      const placeholder = page.locator(BROWSER.crashPlaceholder)
      await expect(placeholder).toBeVisible({ timeout: 30_000 })
      const reload = placeholder.locator('button', { hasText: /Reload/i })
      await expect(reload).toBeVisible()

      await page.waitForTimeout(6000)
      expect(server.count('/a')).toBe(1)

      await reload.click()
      await expect.poll(() => server.count('/a'), { timeout: 30_000 }).toBe(2)
    } finally {
      await server.close()
    }
  })

  // PLATFORM§18
  function clickThatSettlesOnlyAfterTheModalIsAnswered(target: Locator): Promise<void> {
    return target.click()
  }

  async function acceptModal(page: Page, text?: string): Promise<void> {
    const modal = page.locator(BROWSER.modal)
    await expect(modal).toBeVisible({ timeout: 30_000 })
    if (text !== undefined) {
      const field = modal.locator('input').first()
      await field.click()
      await field.fill(text)
    }
    const primary = modal.locator('.btn-primary')
    if ((await primary.count()) > 0) await primary.first().click()
    else await modal.locator('button').last().click()
    await expect(modal).toHaveCount(0, { timeout: 20_000 })
  }

  test('BB-C45: JS dialogs use a DOM modal, not a native dialog', async ({ app, page, env }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      await addressBarSession(page, env)
      await typeInAddressBar(page, server.url('/dialogs'))
      const guest = await guestByUrl(app, '/dialogs')

      const alerted = clickThatSettlesOnlyAfterTheModalIsAnswered(guest.locator('#do-alert'))
      const modal = page.locator(BROWSER.modal)
      await expect(modal).toBeVisible({ timeout: 30_000 })
      await expect(modal).toContainText('koloft alert')
      await expect(modal).toContainText(`${server.host}:${server.port}`)
      await acceptModal(page)
      await alerted
      await expect(guest.locator('#result')).toHaveText('alert-returned', { timeout: 20_000 })

      const confirmed = clickThatSettlesOnlyAfterTheModalIsAnswered(guest.locator('#do-confirm'))
      await acceptModal(page)
      await confirmed
      await expect(guest.locator('#result')).toHaveText('confirm:true', { timeout: 20_000 })

      const prompted = clickThatSettlesOnlyAfterTheModalIsAnswered(guest.locator('#do-prompt'))
      await acceptModal(page, 'koloft-e2e-prompt')
      await prompted
      await expect(guest.locator('#result')).toHaveText('prompt:koloft-e2e-prompt', {
        timeout: 20_000
      })
    } finally {
      await server.close()
    }
  })

  test('BB-C47: an agent-created tab that is opened by the user reuses the freeze/reload mechanism', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const server = await startEchoServer()
    try {
      await browserSession(page, env)
      const url = server.localhostUrl('/a')
      await agentOpen(page, url)
      await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })

      expect(server.count('/a')).toBe(0)
      expect((await guestUrls(app)).filter((u) => u.includes(`:${server.port}/a`))).toEqual([])

      await openTabs(page).first().click()

      await expect.poll(() => server.count('/a'), { timeout: 30_000 }).toBe(1)
      await guestByUrl(app, `:${server.port}/a`)
      await expect(wbFrozenTabs(page)).toHaveCount(0)
    } finally {
      await server.close()
    }
  })

  test('BB-C58: dedup key normalization treats trailing-slash / default-port / case / query-order variants as the same tab', async ({
    page,
    env
  }) => {
    test.setTimeout(420_000)
    const server = await startEchoServer()
    try {
      await browserSession(page, env)
      const base = `http://localhost:${server.port}`
      const settledTabs = async (): Promise<number> => {
        await page.waitForTimeout(3000)
        return openTabs(page).count()
      }

      await agentOpen(page, `${base}/p?a=1&b=2`)
      await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })

      await agentOpen(page, `${base}/p/?a=1&b=2`)
      expect(await settledTabs()).toBe(1)

      await agentOpen(page, `http://LOCALHOST:${server.port}/p?a=1&b=2`)
      expect(await settledTabs()).toBe(1)

      await agentOpen(page, `${base}/p?b=2&a=1`)
      expect(await settledTabs()).toBe(1)

      await agentOpen(page, 'http://localhost:80/q?a=1')
      await expect(openTabs(page)).toHaveCount(2, { timeout: 30_000 })
      await agentOpen(page, 'http://localhost/q?a=1')
      expect(await settledTabs()).toBe(2)
    } finally {
      await server.close()
    }
  })

  interface DevtoolsState {
    guests: { url: string; devtools: boolean }[]
    devtoolsPages: string[]
  }

  function devtoolsState(app: ElectronApplication): Promise<DevtoolsState> {
    return app.evaluate(({ webContents }) => {
      const all = webContents.getAllWebContents()
      return {
        guests: all
          .filter((w) => w.getType() === 'webview')
          .map((w) => ({ url: w.getURL(), devtools: w.isDevToolsOpened() })),
        devtoolsPages: all.map((w) => w.getURL()).filter((u) => u.startsWith('devtools://'))
      }
    })
  }

  async function focusWorkbenchPanelSoDevtoolsTargetsTheGuest(page: Page): Promise<void> {
    await page.locator(WORKBENCH.panel).click({ position: { x: 5, y: 5 } })
  }

  test('BB-C59: a page-/agent-initiated devtools request is refused; devtools is user-only', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      await addressBarSession(page, env)
      const probeUrl = server.page(
        '/devtools-probe',
        '<!doctype html><html><head><meta charset="utf-8"><title>Devtools probe</title></head><body>' +
          '<button id="try">try</button><div id="done"></div><script>' +
          'document.getElementById("try").addEventListener("click", function () {' +
          '  var n = 0;' +
          '  try { window.open("devtools://devtools/bundled/inspector.html", "_blank"); n++ } catch (e) {}' +
          '  try { window.open("chrome://inspect", "_blank"); n++ } catch (e) {}' +
          '  document.getElementById("done").textContent = "tried:" + n;' +
          '  setTimeout(function () { window.location.href = "devtools://devtools/bundled/inspector.html" }, 50)' +
          '})</script></body></html>'
      )
      await typeInAddressBar(page, probeUrl)
      const guest = await guestByUrl(app, '/devtools-probe')
      const windowsBefore = (await windowStates(app)).length

      await guest.locator('#try').click()
      await expect(guest.locator('#done')).toHaveText(/^tried:[1-9]/, { timeout: 30_000 })

      await agentOpen(page, 'devtools://devtools/bundled/inspector.html')
      await page.waitForTimeout(5000)

      const state = await devtoolsState(app)
      expect(state.guests.filter((g) => g.devtools)).toEqual([])
      expect(state.devtoolsPages).toEqual([])
      expect(state.guests.filter((g) => g.url.startsWith('devtools:'))).toEqual([])
      expect((await windowStates(app)).length).toBe(windowsBefore)
    } finally {
      await server.close()
    }
  })

  test('BB-C61: a detached devtools window opens without auto-loading extra guests, per-tab', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      await addressBarSession(page, env)

      await typeInAddressBar(page, server.url('/a'))
      await guestByUrl(app, `:${server.port}/a`)
      await agentOpen(page, server.url('/b'))
      await expect(openTabs(page)).toHaveCount(2, { timeout: 30_000 })

      await focusWorkbenchPanelSoDevtoolsTargetsTheGuest(page)
      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.devtools)

      await expect
        .poll(async () => (await devtoolsState(app)).devtoolsPages.length, { timeout: 40_000 })
        .toBeGreaterThan(0)
      // PLATFORM§8
      await expect
        .poll(async () => (await devtoolsState(app)).guests.filter((g) => g.devtools).length, {
          timeout: 40_000
        })
        .toBe(1)
      const opened = (await devtoolsState(app)).guests.filter((g) => g.devtools)
      expect(opened[0].url).toContain(`:${server.port}/a`)
      for (const w of await windowStates(app)) expect(w.visible).toBe(false)
      expect(server.count('/b')).toBe(0)

      await openTabs(page).nth(1).click()
      await expect.poll(() => server.count('/b'), { timeout: 40_000 }).toBe(1)
      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.devtools)

      await expect
        .poll(async () => (await devtoolsState(app)).guests.filter((g) => g.devtools).length, {
          timeout: 40_000
        })
        .toBe(2)
      for (const w of await windowStates(app)) expect(w.visible).toBe(false)
    } finally {
      await server.close()
    }
  })

  test('F4: the user’s own ⌥⌘I opens devtools on the active guest and toggles it closed again', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      await addressBarSession(page, env)
      await typeInAddressBar(page, server.url('/inspect-me'))
      await guestByUrl(app, `:${server.port}/inspect-me`)

      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.devtools)

      // PLATFORM§8
      await expect
        .poll(async () => (await devtoolsState(app)).guests.filter((g) => g.devtools).length, {
          timeout: 40_000
        })
        .toBe(1)
      const opened = (await devtoolsState(app)).guests.filter((g) => g.devtools)
      expect(opened[0].url).toContain(`:${server.port}/inspect-me`)
      for (const w of await windowStates(app)) expect(w.visible).toBe(false)

      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.devtools)

      await expect
        .poll(async () => (await devtoolsState(app)).guests.filter((g) => g.devtools).length, {
          timeout: 40_000
        })
        .toBe(0)
      await expect
        .poll(async () => (await devtoolsState(app)).devtoolsPages.length, { timeout: 40_000 })
        .toBe(0)
    } finally {
      await server.close()
    }
  })

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

  async function submitBasicAuth(page: Page): Promise<void> {
    const modal = page.locator(BROWSER.modal)
    await expect(modal).toBeVisible({ timeout: 40_000 })
    const fields = modal.locator('input')
    await fields.nth(0).click()
    await fields.nth(0).fill(BASIC_CREDENTIALS.user)
    await fields.nth(1).click()
    await fields.nth(1).fill(BASIC_CREDENTIALS.pass)
    const primary = modal.locator('.btn-primary')
    if ((await primary.count()) > 0) await primary.first().click()
    else await modal.locator('button').last().click()
  }

  function lastAuthHeader(server: FixtureServer): string {
    const hits = server.requestsFor('/auth')
    return hits.length ? (hits[hits.length - 1].headers['authorization'] ?? '') : ''
  }

  test('BB-C64: "clear browsing data" wipes cookies, service workers, cache, IndexedDB, HTTP auth, cert exceptions, and address-bar history', async ({
    env
  }) => {
    test.setTimeout(600_000)
    const server = await startEchoServer()
    const tls = await startHttpsServer()
    try {
      gitInit(env.workspaces.a)
      env.extraArgs.push(tls.hostResolverSwitch)
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await page.waitForLoadState('domcontentloaded')
        await startSessionIn(page, 'ws-a')
        await showWorkbench(page)
        await newWebTab(page)

        await typeInAddressBar(page, server.url('/storage'))
        const storage = await guestByUrl(app, '/storage')
        await expect(storage.locator('#stored')).toHaveText(/cookie.*sw.*cache.*idb/, {
          timeout: 60_000
        })
        await typeInAddressBar(page, server.url('/echo'))
        await expect.poll(() => server.count('/echo'), { timeout: 40_000 }).toBe(1)
        expect(server.requestsFor('/echo')[0].cookie).toContain('koloft_store')

        await typeInAddressBar(page, server.url('/auth'))
        await submitBasicAuth(page)
        const authed = await guestByUrl(app, `:${server.port}/auth`)
        await expect(authed.locator('#authed')).toBeVisible({ timeout: 40_000 })
        await typeInAddressBar(page, server.url('/a'))
        await typeInAddressBar(page, server.url('/auth'))
        await expect.poll(() => lastAuthHeader(server), { timeout: 40_000 }).toMatch(/^Basic /)

        await typeInAddressBar(page, tls.aliasUrl('koloft-a.test', '/a'))
        await clickProceed(app, page)
        await expect.poll(() => tls.count('/a'), { timeout: 60_000 }).toBe(1)
        await typeInAddressBar(page, tls.aliasUrl('koloft-a.test', '/p'))
        await expect.poll(() => tls.count('/p'), { timeout: 60_000 }).toBe(1)
        expect(await proceedCount(app, page)).toBe(0)

        await typeInAddressBar(page, UNIQUELY_TITLED_HISTORY_FRAGMENT, { submit: false })
        await expect(page.locator(BROWSER.suggestRow)).toHaveCount(1, { timeout: 20_000 })
        await page.keyboard.press('Escape')

        await page.locator('.tb-ico[title="Settings"]').click()
        const settings = page.locator('.modal')
        await expect(settings).toBeVisible({ timeout: 20_000 })
        const clear = settings.getByText(/Clear browsing data/).first()
        await expect(clear).toBeVisible({ timeout: 20_000 })
        await clear.click()
        const confirm = settings.locator('.btn-primary', { hasText: /Clear|OK|Confirm/ })
        if ((await confirm.count()) > 0) await confirm.first().click()
        await page.keyboard.press('Escape')
        await expect(settings).toHaveCount(0, { timeout: 20_000 })

        await typeInAddressBar(page, UNIQUELY_TITLED_HISTORY_FRAGMENT, { submit: false })
        await expect(page.locator(BROWSER.suggestList)).toHaveCount(0, { timeout: 20_000 })
        await page.keyboard.press('Escape')

        await typeInAddressBar(page, server.url('/echo'))
        await expect.poll(() => server.count('/echo'), { timeout: 40_000 }).toBe(2)
        expect(server.requestsFor('/echo')[1].cookie).not.toContain('koloft_store')

        await typeInAddressBar(page, server.url('/p'))
        const fresh = await guestByUrl(app, `:${server.port}/p`)
        const leftovers = await fresh.evaluate(async () => ({
          serviceWorkers: (await navigator.serviceWorker.getRegistrations()).length,
          caches: await caches.keys(),
          databases: (await indexedDB.databases()).map((d) => d.name ?? '')
        }))
        expect(leftovers.serviceWorkers).toBe(0)
        expect(leftovers.caches).toEqual([])
        expect(leftovers.databases).toEqual([])

        const authRequestsBefore = server.count('/auth')
        await typeInAddressBar(page, server.url('/auth'))
        await expect
          .poll(() => server.count('/auth'), { timeout: 40_000 })
          .toBeGreaterThan(authRequestsBefore)
        expect(lastAuthHeader(server)).toBe('')

        await page.keyboard.press('Escape')
        await typeInAddressBar(page, tls.aliasUrl('koloft-a.test', '/b'))
        await expect.poll(() => proceedCount(app, page), { timeout: 60_000 }).toBeGreaterThan(0)
        expect(tls.count('/b')).toBe(0)
      } finally {
        await app.close().catch(() => {})
      }
    } finally {
      await tls.close()
      await server.close()
    }
  })

  test('BB-N07: a full S1 "edit-look-say" flow completes with zero forced external opens', async ({
    env
  }) => {
    test.setTimeout(600_000)
    const server = await startEchoServer()
    const tls = await startHttpsServer()
    try {
      gitInit(env.workspaces.a)
      env.extraArgs.push(tls.hostResolverSwitch)
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await page.waitForLoadState('domcontentloaded')
        await startSessionIn(page, 'ws-a')
        await showWorkbench(page)

        await agentOpen(page, server.localhostUrl('/a'))
        await expect(openTabs(page)).toHaveCount(1, { timeout: 40_000 })

        await openTabs(page).first().click()
        await expect.poll(() => server.count('/a'), { timeout: 40_000 }).toBe(1)
        const first = await guestByUrl(app, `:${server.port}/a`)
        await first.locator('#to-b').click()
        await expect.poll(() => server.count('/b'), { timeout: 40_000 }).toBeGreaterThan(0)

        const name = `koloft-e2e-n07-${Date.now()}.txt`
        await typeInAddressBar(
          page,
          server.url(`/link?href=${encodeURIComponent(`/download?name=${name}`)}`)
        )
        const downloader = await guestByUrl(app, '/link')
        await downloader.locator('#link').click()
        await expect.poll(() => downloadedFiles(env), { timeout: 60_000 }).toContain(name)

        await typeInAddressBar(page, tls.aliasUrl('koloft-a.test', '/a'))
        await clickProceed(app, page)
        await expect.poll(() => tls.count('/a'), { timeout: 60_000 }).toBe(1)

        await typeInAddressBar(page, server.url('/upload'))
        const uploader = await guestByUrl(app, '/upload')
        await uploader.locator('#file').setInputFiles(path.join(env.workspaces.a, 'README.md'))
        await expect(uploader.locator('#chosen')).toHaveText('README.md', { timeout: 40_000 })

        await typeInAddressBar(page, server.url('/doc.pdf'))
        await expect
          .poll(async () => (await guestUrls(app)).some((u) => u.endsWith('.pdf')), {
            timeout: 60_000
          })
          .toBe(true)

        expect(fs.existsSync(env.externalOpens)).toBe(false)
        expect(readOpenCalls(env).filter((l) => /^https?:/.test(l))).toEqual([])
      } finally {
        await app.close().catch(() => {})
      }
    } finally {
      await tls.close()
      await server.close()
    }
  })
})
