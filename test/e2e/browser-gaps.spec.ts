import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
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

/**
 * The Workbench cases that fall between the other browser-*.spec.ts clusters (the case ids are the original case list's, and the spec carrying an
 * id IS its contract) — first load of an agent tab, the ⌘⇧B / ⌘L / ⌘[ ⌘] keys, the
 * session-scoped tab set, the reading area's web retirement, terminal link registration,
 * the dedup/cap invariants an agent must not be able to breach, the "agent may not drive
 * a guest" boundary, the crash / dialog / clear-data surfaces, and the S1
 * zero-external-open flow:
 *
 *   BB-M02 BB-M13 BB-M14 BB-M15 BB-M25
 *   BB-C02 BB-C03 BB-C08 BB-C09 BB-C10 BB-C12 BB-C24 BB-C33 BB-C34 BB-C38
 *   BB-C44 BB-C45 BB-C47 BB-C58 BB-C59 BB-C61 BB-C64
 *   BB-N07
 *
 * …plus F4 of the manual round, which pins the user's own side of the devtools
 * affordance the BB-C59/BB-C61 pair only ever denied to a page.
 *
 * Nothing imports from src/ — each oracle is the one its case names (the panel's markup,
 * `data-surface` / `data-kind`, the TEST-10 request log, the TEST-6 `window.__koloftTerms`
 * seam, TEST-4's KOLOFT_DOWNLOAD_DIR, the TEST-2 external-open choke point, the TEST-8
 * injectable guest cap) or Electron's own window/webContents inventory.
 *
 * Offscreen (KOLOFT_TEST_BACKGROUND=1) `document.hasFocus()` reports true in three places
 * at once, so nothing here reads it: focus is `document.activeElement`, the active tab's
 * kind is `data-kind`, and windows are counted through BrowserWindow.
 */

// ---- shared plumbing -------------------------------------------------------------------

/** FR-02: the pinned `files` tab's label is always the first entry `wbTabTitles` reports. */
const FILES_LABEL = 'Files'

