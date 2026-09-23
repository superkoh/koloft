import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import { launchSettled } from './helpers/blackbox'
import { gitInit, startSessionIn, wsRows } from './helpers/p1'
import {
  BROWSER,
  addressField,
  addressValue,
  browserSurface,
  globeIcon,
  guestByUrl,
  newWebTab,
  openBrowser,
  overlayUrl,
  tabTitles,
  openTabs,
  typeInAddressBar,
  windowStates
} from './helpers/browser'
import { WORKBENCH, openInBrowse, wbTabTitles, wbUnreadTabs } from './helpers/workbench'
import { startEchoServer } from './helpers/fixtureServer'
import {
  EXT,
  PROBE,
  actionRow,
  badgeText,
  clearInstallSeam,
  closeSettings,
  confirmButton,
  extAction,
  extActions,
  extConfirm,
  extOverflow,
  extOverflowMenu,
  extRow,
  extToggle,
  extUninstall,
  extensionPopups,
  hostContentBounds,
  installExtensions,
  openExtensionsPane,
  popupAttr,
  popupKeyTarget,
  rootAttr,
  stageExtension,
  toggleIsOn,
  waitForPopupBounds
} from './helpers/extensions'

/**
 * The black-box cases of the original case list (retired after
 * the feature merged) — every `Mode: automated` one, in case order:
 *
 *   BB-M01 … BB-M11   (BB-M12 is llm-driven: real Chrome Web Store network)
 *   BB-C01 … BB-C09, BB-C11 … BB-C16   (BB-C10 is llm-driven: real 1Password account)
 *   BB-N01 BB-N02
 *
 * Nothing imports from src/ — the oracles are the app's own UI (the selector contract
 * lives in helpers/extensions.ts), the probe extensions under fixtures/ext-probes/,
 * Electron's window/webContents inventory, and the TEST-10 fixture server's request log.
 *
 * Extensions reach the app through the §07 probe seam, KOLOFT_EXT_INSTALL_DIRS, which has
 * to be set before launch — so almost every test launches by hand (launchSettled) with
 * a try/finally close, instead of taking the `app`/`page` fixtures.
 *
 * moved one thing that runs through the whole file: the action row lives in the `web`
 * KIND's bar, so an icon is on screen only while a `web` tab is active — see
 * `actionRowSession` below.
 */

// ---- shared plumbing -------------------------------------------------------------------

