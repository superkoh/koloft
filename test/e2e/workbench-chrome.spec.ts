import { test, expect } from './helpers/app'
import type { Page } from '@playwright/test'
import { startEchoServer, type FixtureServer } from './helpers/fixtureServer'
import fs from 'fs'
import path from 'path'
import {
  centerTerm,
  clickAppMenuItem,
  focusOwner,
  runIn,
  sendShortcut,
  startSessionIn
} from './helpers/p1'
import { answerFileDialog, wbActiveTab, wbTabs, workbenchPanel } from './helpers/workbench'

/**
 * Workbench · the web tab's chrome and the panel's shortcuts (the WB-W and
 * WB-K03…K06 cases).
 *
 * Two things are under test that only exist because of the merge. First, the kind bar:
 * the address-bar row is no longer THE surface's chrome but one KIND's, so it has to
 * appear and disappear as the active tab changes, and ⌘L has to follow it (FR-36).
 * Second, the shortcut arbitration: after the merge a focused GUEST is an ordinary place
 * for the focus to be, so ⌘W / ⌘F / ⌘⌥←→ must be fished back out of the page (FR-53) —
 * without ever stealing Esc from the TUI (FR-54).
 */

let server: FixtureServer

test.beforeAll(async () => {
  server = await startEchoServer()
})

test.afterAll(async () => {
  await server?.close()
})

/** The panel arbitrates ⌘W/⌘T/⌘F by focus (FR-20), so a case that means "the panel has
 *  it" has to actually put the focus there first. */
async function focusPanel(page: Page): Promise<void> {
  await workbenchPanel(page).click({ position: { x: 5, y: 5 } })
}

/** An AGENT open — fake-claude spawns the shim from inside the session's own pty, which
 *  is what makes main read it as agent-source (FR-13). */
async function agentOpen(page: Page, target: string): Promise<void> {
  await runIn(page, centerTerm(page), `/open ${target}`)
}

/**
 * Open one `file` tab through the product's own door: ⌘T on the pinned tab raises the ＋
 * dropdown, whose "Open file…" runs `preview.openFileDialog` — answered by the harness's
 * queue rather than a native panel (FR-52).
 *
 * The Esc cases below need a `file` tab specifically, and the cases file says so. On a
 * `web` tab the focus lands INSIDE the guest, and Esc is deliberately not on FR-53's
 * forward whitelist — a page keeps its own Esc — so the ladder would never see the key.
 * That is the design, not a gap, which is why the ladder is exercised where the panel
 * itself holds the focus.
 */
async function openFileTab(page: Page, absPath: string): Promise<void> {
  await workbenchPanel(page).click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Meta+t')
  await page.locator('.wb-newmenu .mi', { hasText: 'Open file…' }).click()
  await expect(wbActiveTab(page)).toHaveText(new RegExp(path.basename(absPath).replace('.', '\\.')))
}

// WB-W05 (NFR-04, FR-13, FR-28) — the security case, and the reason an agent tab stores
// "url + title only". Before the user opens it the target host must see ZERO requests, and
// the tab's icon must never be a favicon fetch: the chrome renders in Koloft's own privileged
// renderer, so a favicon there is that session fetching from the site.
test('WB-W05: an agent tab makes no request until opened, and never fetches a favicon', async ({
  page
}) => {
  test.setTimeout(180_000)
  await startSessionIn(page, 'ws-a')
  const url = server.page('/agent-target', '<!doctype html><title>Agent target</title><p>hi')
  server.reset()

  await agentOpen(page, url)
  // the positive barrier: wait until the tab really exists before concluding "0 requests"
  await expect(wbTabs(page)).toHaveCount(2)

  // …and hold it there. A load that is merely LATE would still be a load.
  await page.waitForTimeout(10_000)
  expect(server.count()).toBe(0)
  expect(server.faviconHits).toHaveLength(0)

  await wbTabs(page).nth(1).click()
  await expect.poll(() => server.count('/agent-target'), { timeout: 25_000 }).toBeGreaterThan(0)
  // the icon is Koloft's own glyph throughout — an <img> in the strip would be a site fetch
  expect(server.faviconHits).toHaveLength(0)
  await expect(wbTabs(page).nth(1).locator('img')).toHaveCount(0)
})