/** a page whose <title> is `name`, so the tab strip carries a decidable label */
function titled(name: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head>` +
    `<body><h1 id="mark">${name}</h1></body></html>`
  )
}

/** Given: one bound session in ws-a. */
async function runningSession(page: Page, env: E2EEnv): Promise<void> {
  gitInit(env.workspaces.a)
  await startSessionIn(page, 'ws-a')
}

/**
 * …plus the panel up — the tab strip is only observable while it is shown.
 *
 * Deliberately does NOT mint a `web` tab: most cases here count what a routing decision
 * put in the strip, and a tab the Given opened would be one the case has to subtract.
 */
async function browserSession(page: Page, env: E2EEnv): Promise<void> {
  await runningSession(page, env)
  await showWorkbench(page)
}

/** Raise the panel. `openBrowser` chooses T1 vs T2 now rather than a surface, and the
 *  panel is open by DEFAULT after the merge (FR-06), so it is usually a no-op. */
async function showWorkbench(page: Page): Promise<void> {
  await expect(globeIcon(page)).toBeVisible({ timeout: 30_000 })
  await openBrowser(page)
}

/** …and the Given variant with a blank `web` tab already up, for the address-bar cases
 *  (FR-52: the panel opens on the pinned `files` tab, whose kind bar has no address
 *  field at all, so nothing can be typed before one is minted). */
async function addressBarSession(page: Page, env: E2EEnv): Promise<void> {
  await browserSession(page, env)
  await newWebTab(page)
  await expect(addressField(page)).toBeVisible({ timeout: 20_000 })
}

/** Open one more tab on `url`: ＋ ▸ New web tab, then the address bar it just focused. */
async function openTabOn(page: Page, url: string): Promise<void> {
  await newWebTab(page)
  await expect(addressField(page)).toBeVisible({ timeout: 20_000 })
  await typeInAddressBar(page, url)
}

/** Open a tab on `/<name>` and wait until the strip shows that page's title. */
async function openLoadedTab(page: Page, server: FixtureServer, name: string): Promise<void> {
  const url = server.page(`/${name.toLowerCase()}`, titled(name))
  await openTabOn(page, url)
  // An unloaded tab is labelled from its url (host/lastSegment), and `/x` already
  // contains "X" — so a substring match would return before the page reported its title
  // and leave the next assertion racing it. Wait for the label to BE the title.
  await expect(page.locator(`${BROWSER.tabActive} ${BROWSER.tabLabel}`)).toHaveText(name, {
    timeout: 30_000
  })
  await expect(wbTabByTitle(page, name)).toHaveCount(1, { timeout: 30_000 })
}

/**
 * Everything the session's TUI has printed, scrollback included (the TEST-6
 * `window.__koloftTerms` seam — the DOM renderer only paints the viewport, and a case that
 * fires several agent opens scrolls its own evidence off screen).
 */
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

/** How many agent `open`s the fake claude has reported so far. */
async function openedCount(page: Page): Promise<number> {
  return ((await terminalScrollback(page)).match(/\]\s+opened\s/g) ?? []).length
}

/**
 * Make the AGENT open something and wait for the fake claude's own "opened" line — a
 * TEST-3 positive barrier, never an oracle: it says only that the request left the pty,
 * so a negative assertion after it cannot pass vacuously. Counted rather than matched,
 * so a case that opens the same url several times still gets one barrier per call.
 */
async function agentOpen(page: Page, target: string): Promise<void> {
  const before = await openedCount(page)
  await openViaAgent(page, target)
  await expect.poll(() => openedCount(page), { timeout: 40_000 }).toBeGreaterThan(before)
}

/** Every live guest's url, as the main process sees it (empty string = never loaded). */
async function guestUrls(app: ElectronApplication): Promise<string[]> {
  return (await guestContents(app)).map((g) => g.url)
}

/** Is the keyboard focus inside `selector`? (activeElement, never hasFocus — R7/TEST-8) */
function focusInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.activeElement as HTMLElement | null
    return !!el && (el.matches(sel) || el.closest(sel) !== null)
  }, selector)
}

/** The width the centre TUI currently occupies (0 when it is not on screen). */
async function tuiWidth(page: Page): Promise<number> {
  const box = await page.locator('.term-island').first().boundingBox()
  return box ? Math.round(box.width) : 0
}

// ---- Main flow --------------------------------------------------------------------------

// BB-M02 — D10/B5 / F2: the agent builds the tab, the USER's click is what loads it. The
// echo server's request log is the only thing that can tell "built" from "loaded" apart.
test('BB-M02: user clicking the agent-created tab loads it for the first time and clears the unread marker', async ({
  page,
  env
}) => {
  test.setTimeout(240_000)
  const server = await startEchoServer()
  try {
    await browserSession(page, env)
    await agentOpen(page, server.localhostUrl('/a'))

    // Given: the agent's tab exists, carries the unread marker, and nothing was fetched
    await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
    await expect(wbUnreadTabs(page)).toHaveCount(1)
    expect(server.count()).toBe(0)

    await openTabs(page).first().click()

    // exactly one request — the page runs for the first time on the user's intent
    await expect.poll(() => server.count('/a'), { timeout: 30_000 }).toBe(1)
    expect(server.count()).toBe(1)
    await expect(openTabs(page).first()).toHaveClass(/\bon\b/, { timeout: 20_000 })
    await expect(wbUnreadTabs(page)).toHaveCount(0)
  } finally {
    await server.close()
  }
})

// BB-M13 — D9/F3, now FR-06: ⇧⌘B is the panel's own toggle, and a collapse is only real if
// the TUI gets the width back. The Given had to be reached rather than assumed after the
// merge: the panel is open by default (`workbench.defaultOpen`), so the case collapses it
// with the very key it is about before measuring the collapsed width.
test('BB-M13: ⌘⇧B opens the Workbench and toggles it closed again', async ({ app, page, env }) => {
  test.setTimeout(240_000)
  await runningSession(page, env)

  // Given: the panel is collapsed (T1)
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

// BB-M14 — D1/F6: the tab set belongs to the session, not to the window. Switching
// sessions swaps the whole strip, both ways.
test('BB-M14: switching sessions swaps the entire tab set', async ({ page }) => {
  test.setTimeout(360_000)
  const server = await startEchoServer()
  try {
    await startSessionIn(page, 'ws-a')
    await startSessionIn(page, 'ws-b')
    const rowA = wsRows(page, 'ws-a').first()
    const rowB = wsRows(page, 'ws-b').first()

    // Given: session A has [X, Y] …
    await rowA.click()
    await showWorkbench(page)
    await openLoadedTab(page, server, 'X')
    await openLoadedTab(page, server, 'Y')
    expect(await wbTabTitles(page)).toEqual([FILES_LABEL, 'X', 'Y'])

    // … and session B has [Z]
    await rowB.click()
    await expect(rowB).toHaveClass(/\bactive\b/, { timeout: 20_000 })
    await showWorkbench(page)
    await openLoadedTab(page, server, 'Z')
    expect(await wbTabTitles(page)).toEqual([FILES_LABEL, 'Z'])

    // switching back to A shows A's set …
    await rowA.click()
    await expect(rowA).toHaveClass(/\bactive\b/, { timeout: 20_000 })
    await showWorkbench(page)
    expect(await wbTabTitles(page)).toEqual([FILES_LABEL, 'X', 'Y'])

    // … and switching to B shows only B's
    await rowB.click()
    await expect(rowB).toHaveClass(/\bactive\b/, { timeout: 20_000 })
    await showWorkbench(page)
    expect(await wbTabTitles(page)).toEqual([FILES_LABEL, 'Z'])
  } finally {
    await server.close()
  }
})

// BB-M15 — D5/D6/U5 / §06D: the reading area is "the file's own shape". Its header offers
// the file's own views and carries no web affordance, and no .html ever renders inside it.
// After the merge the scope moved with the pane: the former `.file-pane-col` wrapper and
// the `.file-pane` root are both gone, and the pane is `.wb-artifact` under Browse's
// `.fv-read` column — so the "no web chrome" assertions are scoped to that column. The
// panel around it legitimately owns an address bar, just never for this kind (FR-36).
//
// The VIEW ROSTER is the half changed, and the case text was what went out of date
// rather than the selector. §Architecture's mount-strategy callout says so outright:
//   "Note `view` goes from today's 2 states (content / diff, FilePane.tsx:278) to 3
//    (Rendered | Diff | Source) — this layer is NOT a logic-preserving move."
// FR-30 then gives code no Rendered form at all, so the count is three for markdown and
// two for code — which is why this asserts the segment's CONTENTS for the fixture's kind
// rather than a number. A bare count is what let the old contract drift silently. The
// claim the case carries is unchanged: the segments are the FILE's shapes, and none of
// them is a web affordance.
test('BB-M15: the reading area no longer renders web pages — only the file’s own views remain', async ({
  page,
  env
}) => {
  test.setTimeout(240_000)
  await runningSession(page, env)

  await openInBrowse(page, path.join(env.workspaces.a, 'README.md'))
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.md', { timeout: 30_000 })

  // the header offers exactly the markdown roster …
  const segs = page.locator(
    `${WORKBENCH.panel} .fv-artifact-hd .seg[aria-label="View mode"] button`
  )
  await expect(segs).toHaveText(['Rendered', 'Diff', 'Source'])
  // … and no web chrome at all in the reading column. `Reload` is deliberately NOT in the
  // list any more: FR-31 gives the artifact header a ↻ of its own, so it stopped being a
  // web-only affordance — Back/Forward still are.
  const col = page.locator(`${WORKBENCH.panel} .fv-read`)
  await expect(col).toHaveCount(1)
  expect(await col.locator('.baddr').count()).toBe(0)
  expect(await col.locator(BROWSER.tabStrip).count()).toBe(0)
  expect(await col.locator('[aria-label="Back"], [aria-label="Forward"]').count()).toBe(0)
  // the `files` kind bar is on screen, and it is not the address-bar row (FR-36)
  expect(await page.locator(BROWSER.addressBar).count()).toBe(0)

  // …and opening an .html never yields a rendered page inside the reading area: it goes to
  // a `web` tab instead (FR-11), so the pane neither hosts a guest nor takes its title
  await openInBrowse(page, path.join(env.workspaces.a, 'docs', 'page.html'))
  await page.waitForTimeout(4000)
  expect(
    await page
      .locator(`${WORKBENCH.panel} .fv-read webview, ${WORKBENCH.panel} .fv-read iframe`)
      .count()
  ).toBe(0)
  expect(await page.locator(WORKBENCH.readingTitle, { hasText: 'page.html' }).count()).toBe(0)
  // the barrier: it really did land, as a `web` tab
  await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('web')
})

// BB-M25 — pain point 6 / P1⑦ / TEST-6: a printed URL has to be a LINK, not inert text. The
// oracle is the case's own wording — a registered link provider that matches the url —
// read off the live xterm instance through the __koloftTerms seam.
test('BB-M25: a URL printed in the terminal is clickable (WebLinks addon present)', async ({
  page,
  env
}) => {
  test.setTimeout(240_000)
  const server = await startEchoServer()
  try {
    await runningSession(page, env)
    const url = server.localhostUrl('/a')

    // Given: the session's terminal has printed the url (it echoes what it is handed)
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

    // barrier: the url really is in a live terminal's buffer …
    expect(probe.printed).toBe(true)
    // … and a link provider claims it (today nothing does — the text is inert)
    expect(probe.linkTexts.some((t) => t.includes(url))).toBe(true)
  } finally {
    await server.close()
  }
})

// ---- Corner cases: what an agent open may and may not move --------------------------------

// BB-C02 — D4③ / F4: an agent re-open of a url that already has a tab reuses it and does
// nothing else. It may light the unread dot; it may not take the user's current tab away.
test('BB-C02: agent re-open of an existing URL only sets the unread dot, current tab unchanged', async ({
  page,
  env
}) => {
  test.setTimeout(300_000)
  const server = await startEchoServer()
  try {
    await browserSession(page, env)

    // Given: [A(active), B], and B carries no unread dot (both are user-opened)
    await openLoadedTab(page, server, 'A')
    await openLoadedTab(page, server, 'B')
    await wbTabByTitle(page, 'A').click()
    await expect(wbTabByTitle(page, 'A')).toHaveClass(/\bon\b/, { timeout: 20_000 })
    await expect(wbUnreadTabs(page)).toHaveCount(0)

    await agentOpen(page, server.url('/b'))

    // B gains the dot — the positive barrier before the two negatives
    await expect(wbTabByTitle(page, 'B')).toHaveClass(/\bagent\b/, { timeout: 30_000 })
    await expect(openTabs(page)).toHaveCount(2)
    await expect(wbTabByTitle(page, 'A')).toHaveClass(/\bon\b/)
    await expect(wbTabByTitle(page, 'B')).not.toHaveClass(/\bon\b/)
  } finally {
    await server.close()
  }
})

// BB-C03 — D4③ / SEC-15: the dedup key ignores `#hash`, so a hostile page cannot mint a
// fresh tab per fragment. The per-session cap is the backstop, enforced independently of
// dedup: a script firing #1.. must not push the strip past 8.
test('BB-C03: dedup ignores #hash but the per-session cap still blocks #1..#N tab-flooding', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  const server = await startEchoServer()
  try {
    await addressBarSession(page, env)

    // Given: a tab on /p#one, then a second tab on top of it so /p is in the background
    // (a re-open of the tab on screen lights no dot, so the barrier below needs
    // the hit to be a background tab)
    await typeInAddressBar(page, server.url('/p#one'))
    await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
    await openTabOn(page, server.page('/q', titled('Q')))
    await expect(openTabs(page)).toHaveCount(2, { timeout: 30_000 })

    // #two is the same resource: reuse, never a third tab
    await agentOpen(page, server.url('/p#two'))
    await expect(wbUnreadTabs(page)).toHaveCount(1, { timeout: 30_000 })
    await page.waitForTimeout(3000)
    expect(await openTabs(page).count()).toBe(2)

    // …and a script that opens twelve distinct fragments cannot exceed the 8-tab cap
    const flood = server.page(
      '/flood',
      '<!doctype html><html><head><meta charset="utf-8"><title>Flood</title></head><body>' +
        '<button id="go">go</button><div id="fired"></div><script>' +
        'document.getElementById("go").addEventListener("click", function () {' +
        '  var n = 0;' +
        '  for (var i = 1; i <= 12; i++) { window.open("/p#" + i, "_blank"); n++ }' +
        '  document.getElementById("fired").textContent = String(n)' +
        '})</script></body></html>'
    )
    await openTabOn(page, flood)
    const guest = await guestByUrl(app, '/flood')
    await guest.locator('#go').click()

    // barrier: the script really fired all twelve opens
    await expect(guest.locator('#fired')).toHaveText('12', { timeout: 30_000 })
    await page.waitForTimeout(5000)
    expect(await openTabs(page).count()).toBeLessThanOrEqual(8)
  } finally {
    await server.close()
  }
})