/** a page whose <title> is `name`, so the tab strip carries a decidable label */
function titled(name: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head>` +
    `<body><h1 id="mark">${name}</h1></body></html>`
  )
}

async function box(target: Locator): Promise<{
  x: number
  y: number
  width: number
  height: number
}> {
  const found = await target.boundingBox()
  if (!found) throw new Error('element has no bounding box')
  return found
}

/** FR-02: the pinned `files` tab's label is always the first entry `wbTabTitles` reports. */
const FILES_LABEL = 'Files'

/** Raise the panel. `openBrowser` chooses T1 vs T2 now rather than a surface, and the
 *  panel is open by DEFAULT after the merge (FR-06), so it is usually a no-op. */
async function showWorkbench(page: Page): Promise<void> {
  await expect(globeIcon(page)).toBeVisible({ timeout: 30_000 })
  await openBrowser(page)
}

/** Given: a bound session in `ws`, selected, with the panel up. */
async function browserSession(
  page: Page,
  env: E2EEnv,
  ws: 'ws-a' | 'ws-b' = 'ws-a'
): Promise<Locator> {
  gitInit(env.workspaces[ws === 'ws-a' ? 'a' : 'b'])
  await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
  await startSessionIn(page, ws)
  const row = wsRows(page, ws).first()
  await row.click()
  await expect(row).toHaveClass(/\bactive\b/, { timeout: 20_000 })
  await showWorkbench(page)
  return row
}

/**
 * …plus a blank `web` tab, so the address bar and its action row are on screen.
 *
 * Load-bearing for this whole file after the merge: the extension action row lives inside
 * the `web` kind bar (`.baddr .bext`), and the panel opens on the pinned `files` tab, whose
 * kind bar has no address row at all. So an action icon is only on screen while a `web` tab
 * is active, and every case that reaches for one has to make one first (FR-52).
 */
async function actionRowSession(
  page: Page,
  env: E2EEnv,
  ws: 'ws-a' | 'ws-b' = 'ws-a'
): Promise<Locator> {
  const row = await browserSession(page, env, ws)
  await newWebTab(page)
  await expect(addressField(page)).toBeVisible({ timeout: 20_000 })
  return row
}

/** Open one more tab on `url`: ＋ ▸ New web tab, then the address bar it just focused. */
async function openTabOn(page: Page, url: string): Promise<void> {
  await newWebTab(page)
  await expect(addressField(page)).toBeVisible({ timeout: 20_000 })
  await typeInAddressBar(page, url)
}

/** Open a tab and wait until the strip shows that page's title (an unloaded tab is
 *  labelled from its url, so a substring match would return too early). */
async function openLoadedTab(page: Page, url: string, title: string): Promise<void> {
  await openTabOn(page, url)
  await expect(page.locator(`${BROWSER.tabActive} ${BROWSER.tabLabel}`)).toHaveText(title, {
    timeout: 30_000
  })
}

async function activeTabLabel(page: Page): Promise<string> {
  const label = page.locator(`${BROWSER.tabActive} ${BROWSER.tabLabel}`)
  if ((await label.count()) === 0) return ''
  return (await label.first().innerText()).trim()
}

/** The document the Preview viewer renders into, wherever it lives. */
async function previewDocument(app: ElectronApplication, page: Page): Promise<Page> {
  for (const candidate of [page, ...app.windows()]) {
    if ((await candidate.locator('.file-pane-body .md-body').count()) > 0) return candidate
  }
  throw new Error('no document is showing the Preview viewer')
}

/** Every window that is neither the Koloft host window nor an extension popup. */
async function strayWindows(app: ElectronApplication): Promise<string[]> {
  const windows = await windowStates(app)
  return windows
    .map((w) => w.url)
    .filter(
      (url) => !/out\/renderer\/index\.html/.test(url) && !url.startsWith('chrome-extension://')
    )
}

// ---- Main Flow ---------------------------------------------------------------------------

test('BB-M01: an installed extension injects its content script into a Browser page', async ({
  env
}) => {
  test.setTimeout(240_000)
  const probe = stageExtension(env, 'base')
  installExtensions(env, [probe])
  const server = await startEchoServer()
  const { app, page } = await launchSettled(env)
  try {
    await browserSession(page, env)
    await openTabOn(page, server.page('/m01', titled('M01')))
    const guest = await guestByUrl(app, '/m01')
    await expect.poll(() => rootAttr(guest, PROBE.injected), { timeout: 30_000 }).toBeTruthy()
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})

test('BB-M02: the action icon sits at the right end of the address bar, divided from the nav controls', async ({
  env
}) => {
  test.setTimeout(240_000)
  const probe = stageExtension(env, 'base')
  installExtensions(env, [probe])
  const { app, page } = await launchSettled(env)
  try {
    await actionRowSession(page, env)
    await expect(extAction(page, probe.name)).toBeVisible({ timeout: 30_000 })

    // right edge: the row clears the address field's right edge entirely
    const row = await box(actionRow(page))
    const field = await box(addressField(page))
    expect(row.x).toBeGreaterThanOrEqual(field.x + field.width)

    // a divider before the nav buttons — the case pins a divider, not its CSS mechanism: the row's
    // own leading border OR a separator element/border just before it both satisfy it
    const divided = await actionRow(page).evaluate((el) => {
      const bordered = (style: CSSStyleDeclaration, side: 'Left' | 'Right'): boolean =>
        style[`border${side}Style`] !== 'none' && parseFloat(style[`border${side}Width`]) > 0
      if (bordered(getComputedStyle(el), 'Left')) return true
      const prev = el.previousElementSibling
      if (!prev) return false
      return prev.matches('[role="separator"], hr') || bordered(getComputedStyle(prev), 'Right')
    })
    expect(divided).toBe(true)
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-M03: clicking the action icon pops the extension popup, anchored under the icon', async ({
  env
}) => {
  test.setTimeout(240_000)
  const probe = stageExtension(env, 'base')
  installExtensions(env, [probe])
  const { app, page } = await launchSettled(env)
  try {
    await actionRowSession(page, env)
    const icon = extAction(page, probe.name)
    await expect(icon).toBeVisible({ timeout: 30_000 })
    await icon.click()

    // the floater carries THIS extension's popup page
    const popup = await waitForPopupBounds(app)
    const urls = await extensionPopups(app)
    expect(urls.some((url) => url.endsWith('popup.html'))).toBe(true)

    // popup bounds are screen coordinates; a bounding box is content-relative
    const host = await hostContentBounds(app)
    const iconBox = await box(icon)
    const addressBar = await box(page.locator(BROWSER.addressBar))

    // horizontal span overlaps the icon
    expect(popup.x).toBeLessThan(host.x + iconBox.x + iconBox.width)
    expect(popup.x + popup.width).toBeGreaterThan(host.x + iconBox.x)
    // top edge sits below the bottom of the address bar
    expect(popup.y).toBeGreaterThanOrEqual(host.y + addressBar.y + addressBar.height)
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-M04: the popup closes on an outside click and on ESC, leaving the active tab alone', async ({
  env
}) => {
  test.setTimeout(300_000)
  const probe = stageExtension(env, 'base')
  installExtensions(env, [probe])
  const server = await startEchoServer()
  const { app, page } = await launchSettled(env)
  try {
    await browserSession(page, env)
    await openLoadedTab(page, server.page('/m04', titled('M04')), 'M04')
    const icon = extAction(page, probe.name)
    await expect(icon).toBeVisible({ timeout: 30_000 })
    await icon.click()
    await waitForPopupBounds(app)

    const tabsBefore = await wbTabTitles(page)
    const activeBefore = await activeTabLabel(page)
    const addressBefore = await addressValue(page)

    // ① a click anywhere outside the floater
    await page.locator('.term-island').click()
    await expect.poll(() => extensionPopups(app), { timeout: 20_000 }).toEqual([])

    // ② ESC on a freshly raised one
    await icon.click()
    await waitForPopupBounds(app)
    await popupKeyTarget(app, page).keyboard.press('Escape')
    await expect.poll(() => extensionPopups(app), { timeout: 20_000 }).toEqual([])

    expect(await wbTabTitles(page)).toEqual(tabsBefore)
    expect(await activeTabLabel(page)).toBe(activeBefore)
    expect(await addressValue(page)).toBe(addressBefore)
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})

test('BB-M05: Settings → Extensions lists the installed extension with its version', async ({
  env
}) => {
  test.setTimeout(240_000)
  const probe = stageExtension(env, 'base')
  installExtensions(env, [probe])
  const { app, page } = await launchSettled(env)
  try {
    await openExtensionsPane(page)

    // Extensions sits between Notifications and About (D2)
    const nav = await page.locator(EXT.nav).allTextContents()
    const names = nav.map((t) => t.replace(/\s+/g, ' ').trim())
    expect(names).toContain('Extensions')
    expect(names.indexOf('Extensions')).toBe(names.indexOf('Notifications') + 1)
    expect(names.indexOf('About')).toBe(names.indexOf('Extensions') + 1)

    const row = extRow(page, probe.name)
    await expect(row).toHaveCount(1, { timeout: 20_000 })
    expect((await row.locator(EXT.rowName).textContent())?.trim()).toBe(probe.name)
    await expect(row.locator(EXT.rowVersion)).toContainText(probe.version)
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-M06: switching the extension off stops injection into newly opened pages', async ({
  env
}) => {
  test.setTimeout(300_000)
  const probe = stageExtension(env, 'base')
  installExtensions(env, [probe])
  const server = await startEchoServer()
  const { app, page } = await launchSettled(env)
  try {
    await browserSession(page, env)
    await openExtensionsPane(page)
    // the Given itself: a seam-installed extension starts enabled
    expect(await toggleIsOn(page, probe.name)).toBe(true)
    await extToggle(page, probe.name).click()
    await expect.poll(() => toggleIsOn(page, probe.name), { timeout: 20_000 }).toBe(false)
    await closeSettings(page)

    await openTabOn(page, server.page('/m06', titled('M06')))
    const guest = await guestByUrl(app, '/m06')
    // the page has really rendered — the barrier the absence assertion needs
    await expect(guest.locator('#mark')).toBeVisible({ timeout: 30_000 })
    expect(await rootAttr(guest, PROBE.injected)).toBeNull()
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})

test('BB-M07: switching the extension back on restores injection', async ({ env }) => {
  test.setTimeout(300_000)
  const probe = stageExtension(env, 'base')
  installExtensions(env, [probe])
  const server = await startEchoServer()
  const { app, page } = await launchSettled(env)
  try {
    await browserSession(page, env)
    await openExtensionsPane(page)
    // Given: disabled by the BB-M06 operation
    await extToggle(page, probe.name).click()
    await expect.poll(() => toggleIsOn(page, probe.name), { timeout: 20_000 }).toBe(false)

    await extToggle(page, probe.name).click()
    await expect.poll(() => toggleIsOn(page, probe.name), { timeout: 20_000 }).toBe(true)
    await closeSettings(page)

    await openTabOn(page, server.page('/m07', titled('M07')))
    const guest = await guestByUrl(app, '/m07')
    await expect.poll(() => rootAttr(guest, PROBE.injected), { timeout: 30_000 }).toBeTruthy()
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})

test('BB-M08: uninstalling takes the row, the icon and the injection away', async ({ env }) => {
  test.setTimeout(300_000)
  const probe = stageExtension(env, 'base')
  installExtensions(env, [probe])
  const server = await startEchoServer()
  const { app, page } = await launchSettled(env)
  try {
    await actionRowSession(page, env)
    await expect(extAction(page, probe.name)).toBeVisible({ timeout: 30_000 })

    await openExtensionsPane(page)
    await expect(extRow(page, probe.name)).toHaveCount(1, { timeout: 20_000 })
    await extUninstall(page, probe.name).click()
    await expect(extConfirm(page)).toBeVisible({ timeout: 20_000 })
    await confirmButton(page, 'Uninstall').click()

    await expect(extRow(page, probe.name)).toHaveCount(0, { timeout: 20_000 })
    await closeSettings(page)
    await expect(extAction(page, probe.name)).toHaveCount(0, { timeout: 20_000 })

    await openTabOn(page, server.page('/m08', titled('M08')))
    const guest = await guestByUrl(app, '/m08')
    await expect(guest.locator('#mark')).toBeVisible({ timeout: 30_000 })
    expect(await rootAttr(guest, PROBE.injected)).toBeNull()
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})

// §04 (user call): the store is a session-independent overlay —
// the Given is deliberately a profile with NO session at all
test('BB-M09: “Open Chrome Web Store” opens the session-independent store overlay', async ({
  page
}) => {
  test.setTimeout(120_000)
  await openExtensionsPane(page)
  await page.getByRole('button', { name: /Chrome Web Store/ }).click()

  await expect(page.locator(EXT.store)).toBeVisible({ timeout: 20_000 })
  // size shrinks (manual find): trapped by the Settings modal's containing block, the
  // overlay once shrank to modal size — near-fullwindow means ≥80% of the viewport
  const overlay = await page.locator(EXT.store).boundingBox()
  const viewport =
    page.viewportSize() ??
    (await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight
    })))
  expect(overlay).not.toBeNull()
  expect(overlay!.width).toBeGreaterThanOrEqual(viewport.width * 0.8)
  expect(overlay!.height).toBeGreaterThanOrEqual(viewport.height * 0.8)
  // R1: the overlay's guest is the ONE guest factory now, which loads through
  // loadURL rather than the src attribute (#31918 ordering guard) — so the url is read
  // off the live guest. The old `src` assertion is retired.
  await expect
    .poll(() => overlayUrl(page), { timeout: 20_000 })
    .toMatch(/chromewebstore\.google\.com/)

  await page.locator(EXT.storeClose).click()
  await expect(page.locator(EXT.store)).toHaveCount(0)
  await expect(page.locator('.settings-modal')).toBeVisible()
})

test('BB-M10: a tab the extension opens lands active in the current session, with no unread dot', async ({
  env
}) => {
  test.setTimeout(420_000)
  const server = await startEchoServer()
  const probe = stageExtension(env, 'tabs-create', {
    config: { target: server.page('/m10-target', titled('M10Target')) }
  })
  installExtensions(env, [probe])
  const { app, page } = await launchSettled(env)
  try {
    // the first session, with a tab of its own
    const rowA = await browserSession(page, env, 'ws-a')
    await openLoadedTab(page, server.page('/m10-a', titled('M10A')), 'M10A')

    // the second session is the current one, sitting on another page
    await browserSession(page, env, 'ws-b')
    await openLoadedTab(page, server.page('/m10-b', titled('M10B')), 'M10B')
    const tabsInB = await openTabs(page).count()

    await extAction(page, probe.name).click()

    await expect(openTabs(page)).toHaveCount(tabsInB + 1, { timeout: 30_000 })
    await expect(page.locator(`${BROWSER.tabActive} ${BROWSER.tabLabel}`)).toHaveText('M10Target', {
      timeout: 30_000
    })
    await expect(wbUnreadTabs(page)).toHaveCount(0)

    await rowA.click()
    await expect(rowA).toHaveClass(/\bactive\b/, { timeout: 20_000 })
    await showWorkbench(page)
    // the panel stays on the session the click LEFT until `shown` lands two frames later.
    await expect.poll(() => wbTabTitles(page), { timeout: 20_000 }).toEqual([FILES_LABEL, 'M10A'])
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})

test('BB-M11: an installed extension survives a restart', async ({ env }) => {
  test.setTimeout(420_000)
  const probe = stageExtension(env, 'base')
  installExtensions(env, [probe])
  const server = await startEchoServer()
  try {
    const first = await launchSettled(env)
    try {
      await browserSession(first.page, env)
      await openTabOn(first.page, server.page('/m11', titled('M11')))
      const guest = await guestByUrl(first.app, '/m11')
      await expect.poll(() => rootAttr(guest, PROBE.injected), { timeout: 30_000 }).toBeTruthy()
    } finally {
      await first.app.close().catch(() => {})
    }

    // relaunched WITHOUT the seam: what survives is what the registry kept
    clearInstallSeam(env)
    const second = await launchSettled(env)
    try {
      await browserSession(second.page, env)
      await openTabOn(second.page, server.page('/m11b', titled('M11B')))
      const guest = await guestByUrl(second.app, '/m11b')
      await expect.poll(() => rootAttr(guest, PROBE.injected), { timeout: 30_000 }).toBeTruthy()

      await openExtensionsPane(second.page)
      await expect(extRow(second.page, probe.name)).toHaveCount(1, { timeout: 20_000 })
    } finally {
      await second.app.close().catch(() => {})
    }
  } finally {
    await server.close()
  }
})

// ---- Corner Cases ------------------------------------------------------------------------

test('BB-C01: exactly 4 extensions — all four stay on the row, no overflow entry', async ({
  env
}) => {
  test.setTimeout(300_000)
  const probes = [1, 2, 3, 4].map((n) => stageExtension(env, 'base', { name: `probe-${n}` }))
  installExtensions(env, probes)
  const { app, page } = await launchSettled(env)
  try {
    await actionRowSession(page, env)
    for (const probe of probes) {
      await expect(extAction(page, probe.name)).toBeVisible({ timeout: 30_000 })
    }
    await expect(extActions(page)).toHaveCount(4)
    await expect(extOverflow(page)).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-C02: 5 extensions — 3 icons plus the puzzle, whose menu lists all five', async ({
  env
}) => {
  test.setTimeout(300_000)
  const probes = [1, 2, 3, 4, 5].map((n) => stageExtension(env, 'base', { name: `probe-${n}` }))
  installExtensions(env, probes)
  const { app, page } = await launchSettled(env)
  try {
    await actionRowSession(page, env)
    await expect(extOverflow(page)).toHaveCount(1, { timeout: 30_000 })
    await expect(extActions(page)).toHaveCount(3)

    await extOverflow(page).click()
    const menu = extOverflowMenu(page)
    await expect(menu).toBeVisible({ timeout: 20_000 })
    for (const probe of probes) await expect(menu).toContainText(probe.name)
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-C03: no extensions — no action row, and Settings shows the guidance', async ({
  page,
  env
}) => {
  test.setTimeout(240_000)
  await actionRowSession(page, env)
  await expect(actionRow(page)).toHaveCount(0)

  await openExtensionsPane(page)
  await expect(page.locator(EXT.empty)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: /Chrome Web Store/ })).toBeVisible()
})

test('BB-C04: cancelling the uninstall confirmation leaves the extension untouched', async ({
  env
}) => {
  test.setTimeout(300_000)
  const probe = stageExtension(env, 'base')
  installExtensions(env, [probe])
  const server = await startEchoServer()
  const { app, page } = await launchSettled(env)
  try {
    await actionRowSession(page, env)
    await expect(extAction(page, probe.name)).toBeVisible({ timeout: 30_000 })

    await openExtensionsPane(page)
    await expect(extRow(page, probe.name)).toHaveCount(1, { timeout: 20_000 })
    await extUninstall(page, probe.name).click()
    await expect(extConfirm(page)).toBeVisible({ timeout: 20_000 })
    await confirmButton(page, 'Cancel').click()
    await expect(extConfirm(page)).toHaveCount(0, { timeout: 20_000 })

    await expect(extRow(page, probe.name)).toHaveCount(1)
    expect(await toggleIsOn(page, probe.name)).toBe(true)
    await closeSettings(page)
    await expect(extAction(page, probe.name)).toBeVisible()

    await openTabOn(page, server.page('/c04', titled('C04')))
    const guest = await guestByUrl(app, '/c04')
    await expect.poll(() => rootAttr(guest, PROBE.injected), { timeout: 30_000 }).toBeTruthy()
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})

test('BB-C05: the extension reaches neither Koloft’s own UI nor the Preview viewer', async ({
  env
}) => {
  test.setTimeout(300_000)
  const probe = stageExtension(env, 'base')
  installExtensions(env, [probe])
  const server = await startEchoServer()
  const { app, page } = await launchSettled(env)
  try {
    fs.writeFileSync(path.join(env.workspaces.a, 'c05.md'), '# c05\n\nkoloft-bb-preview\n')
    await browserSession(page, env)

    // Given: injection is live on a Browser page
    await openTabOn(page, server.page('/c05', titled('C05')))
    const guest = await guestByUrl(app, '/c05')
    await expect.poll(() => rootAttr(guest, PROBE.injected), { timeout: 30_000 }).toBeTruthy()

    // ① Koloft's own document
    expect(await rootAttr(page, PROBE.injected)).toBeNull()

    // ② the Preview viewer's document — reached through the pinned `files` tab's Browse
    //    half now that the sidebar tree has retired (FR-44)
    await openInBrowse(page, path.join(env.workspaces.a, 'c05.md'))
    await expect(page.locator(`${WORKBENCH.readingBody} .md-body`)).toBeVisible({
      timeout: 20_000
    })
    const viewer = await previewDocument(app, page)
    expect(await rootAttr(viewer, PROBE.injected)).toBeNull()
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})

test('BB-C06: one install serves every session’s Browser', async ({ env }) => {
  test.setTimeout(420_000)
  const probe = stageExtension(env, 'base')
  installExtensions(env, [probe])
  const server = await startEchoServer()
  const { app, page } = await launchSettled(env)
  try {
    await browserSession(page, env, 'ws-a')
    await openTabOn(page, server.page('/c06a', titled('C06A')))
    const guestA = await guestByUrl(app, '/c06a')

    await browserSession(page, env, 'ws-b')
    await openTabOn(page, server.page('/c06b', titled('C06B')))
    const guestB = await guestByUrl(app, '/c06b')

    await expect.poll(() => rootAttr(guestA, PROBE.injected), { timeout: 30_000 }).toBeTruthy()
    await expect.poll(() => rootAttr(guestB, PROBE.injected), { timeout: 30_000 }).toBeTruthy()
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})

test('BB-C07: an extension mixing the browser/chrome namespaces starts up fine', async ({
  env
}) => {
  test.setTimeout(240_000)
  const probe = stageExtension(env, 'sw-browser-ns')
  installExtensions(env, [probe])
  const { app, page } = await launchSettled(env)
  try {
    await actionRowSession(page, env)
    await expect(extAction(page, probe.name)).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => badgeText(page, probe.name), { timeout: 30_000 }).toBe('ok')
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-C08: a runtime permission request uses a DOM modal, and denying changes nothing', async ({
  env
}) => {
  test.setTimeout(300_000)
  const probe = stageExtension(env, 'permissions')
  installExtensions(env, [probe])
  const { app, page } = await launchSettled(env)
  try {
    await actionRowSession(page, env)
    const icon = extAction(page, probe.name)
    await expect(icon).toBeVisible({ timeout: 30_000 })
    await icon.click()

    // the confirmation is a DOM modal inside the Koloft window
    await expect(extConfirm(page)).toBeVisible({ timeout: 30_000 })
    await confirmButton(page, 'Deny').click()

    await expect.poll(() => badgeText(page, probe.name), { timeout: 30_000 }).toBe('n')

    await openExtensionsPane(page)
    const row = extRow(page, probe.name)
    await expect(row).toHaveCount(1, { timeout: 20_000 })
    expect((await row.locator(EXT.rowName).textContent())?.trim()).toBe(probe.name)
    await expect(row.locator(EXT.rowVersion)).toContainText(probe.version)
    expect(await toggleIsOn(page, probe.name)).toBe(true)
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-C09: a non-ASCII extension name renders character for character', async ({ env }) => {
  test.setTimeout(240_000)
  const name = '密码助手 🔑'
  const probe = stageExtension(env, 'base', { name })
  installExtensions(env, [probe])
  const { app, page } = await launchSettled(env)
  try {
    await openExtensionsPane(page)
    const row = extRow(page, name)
    await expect(row).toHaveCount(1, { timeout: 20_000 })
    expect((await row.locator(EXT.rowName).textContent())?.trim()).toBe(name)
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-C11: the extension’s active tab is the current session’s current Browser tab', async ({
  env
}) => {
  test.setTimeout(420_000)
  const probe = stageExtension(env, 'active-tab')
  installExtensions(env, [probe])
  const server = await startEchoServer()
  const { app, page } = await launchSettled(env)
  try {
    // the first session: two tabs on two DIFFERENT hostnames of the same fixture server
    await browserSession(page, env, 'ws-a')
    await openLoadedTab(page, server.page('/c11a', titled('C11A')), 'C11A')
    server.page('/c11b', titled('C11B'))
    await openLoadedTab(page, server.localhostUrl('/c11b'), 'C11B')

    await extAction(page, probe.name).click()
    await expect.poll(() => badgeText(page, probe.name), { timeout: 30_000 }).toBe('localhost')

    // the second session, on its own page
    await browserSession(page, env, 'ws-b')
    await openLoadedTab(page, server.page('/c11c', titled('C11C')), 'C11C')
    await extAction(page, probe.name).click()
    await expect.poll(() => badgeText(page, probe.name), { timeout: 30_000 }).toBe('127.0.0.1')
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})

test('BB-C12: extension storage is one shared store across sessions', async ({ env }) => {
  test.setTimeout(420_000)
  const probe = stageExtension(env, 'storage-rw')
  installExtensions(env, [probe])
  const server = await startEchoServer()
  const { app, page } = await launchSettled(env)
  try {
    const url = server.page('/c12', titled('C12'))

    await browserSession(page, env, 'ws-a')
    await openTabOn(page, `${url}#write`)
    const writer = await guestByUrl(app, `${url}#write`)
    await expect
      .poll(() => rootAttr(writer, PROBE.storageWritten), { timeout: 30_000 })
      .toBe('done')

    await browserSession(page, env, 'ws-b')
    await openTabOn(page, `${url}#read`)
    const reader = await guestByUrl(app, `${url}#read`)
    await expect
      .poll(() => rootAttr(reader, PROBE.storage), { timeout: 30_000 })
      .toBe('koloft-bb-value')
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})