// WB-W01 (FR-36) — the kind bar IS the address-bar row, and it belongs to the `web` kind
// alone. The controls' presence is the assertion; their behavior is FR-37's "unchanged"
// and stays covered by the browser suite.
test('WB-W01: the web kind bar carries the address row, and only for a web tab', async ({
  page
}) => {
  test.setTimeout(180_000)
  await startSessionIn(page, 'ws-a')
  const url = server.page('/w01', '<!doctype html><title>W01</title><p>page')

  // on the pinned files tab there is no address bar at all — the row belongs to the KIND
  // now, not to the surface. (It is `BrowserAddressBar`'s own `.baddr`, reused verbatim:
  // FR-37 says the merge changes none of its behavior, and reusing it is how that holds.)
  await expect(page.locator('.baddr')).toHaveCount(0)

  await agentOpen(page, url)
  await wbTabs(page).nth(1).click()

  await expect(page.locator('.wb-panel')).toHaveAttribute('data-kind', 'web')
  await expect(page.locator('.baddr .url')).toHaveCount(1)
  await expect(page.locator('.baddr .bnav[aria-label="Back"]')).toHaveCount(1)
  await expect(page.locator('.baddr .bnav[aria-label="Forward"]')).toHaveCount(1)
  await expect(page.locator('.baddr .bnav[aria-label="More"]')).toHaveCount(1)

  // switching back to files takes the whole row away again — it is a KIND's bar now
  await wbTabs(page).nth(0).click()
  await expect(page.locator('.wb-panel')).toHaveAttribute('data-kind', 'files')
  await expect(page.locator('.baddr .url')).toHaveCount(0)
})

// WB-W02 (FR-36) — ⌘L applies only while the active tab is `web`; anywhere else it is a
// no-op rather than "focus whatever text field is nearest".
test('WB-W02: ⌘L focuses the address bar on a web tab and does nothing elsewhere', async ({
  app,
  page
}) => {
  test.setTimeout(180_000)
  await startSessionIn(page, 'ws-a')
  const url = server.page('/w02', '<!doctype html><title>W02</title><p>page')
  await agentOpen(page, url)
  await wbTabs(page).nth(1).click()
  await expect(page.locator('.baddr .url')).toHaveCount(1)

  await focusPanel(page)
  await clickAppMenuItem(app, page, 'browser-focus-address')
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.className ?? ''))
    .toContain('url')

  // on the files tab the same key reaches nothing at all
  await wbTabs(page).nth(0).click()
  await focusPanel(page)
  await clickAppMenuItem(app, page, 'browser-focus-address')
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.className ?? ''))
    .not.toContain('url')
})

// WB-K03 (FR-53) — ⌘⌥←/→ cycle in strip order and WRAP. The pinned files tab is part of
// the cycle (it is a tab to switch TO like any other), and with the focus outside the
// panel the keys do nothing.
test('WB-K03: ⌘⌥←/→ cycle the strip, wrapping, and only while the panel is focused', async ({
  page
}) => {
  test.setTimeout(180_000)
  await startSessionIn(page, 'ws-a')
  await agentOpen(page, server.page('/k03a', '<!doctype html><title>K03A</title>'))
  await agentOpen(page, server.page('/k03b', '<!doctype html><title>K03B</title>'))
  await expect(wbTabs(page)).toHaveCount(3)

  await wbTabs(page).nth(0).click() // start on files
  await focusPanel(page)

  // the label is matched case-INSENSITIVELY on purpose: FR-27 says a `web` tab takes the
  // PAGE's title once it loads, so activating a tab flips its label from the derived
  // `host/last-segment` form (`…/k03a`) to the document's own `<title>` (`K03A`)
  await page.keyboard.press('Meta+Alt+ArrowRight')
  await expect(wbActiveTab(page)).toHaveText(/k03a/i)
  await page.keyboard.press('Meta+Alt+ArrowRight')
  await expect(wbActiveTab(page)).toHaveText(/k03b/i)
  // …and once more wraps back to the pinned tab rather than stopping at the end
  await page.keyboard.press('Meta+Alt+ArrowRight')
  await expect(wbActiveTab(page)).toHaveClass(/pinned/)
  // backwards wraps the other way
  await page.keyboard.press('Meta+Alt+ArrowLeft')
  await expect(wbActiveTab(page)).toHaveText(/k03b/i)

  // with the focus in the TUI the keys are nobody's (FR-20's blanket)
  await centerTerm(page).click()
  await page.keyboard.press('Meta+Alt+ArrowRight')
  await expect(wbActiveTab(page)).toHaveText(/k03b/i)
})