// BB-C09 — D10/B5: with the panel wide open, an agent-created tab still may not run. The
// zero-request assertion rides a positive barrier (the tab appearing) and a settle, so it
// cannot pass merely because the shim had not finished yet.
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

// BB-C10 — F4/D10/A7 / FR-13/FR-51: the invariant an agent may never breach. Whatever it
// opens, the user's current tab stays current and a collapsed panel stays collapsed. What
// the merge changed is the tail: "the only thing the agent gets is the Globe's unread dot"
// became "the agent gets NO titlebar signal at all" (FR-51 deletes both the dot and the
// count out loud), so the dot assertion is inverted and the tab it really did build is
// asserted where it now lives — inside the strip, once the user expands the panel.
test('BB-C10: no agent action changes the current tab or the panel open/collapsed state', async ({
  page,
  env
}) => {
  test.setTimeout(300_000)
  const server = await startEchoServer()
  try {
    await browserSession(page, env)

    // Given: the user is on tab #1, panel open
    await openLoadedTab(page, server, 'A')
    await expect(wbTabByTitle(page, 'A')).toHaveClass(/\bon\b/, { timeout: 20_000 })

    await agentOpen(page, server.url('/b'))
    await agentOpen(page, server.url('/next'))

    // barrier: both agent tabs landed
    await expect(wbUnreadTabs(page)).toHaveCount(2, { timeout: 40_000 })
    await expect(wbTabByTitle(page, 'A')).toHaveClass(/\bon\b/)
    expect(await activeKind(page)).toBe('web')
    await expect(browserSurface(page)).toBeVisible()

    // Given: the panel is now collapsed
    await globeIcon(page).click()
    await expect(browserSurface(page)).toBeHidden({ timeout: 20_000 })

    await agentOpen(page, server.url('/p'))
    await page.waitForTimeout(5000)

    // the panel did not expand itself, and the titlebar says nothing whatsoever. "Not on
    // screen" is read from `data-surface`, written only while the panel is SHOWING —
    // `data-kind` names the active tab whether or not anything is painted.
    await expect(browserSurface(page)).toBeHidden()
    expect(await activeSurface(page)).toBeNull()
    expect(await globeHasUnread(page)).toBe(false)
    await expect(globeIcon(page)).not.toHaveClass(/\bon\b/)

    // …the tab is nonetheless there, unread, the moment the user expands — which is the
    // only way to discover it now, and the barrier keeping the absences above honest
    await showWorkbench(page)
    await expect(wbUnreadTabs(page)).toHaveCount(3, { timeout: 20_000 })
    await expect(wbTabByTitle(page, 'A')).toHaveClass(/\bon\b/)
  } finally {
    await server.close()
  }
})