test('BB-C13: an extension page mixing the browser namespace (its popup) does not crash', async ({
  env
}) => {
  test.setTimeout(240_000)
  const probe = stageExtension(env, 'popup-browser-ns')
  installExtensions(env, [probe])
  const { app, page } = await launchSettled(env)
  try {
    await actionRowSession(page, env)
    const icon = extAction(page, probe.name)
    await expect(icon).toBeVisible({ timeout: 30_000 })
    await icon.click()

    await expect.poll(async () => (await extensionPopups(app)).length, { timeout: 30_000 }).toBe(1)
    await expect.poll(() => popupAttr(app, PROBE.popup), { timeout: 30_000 }).toBe('ok')
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-C14: allowing the runtime permission request reaches the extension as granted', async ({
  env
}) => {
  test.setTimeout(300_000)
  const probe = stageExtension(env, 'permissions')
  installExtensions(env, [probe])
  const { app, page } = await launchSettled(env)
  try {
    await actionRowSession(page, env)
    const icon = extAction(page, probe.name)
    await expect(icon).toBeVisible({ timeout: 30_000 })
    await icon.click()

    await expect(extConfirm(page)).toBeVisible({ timeout: 30_000 })
    await confirmButton(page, 'Allow').click()

    await expect.poll(() => badgeText(page, probe.name), { timeout: 30_000 }).toBe('y')
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-C15: an extension page opened via tabs.create renders as a Browser tab', async ({
  env
}) => {
  test.setTimeout(300_000)
  const probe = stageExtension(env, 'ext-page')
  installExtensions(env, [probe])
  const { app, page } = await launchSettled(env)
  try {
    await actionRowSession(page, env)
    const icon = extAction(page, probe.name)
    await expect(icon).toBeVisible({ timeout: 30_000 })
    const tabsBefore = await openTabs(page).count()
    const windowsBefore = (await windowStates(app)).length

    await icon.click()

    await expect(openTabs(page)).toHaveCount(tabsBefore + 1, { timeout: 30_000 })
    await expect(page.locator(`${BROWSER.tabActive} ${BROWSER.tabLabel}`)).toHaveText(
      'Koloft BB extension page',
      { timeout: 30_000 }
    )
    const tab = await guestByUrl(app, 'chrome-extension://')
    await expect.poll(() => rootAttr(tab, PROBE.extPage), { timeout: 30_000 }).toBe('ok')
    expect((await windowStates(app)).length).toBe(windowsBefore)
  } finally {
    await app.close().catch(() => {})
  }
})