// WB-K05b (FR-54, FR-35) — the Esc ladder, consumed by the first match: the find bar goes
// first, and only then does T3 step down to T2. Esc NEVER collapses to T1 and never closes
// a tab, which is what the third press pins.
test('WB-K05b: Esc closes the find bar first, then steps T3 down to T2, and stops', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await startSessionIn(page, 'ws-a')
  const doc = path.join(env.workspaces.a, 'k05b.md')
  fs.writeFileSync(doc, '# K05B\n\nfind me\n')
  answerFileDialog(env, doc)
  await openFileTab(page, doc)
  const tabsBefore = await wbTabs(page).count()

  await clickAppMenuItem(app, page, 'toggle-focus-mode') // T3
  await expect(page.locator('.wb-panel')).toHaveClass(/full/)
  await focusPanel(page)
  await sendShortcut(app, 'shortcut:find')
  await expect(page.locator('.wb-panel .find-bar')).toHaveCount(1)

  // first Esc: the find bar only — still T3
  await page.keyboard.press('Escape')
  await expect(page.locator('.wb-panel .find-bar')).toHaveCount(0)
  await expect(page.locator('.wb-panel')).toHaveClass(/full/)

  // second Esc: T3 → T2
  await page.keyboard.press('Escape')
  await expect(page.locator('.wb-panel')).not.toHaveClass(/full/)
  await expect(workbenchPanel(page)).toBeVisible()

  // third Esc: the caret goes home to the conversation, and NOTHING else moves. Never T1,
  // never a closed tab. R17 added that last rung — the ladder used to bottom out here
  // doing nothing at all, which left the caret stranded in a panel the user was finished
  // with. The panel staying open is the half that keeps the rung honest: "Esc never
  // collapses the panel" is the older rule and R17 does not touch it.
  await page.keyboard.press('Escape')
  await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('tui')
  await expect(workbenchPanel(page)).toBeVisible()
  await expect(wbTabs(page)).toHaveCount(tabsBefore)
})

// WB-K06 (FR-54) — the other half of the ladder, and the one that would be silently
// destructive to get wrong: with the focus in the TUI, Esc is Claude's interrupt. The
// panel's own find bar staying open is the proof that the ladder did not run.
test('WB-K06: Esc in the TUI reaches Claude and leaves the panel’s find bar open', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await startSessionIn(page, 'ws-a')
  const doc = path.join(env.workspaces.a, 'k06.md')
  fs.writeFileSync(doc, '# K06\n\nfind me\n')
  answerFileDialog(env, doc)
  await openFileTab(page, doc)

  await focusPanel(page)
  await sendShortcut(app, 'shortcut:find')
  await expect(page.locator('.wb-panel .find-bar')).toHaveCount(1)

  // hand the focus to the TUI and press Esc there
  await centerTerm(page).click()
  await page.keyboard.press('Escape')

  // the panel's find bar is untouched — the ladder never ran, so Esc was the TUI's
  await expect(page.locator('.wb-panel .find-bar')).toHaveCount(1)
  await expect(page.locator('.wb-panel')).not.toHaveClass(/full/)
})