// BB-C08 — D4②: the live-guest cap is GLOBAL. Two sessions holding one guest each already
// sit at a cap of 2, and the third guest has to come out of the same global budget — the
// LRU across both sessions is what gives way. TEST-8's injectable cap keeps this to three
// renderer processes instead of thirteen.
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

    // Given: one live guest in session A …
    await rowA.click()
    await expect(rowA).toHaveClass(/\bactive\b/, { timeout: 20_000 })
    await showWorkbench(page)
    await openLoadedTab(page, server, 'T1')

    // … and one in session B — two in total, exactly at the cap
    await rowB.click()
    await expect(rowB).toHaveClass(/\bactive\b/, { timeout: 20_000 })
    await showWorkbench(page)
    await openLoadedTab(page, server, 'T2')
    const liveGuests = async (): Promise<number> =>
      (await guestContents(app)).filter((g) => g.url.startsWith(server.origin)).length
    await expect.poll(liveGuests, { timeout: 30_000 }).toBe(2)

    // a third guest is needed
    await openLoadedTab(page, server, 'T3')

    // sampled across two seconds: the global live count never goes past the cap
    const samples: number[] = []
    for (let i = 0; i < 8; i++) {
      samples.push(await liveGuests())
      await page.waitForTimeout(250)
    }
    expect(Math.max(...samples)).toBeLessThanOrEqual(2)

    // …and the one that gave way is the LRU across BOTH sessions: session A's guest
    await rowA.click()
    await expect(rowA).toHaveClass(/\bactive\b/, { timeout: 20_000 })
    await showWorkbench(page)
    await expect(wbTabByTitle(page, 'T1')).toHaveClass(/\bfrozen\b/, { timeout: 30_000 })
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})