// [PRE-IMPL: green — existing behavior] the soft-fail shape is Electron's own, pinned
// here as a regression guard once the platform makes it observable (§06,)
test('BB-C16: in a content script, chrome.storage.sync fails soft, never crashes', async ({
  env
}) => {
  test.setTimeout(240_000)
  const probe = stageExtension(env, 'storage-sync')
  installExtensions(env, [probe])
  const server = await startEchoServer()
  const { app, page } = await launchSettled(env)
  try {
    await browserSession(page, env)
    await openTabOn(page, server.page('/c16', titled('C16')))
    const guest = await guestByUrl(app, '/c16')
    await expect.poll(() => rootAttr(guest, PROBE.syncAlive), { timeout: 30_000 }).toBe('1')
    expect(await rootAttr(guest, PROBE.sync)).toBe('softfail')
    expect(await rootAttr(guest, PROBE.syncLocal)).toBe('ok')
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})

// §06 (manual find): the guest's UA already claims Chrome, but its Client
// Hints / navigator.userAgentData listed only Chromium — that mismatch marks it as an
// embedder. The Google Chrome brand is added so UA, CH and the real Chrome TLS agree.
// best-effort against Google's sign-in gate, pinned here as a consistency regression guard.
test('BB-C17: the browser guest presents a consistent Google Chrome brand in userAgentData', async ({
  env
}) => {
  test.setTimeout(240_000)
  const server = await startEchoServer()
  const { app, page } = await launchSettled(env)
  try {
    await browserSession(page, env)
    await openTabOn(page, server.page('/c17', titled('C17')))
    await expect.poll(() => server.count('/c17'), { timeout: 30_000 }).toBeGreaterThan(0)
    const guest = await guestByUrl(app, '/c17')
    const brand = await guest.evaluate(async () => {
      const uad = (
        navigator as unknown as {
          userAgentData?: {
            brands: Array<{ brand: string; version: string }>
            getHighEntropyValues: (h: string[]) => Promise<{
              fullVersionList: Array<{ brand: string; version: string }>
            }>
          }
        }
      ).userAgentData
      const high = await uad!.getHighEntropyValues(['fullVersionList'])
      const pick = (list: Array<{ brand: string; version: string }>, b: string): string | null =>
        list.find((x) => x.brand === b)?.version ?? null
      return {
        lowChrome: pick(uad!.brands, 'Google Chrome'),
        lowChromium: pick(uad!.brands, 'Chromium'),
        fullChrome: pick(high.fullVersionList, 'Google Chrome'),
        fullChromium: pick(high.fullVersionList, 'Chromium')
      }
    })
    // a Google Chrome brand exists in both lists, versioned like the Chromium entry
    expect(brand.lowChrome).not.toBeNull()
    expect(brand.lowChrome).toBe(brand.lowChromium)
    expect(brand.fullChrome).not.toBeNull()
    expect(brand.fullChrome).toBe(brand.fullChromium)
    // the other real-Chrome tells: window.chrome.loadTimes/csi are functions, and
    // navigator.webdriver is false (§06 manual finds — Google's gate reads these)
    const tells = await guest.evaluate(() => ({
      loadTimes: typeof (window as unknown as { chrome?: { loadTimes?: unknown } }).chrome
        ?.loadTimes,
      csi: typeof (window as unknown as { chrome?: { csi?: unknown } }).chrome?.csi,
      webdriver: navigator.webdriver
    }))
    expect(tells.loadTimes).toBe('function')
    expect(tells.csi).toBe('function')
    expect(tells.webdriver).toBe(false)
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})

// ---- Non-functional ----------------------------------------------------------------------

test('BB-N01: install/permission confirmation never uses a native dialog', async ({ env }) => {
  test.setTimeout(300_000)
  const probe = stageExtension(env, 'permissions')
  installExtensions(env, [probe])
  const { app, page } = await launchSettled(env)
  try {
    await actionRowSession(page, env)
    const icon = extAction(page, probe.name)
    await expect(icon).toBeVisible({ timeout: 30_000 })
    await icon.click()

    await expect(extConfirm(page)).toBeVisible({ timeout: 30_000 })
    // nothing but the host window and (possibly) a popup floater is on screen …
    expect(await strayWindows(app)).toEqual([])
    // … and the confirmation itself lives in the host window's document
    await expect(extConfirm(page)).toHaveCount(1)
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-N02: with no route to the Web Store, startup stays silent and injection still works', async ({
  env
}) => {
  test.setTimeout(300_000)
  const probe = stageExtension(env, 'base')
  installExtensions(env, [probe])
  // D10's offline Given must be forced — the isolated env does not block network, so
  // kill resolution for the store hosts (env.extraArgs precedent: fixtureServer aliases)
  env.extraArgs.push(
    '--host-resolver-rules=MAP chromewebstore.google.com ~NOTFOUND,MAP *.gvt1.com ~NOTFOUND,MAP clients2.google.com ~NOTFOUND'
  )
  const server = await startEchoServer()
  const { app, page } = await launchSettled(env)
  try {
    const windows = await windowStates(app)
    expect(windows.filter((w) => /out\/renderer\/index\.html/.test(w.url))).toHaveLength(1)

    await browserSession(page, env)
    await openTabOn(page, server.page('/n02', titled('N02')))
    const guest = await guestByUrl(app, '/n02')
    await expect.poll(() => rootAttr(guest, PROBE.injected), { timeout: 30_000 }).toBeTruthy()

    // no update / error surface anywhere
    await expect(page.locator('.modal')).toHaveCount(0)
    await expect(page.locator(BROWSER.modal)).toHaveCount(0)
    await expect(extConfirm(page)).toHaveCount(0)
    await expect(page.locator(BROWSER.errorPage)).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})