// ---- Corner cases: the agent may not drive a guest ----------------------------------------

/**
 * The running session's pty tab id, read from the shim's own registration drop
 * (`<userData>/sessions/<regId>.json`) — the same place a co-user process would read it.
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
        for (const file of files) {
          try {
            const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as { tabId?: string }
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
      { timeout: 30_000 }
    )
    .not.toBe('')
  return tabId
}

/** Every callable on the preload bridge, as dotted paths (`terminal.write`, …). */
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

// BB-C12 — rewritten later. The old reading ("an agent gets NO way to reach into
// an open page, ever") is retired: agents drive pages now, through the CDP
// endpoint, behind the user's own per-session confirmation and a switch in Settings.
//
// What still holds — and is what this case pins — is that the OTHER channels remain
// display-only. The open-requests directory is writable by any process of this user
// (SEC-14), so a drive instruction dropped there must do nothing; and Koloft's own preload
// bridge exposes no page-driving method, because the relay is main's business and a
// renderer path would be a second, ungated one.
test('BB-C12: the open-request channel and the preload bridge still cannot drive a page', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  const server = await startEchoServer()
  try {
    await addressBarSession(page, env)

    // a loaded page the agent would want to drive
    const probeUrl = server.page(
      '/probe',
      '<!doctype html><html><head><meta charset="utf-8"><title>Probe</title></head>' +
        '<body><div id="probe">untouched</div><a id="link" href="/b">go</a></body></html>'
    )
    await typeInAddressBar(page, probeUrl)
    const guest = await guestByUrl(app, '/probe')
    await expect(guest.locator('#probe')).toHaveText('untouched', { timeout: 30_000 })

    const tabId = await sessionTabId(env)
    // the sanctioned affordance, on its own — the positive barrier
    const next = server.url('/next')
    dropOpenRequest(env, { tabId, path: next, url: next })
    await expect(openTabs(page)).toHaveCount(2, { timeout: 40_000 })

    // …and the same channel carrying drive instructions for the open page
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

    // the enumerated bridge holds no guest-driving method either
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

// BB-C24 — §05B row 13 / D12 / SEC-2: `target=_blank` is a tab, not an OS window.
test('BB-C24: `target=_blank` never opens a system browser window', async ({ app, page, env }) => {
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

    // it opened as a Browser tab that really loaded …
    await expect(openTabs(page)).toHaveCount(2, { timeout: 30_000 })
    await guestByUrl(app, `:${server.port}/b`)
    await expect.poll(() => server.count('/b'), { timeout: 30_000 }).toBeGreaterThan(0)
    // … and nothing left Koloft
    expect((await windowStates(app)).length).toBe(windowsBefore)
    expect(readOpenCalls(env)).toEqual(openCallsBefore)
    expect(readExternalOpens(env)).toEqual(externalBefore)
  } finally {
    await server.close()
  }
})

// ---- Corner cases: keys and titlebar state -------------------------------------------------

// BB-C33 — B2/Q3/F3 / FR-04: with no running session selected there is no tab set to show,
// so the panel's icon is grayed. "The same rule the Eye already follows" retired with the
// Eye (FR-55: the aux roster is exactly two icons now), which turns the case's own
// comparison into the stronger statement that there IS no second icon to compare against.
test('BB-C33: with no selected running session the Workbench icon is disabled', async ({
  page
}) => {
  test.setTimeout(120_000)
  // Given: the fixture's two pinned workspaces, and no session started at all
  await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 30_000 })
  await expect(page.locator('.ws-tab')).toHaveCount(0)

  await expect(page.locator('.aux-icons .aux-ico')).toHaveCount(1, { timeout: 20_000 })
  await expect(auxIcon(page, 'Preview')).toHaveCount(0)
  await expect(globeIcon(page)).toBeVisible({ timeout: 20_000 })
  await expect(globeIcon(page)).toHaveAttribute('aria-disabled', 'true')
  // FLIPPED by D1, then retired with the icon: this line used to read "the Terminal
  // icon belongs to no session, so it stays available (FR-09)". A shell lives inside a
  // session's panel now and has no titlebar button at all — its three doors (⌃`, the menu
  // item, the strip's ＋) share one gate, walked by workbench-terminal.spec.ts T-WT-07.
  await expect(auxIcon(page, 'Terminal')).toHaveCount(0)
})

// BB-C34 — D9: ⌘L pressed with the focus inside a guest still has to reach the host's
// address bar (the before-input-event path), and it arrives with the url ready to replace.
test('BB-C34: ⌘L focuses the address bar when the Browser is focused', async ({
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
    // a REAL click into the guest first (R7): that is what makes the Browser focused
    await guest.locator('#page-a').click({ timeout: 20_000 })

    await guest.keyboard.press('Meta+l')

    await expect.poll(() => focusInside(page, BROWSER.addressBar), { timeout: 20_000 }).toBe(true)
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

// BB-C38 — D9: ⌘[ / ⌘] are the Browser's history keys once it holds the surface.
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

    // Given: A→B history in the focused tab
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

// ---- Corner cases: crash, dialogs, first load ----------------------------------------------

// BB-C44 — §05D-12 / G0-7: a dead render process leaves a placeholder the user can act on,
// and Koloft does not quietly re-run the page behind their back.
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
    // button wording is non-contractual per PRD §06E; the manual reload control is
    const reload = placeholder.locator('button', { hasText: /Reload/i })
    await expect(reload).toBeVisible()

    // nothing reloads on its own …
    await page.waitForTimeout(6000)
    expect(server.count('/a')).toBe(1)

    // … until the button is clicked
    await reload.click()
    await expect.poll(() => server.count('/a'), { timeout: 30_000 }).toBe(2)
  } finally {
    await server.close()
  }
})

/**
 * Accept the guest's DOM dialog (§05D-11): fill its field when the case supplies text,
 * then take the affirmative affordance — the house `.btn-primary`, or the last button
 * when the modal spells it differently.
 */
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

// BB-C45 — §05D-11 / G0-2: alert/confirm/prompt are DOM modals (a native one would be an
// OS window this suite may not raise), and the value the page gets back is the real one.
test('BB-C45: JS dialogs use a DOM modal, not a native dialog', async ({ app, page, env }) => {
  test.setTimeout(300_000)
  const server = await startEchoServer()
  try {
    await addressBarSession(page, env)
    await typeInAddressBar(page, server.url('/dialogs'))
    const guest = await guestByUrl(app, '/dialogs')

    // A dialog that really blocks its page also blocks the renderer's input ack, so the
    // click promise cannot settle until the modal is answered — awaiting it first would
    // deadlock the test, not the product. The click therefore runs concurrently with the
    // answer and is awaited after. Every assertion below is unchanged.

    // alert: a DOM modal naming the page origin; dismissing it returns to the page
    const alerted = guest.locator('#do-alert').click()
    const modal = page.locator(BROWSER.modal)
    await expect(modal).toBeVisible({ timeout: 30_000 })
    await expect(modal).toContainText('koloft alert')
    await expect(modal).toContainText(`${server.host}:${server.port}`)
    await acceptModal(page)
    await alerted
    await expect(guest.locator('#result')).toHaveText('alert-returned', { timeout: 20_000 })

    // confirm: the affirmative answer reaches the page as `true`
    const confirmed = guest.locator('#do-confirm').click()
    await acceptModal(page)
    await confirmed
    await expect(guest.locator('#result')).toHaveText('confirm:true', { timeout: 20_000 })

    // prompt: so does the typed value
    const prompted = guest.locator('#do-prompt').click()
    await acceptModal(page, 'koloft-e2e-prompt')
    await prompted
    await expect(guest.locator('#result')).toHaveText('prompt:koloft-e2e-prompt', {
      timeout: 20_000
    })
  } finally {
    await server.close()
  }
})

// BB-C47 — D10/B5: the never-loaded agent tab is the frozen tab in disguise — the user's
// click is what runs it, from the url the tab has been carrying all along. Zero new
// machinery, so the first request must land at exactly that moment.
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

    // Given: never loaded — the same state a frozen tab sits in
    expect(server.count('/a')).toBe(0)
    expect((await guestUrls(app)).filter((u) => u.includes(`:${server.port}/a`))).toEqual([])

    await openTabs(page).first().click()

    // it loads from its stored url, at that moment, exactly once
    await expect.poll(() => server.count('/a'), { timeout: 30_000 }).toBe(1)
    await guestByUrl(app, `:${server.port}/a`)
    await expect(wbFrozenTabs(page)).toHaveCount(0)
  } finally {
    await server.close()
  }
})

// BB-C58 — TEST-7: the dedup key is normalized, so trailing slash, default port, host case
// and query order all name the same resource. Each variant is asserted on its own, after a
// settle: a second tab arriving late must not slip past a count that matched early.
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

    // Given: a tab on /p?a=1&b=2
    await agentOpen(page, `${base}/p?a=1&b=2`)
    await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })

    // ① trailing slash
    await agentOpen(page, `${base}/p/?a=1&b=2`)
    expect(await settledTabs()).toBe(1)

    // ② host case
    await agentOpen(page, `http://LOCALHOST:${server.port}/p?a=1&b=2`)
    expect(await settledTabs()).toBe(1)

    // ③ query order
    await agentOpen(page, `${base}/p?b=2&a=1`)
    expect(await settledTabs()).toBe(1)

    // ④ default port: `:80` and no port are the same resource (a second tab, never a third)
    await agentOpen(page, 'http://localhost:80/q?a=1')
    await expect(openTabs(page)).toHaveCount(2, { timeout: 30_000 })
    await agentOpen(page, 'http://localhost/q?a=1')
    expect(await settledTabs()).toBe(2)
  } finally {
    await server.close()
  }
})

// ---- Corner cases: devtools is the user's, not the page's -----------------------------------

interface DevtoolsState {
  /** every live guest and whether IT has devtools open */
  guests: { url: string; devtools: boolean }[]
  /** urls of every devtools surface currently alive */
  devtoolsPages: string[]
}

/** Who has devtools open right now, read from Electron's own webContents inventory. */
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

// BB-C59 — SEC-15 / D13: devtools is a user affordance. A page that asks for it, and an
// agent that asks for it, both get nothing — otherwise it is one more agent control panel.
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
    // barrier: the page really made its attempts
    await expect(guest.locator('#done')).toHaveText(/^tried:[1-9]/, { timeout: 30_000 })

    // …and so did the agent
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

// BB-C61 — D13: the user's own devtools is per tab and detaches into its own window. It
// must not drag any other tab's guest into life, and (R7) it must never surface.
test('BB-C61: a detached devtools window opens without auto-loading extra guests, per-tab', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  const server = await startEchoServer()
  try {
    await addressBarSession(page, env)

    // tab 1: loaded and current
    await typeInAddressBar(page, server.url('/a'))
    await guestByUrl(app, `:${server.port}/a`)
    // tab 2: an agent tab that has never loaded
    await agentOpen(page, server.url('/b'))
    await expect(openTabs(page)).toHaveCount(2, { timeout: 30_000 })

    // D6/R14: ⌥⌘I reaches the GUEST only while the panel is lit and the active tab is
    // web — the menu item travels the same command path as the key, and only New/Close
    // Browser Tab are exempt from the focus rule. Without this click the caret is still in
    // the conversation and the request acts on the whole window instead, so no guest
    // devtools ever opens. The "panel not lit" cell is workbench-focus.spec.ts T-FX-04's.
    await page.locator(WORKBENCH.panel).click({ position: { x: 5, y: 5 } })
    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.devtools)

    // a devtools surface came up, bound to the ACTIVE tab's guest and to nothing else
    await expect
      .poll(async () => (await devtoolsState(app)).devtoolsPages.length, { timeout: 40_000 })
      .toBeGreaterThan(0)
    // the guest's own flag flips a beat after its devtools page appears, so this polls
    // too — measured: the page exists first, isDevToolsOpened() follows
    await expect
      .poll(async () => (await devtoolsState(app)).guests.filter((g) => g.devtools).length, {
        timeout: 40_000
      })
      .toBe(1)
    const opened = (await devtoolsState(app)).guests.filter((g) => g.devtools)
    expect(opened[0].url).toContain(`:${server.port}/a`)
    // …nothing surfaced (R7 / TEST-9)
    for (const w of await windowStates(app)) expect(w.visible).toBe(false)
    // …and the other tab was not dragged into life
    expect(server.count('/b')).toBe(0)

    // a different tab gets its own instance
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

// F4 — the other half of BB-C59: the user's OWN ⌥⌘I must reach
// the active guest and come back off on a second press. Nothing pinned the affordance
// working, only that a page and an agent cannot have it, so the whole user path could rot
// with the suite green. The window it raises stays unfocused HERE (R7) and only here:
// under KOLOFT_TEST_BACKGROUND a run may never take the screen, while a real gesture brings
// its window forward like Chrome's.
test('F4: ⌥⌘I opens devtools on the active guest and toggles it closed again', async ({
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

    // the guest's own flag follows its devtools page by a beat (BB-C61's measurement)
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

// ---- Corner case: clearing the partition ----------------------------------------------------

/** The proceed entry of the certificate interstitial (§05D-4). Wording is non-contractual
 *  per PRD §06E — only the affordance's presence is. */
const PROCEED = /Proceed anyway/i

/** How many proceed affordances are on screen, host surface and guests alike. */
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

/** Wait for the interstitial's proceed entry and click it. */
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

/** Answer the basic-auth DOM modal (§05D-5) with the fixture's credentials. */
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

/** The `Authorization` header of the most recent /auth request (empty when there was none). */
function lastAuthHeader(server: FixtureServer): string {
  const hits = server.requestsFor('/auth')
  return hits.length ? (hits[hits.length - 1].headers['authorization'] ?? '') : ''
}

// BB-C64 — SEC-11 / D11: "Clear browsing data" is the whole partition, not just its cookie jar.
// Every category is asserted one by one, each after a barrier proving it was really
// there to begin with.
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

      // ①-④ cookie + service worker + cache + IndexedDB all land
      await typeInAddressBar(page, server.url('/storage'))
      const storage = await guestByUrl(app, '/storage')
      await expect(storage.locator('#stored')).toHaveText(/cookie.*sw.*cache.*idb/, {
        timeout: 60_000
      })
      await typeInAddressBar(page, server.url('/echo'))
      await expect.poll(() => server.count('/echo'), { timeout: 40_000 }).toBe(1)
      expect(server.requestsFor('/echo')[0].cookie).toContain('koloft_store')

      // ⑤ an HTTP-auth credential Chromium then reuses for the origin
      await typeInAddressBar(page, server.url('/auth'))
      await submitBasicAuth(page)
      const authed = await guestByUrl(app, `:${server.port}/auth`)
      await expect(authed.locator('#authed')).toBeVisible({ timeout: 40_000 })
      await typeInAddressBar(page, server.url('/a'))
      await typeInAddressBar(page, server.url('/auth'))
      await expect.poll(() => lastAuthHeader(server), { timeout: 40_000 }).toMatch(/^Basic /)

      // ⑥ a session certificate exception for the self-signed host
      await typeInAddressBar(page, tls.aliasUrl('koloft-a.test', '/a'))
      await clickProceed(app, page)
      await expect.poll(() => tls.count('/a'), { timeout: 60_000 }).toBe(1)
      await typeInAddressBar(page, tls.aliasUrl('koloft-a.test', '/p'))
      await expect.poll(() => tls.count('/p'), { timeout: 60_000 }).toBe(1)
      expect(await proceedCount(app, page)).toBe(0)

      // ⑦ the address bar remembers the pages visited above, by title. `storag` is the
      // fragment because only one of them is titled "Storage" — `page a` is served by both
      // fixture servers, so it would match two rows.
      await typeInAddressBar(page, 'storag', { submit: false })
      await expect(page.locator(BROWSER.suggestRow)).toHaveCount(1, { timeout: 20_000 })
      await page.keyboard.press('Escape')

      // the user clears browsing data
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

      // ⑦ the history is gone: the same fragment offers nothing (checked first, before the
      // navigations below put pages back into it)
      await typeInAddressBar(page, 'storag', { submit: false })
      await expect(page.locator(BROWSER.suggestList)).toHaveCount(0, { timeout: 20_000 })
      await page.keyboard.press('Escape')

      // ① the cookie is gone from the next request
      await typeInAddressBar(page, server.url('/echo'))
      await expect.poll(() => server.count('/echo'), { timeout: 40_000 }).toBe(2)
      expect(server.requestsFor('/echo')[1].cookie).not.toContain('koloft_store')

      // ②-④ no service worker, no cache entry, no database survives on that origin
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

      // ⑤ the saved HTTP-auth credential is gone: the next request goes out unauthenticated
      const authRequestsBefore = server.count('/auth')
      await typeInAddressBar(page, server.url('/auth'))
      await expect
        .poll(() => server.count('/auth'), { timeout: 40_000 })
        .toBeGreaterThan(authRequestsBefore)
      expect(lastAuthHeader(server)).toBe('')

      // ⑥ the certificate exception is gone: the interstitial is back, nothing is fetched
      // (the re-issued auth challenge is dismissed first — its modal is over the address bar)
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

// ---- Non-functional: the whole S1 flow, with no way out ---------------------------------------

// BB-N07 — M1 / TEST-2 / §08 P1 acceptance: the scripted "edit-look-say" round trip — agent open,
// user open, link click, download, self-signed https, upload, http pdf — with the ↗ button
// never touched. The choke point must have recorded nothing at all.
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

      // ① the agent opens a localhost url — a background tab
      await agentOpen(page, server.localhostUrl('/a'))
      await expect(openTabs(page)).toHaveCount(1, { timeout: 40_000 })

      // ② the user opens that tab, and ③ clicks through to the next page
      await openTabs(page).first().click()
      await expect.poll(() => server.count('/a'), { timeout: 40_000 }).toBe(1)
      const first = await guestByUrl(app, `:${server.port}/a`)
      await first.locator('#to-b').click()
      await expect.poll(() => server.count('/b'), { timeout: 40_000 }).toBeGreaterThan(0)

      // ④ a download
      const name = `koloft-e2e-n07-${Date.now()}.txt`
      await typeInAddressBar(
        page,
        server.url(`/link?href=${encodeURIComponent(`/download?name=${name}`)}`)
      )
      const downloader = await guestByUrl(app, '/link')
      await downloader.locator('#link').click()
      await expect.poll(() => downloadedFiles(env), { timeout: 60_000 }).toContain(name)

      // ⑤ a self-signed https host, taken through the interstitial
      await typeInAddressBar(page, tls.aliasUrl('koloft-a.test', '/a'))
      await clickProceed(app, page)
      await expect.poll(() => tls.count('/a'), { timeout: 60_000 }).toBe(1)

      // ⑥ an upload
      await typeInAddressBar(page, server.url('/upload'))
      const uploader = await guestByUrl(app, '/upload')
      await uploader.locator('#file').setInputFiles(path.join(env.workspaces.a, 'README.md'))
      await expect(uploader.locator('#chosen')).toHaveText('README.md', { timeout: 40_000 })

      // ⑦ an http url pointing at a pdf
      await typeInAddressBar(page, server.url('/doc.pdf'))
      await expect
        .poll(async () => (await guestUrls(app)).some((u) => u.endsWith('.pdf')), {
          timeout: 60_000
        })
        .toBe(true)

      // …and nothing in the whole flow was ever forced out of Koloft
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
