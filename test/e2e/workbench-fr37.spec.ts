import type { Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { clickAppMenuItem, startSessionIn } from './helpers/p1'
import { BROWSER, newWebTab, typeInAddressBar } from './helpers/browser'
import { activeKind, workbenchPanel } from './helpers/workbench'
import { startEchoServer, startHttpsServer } from './helpers/fixtureServer'

/**
 * FR-37 — the two sub-behaviours the merge inherited from the Browser pane that had
 * SUPPORT CODE but no case: the certificate interstitial and the zoom ladder.
 *
 *) sent all of FR-37 to a manual
 * round in its Pending list, but that list predates P1 retargeting the whole browser suite
 * onto the merged panel — permission bar,
 * downloads, mute, page fullscreen and JS dialogs are all automated and green. Auditing
 * what was actually left found exactly these two, and both were reachable with helpers
 * that already existed (`startHttpsServer` mints a self-signed cert and hands back the
 * `--host-resolver-rules` switch; `env.extraArgs` feeds it to the launch). They are here
 * rather than in a human's hands because "nobody wrote it" is not the same reason as
 * "a black box cannot construct it", and only the second one earns a manual round.
 */

/**
 * The guest page's own viewport width in CSS pixels — the oracle for the zoom ladder.
 *
 * NOT `getZoomFactor()`, which was the obvious choice and is unreliable here: measured, it
 * answers 1 until the guest's IPC has been exercised at least once, so a case that reads it
 * first sees "zoom did nothing" for a reason that has nothing to do with zoom. This asks
 * the page instead, which is both stable and the stronger claim — it is the reflow the
 * user actually sees, so a build that recorded a zoom factor without applying it fails.
 *
 * Zooming to `z` divides the viewport's CSS width by `z`, which is why the assertions
 * below are ratios against the un-zoomed baseline rather than absolute numbers.
 */
async function guestWidth(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const el = document.querySelector('.wb-panel webview') as unknown as {
      executeJavaScript?: (s: string) => Promise<number>
    } | null
    return (await el?.executeJavaScript?.('window.innerWidth')) ?? -1
  })
}

// FR-37 / §05D-4 — the certificate interstitial keeps Chrome's shape: a named refusal with
// an explicit unsafe way through, never a silent failure and never a system-browser
// hand-off (G0). The assertion that carries it is the SECOND half: an interstitial that
// appears but whose button does not actually proceed would satisfy every "is it shown"
// check while leaving the page unreachable inside Koloft.
test('FR-37: a self-signed host raises the interstitial, and Proceed really loads the page', async ({
  env
}) => {
  test.setTimeout(180_000)
  const server = await startHttpsServer()
  // the switch is what makes `koloft-a.test` resolve to the fixture; without it Chromium
  // fails DNS first and the case would measure the wrong refusal
  env.extraArgs = [...(env.extraArgs ?? []), server.hostResolverSwitch]
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

    await newWebTab(page)
    await typeInAddressBar(page, server.aliasUrl('koloft-a.test', '/echo'))

    const cert = page.locator(BROWSER.certInterstitial)
    await expect(cert).toBeVisible({ timeout: 30_000 })
    await expect(cert).toContainText('Your connection is not private')
    await expect(cert).toContainText('koloft-a.test')
    // G0: the escape hatch is a choice inside Koloft, never a hand-off — no error page and no
    // external open stands in for it
    await expect(page.locator(BROWSER.errorPage)).toHaveCount(0)

    await cert.locator('button', { hasText: 'Proceed anyway' }).click()
    // the interstitial goes AND the page arrives: either alone is satisfied by a build
    // that merely dismisses the warning
    await expect(cert).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(() => server.requests.length, { timeout: 30_000 }).toBeGreaterThan(0)
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})

// FR-37 — the zoom ladder is a fixed set of steps, not free scaling, and ⌘0 returns to 1.
// Asserted through the guest's own `getZoomFactor` so the case is about the guest's zoom
// rather than about any styling that happens to accompany it.
test('FR-37: the zoom ladder steps and clamps, and reset returns to 1', async ({ app, page }) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await newWebTab(page)
    // a REAL page, not an unreachable address: `setZoomFactor` is a call on an attached
    // guest, so a tab whose navigation never completed reports 1 forever and the case would
    // pass or fail for the fixture's reasons rather than the ladder's
    await typeInAddressBar(page, server.page('/zoom', '<h1>zoom</h1>'))
    // the barrier that the fixture reached the state the case is ABOUT: the zoom
    // accelerators route to the guest only while the active tab is a `web` one
    // (`commandTarget`'s `browserActive`), so a case that zoomed with `files` on top would
    // be measuring the window's zoom fallback and reading the guest's.
    await expect.poll(() => activeKind(page), { timeout: 30_000 }).toBe('web')
    await expect.poll(() => server.count('/zoom'), { timeout: 30_000 }).toBeGreaterThan(0)
    const base = await guestWidth(page)
    expect(base).toBeGreaterThan(100)

    // the kit's helper, not a hand-rolled click: it waits for the renderer's shortcut
    // listeners to be subscribed and THROWS on a missing id, where a raw `getMenuItemById`
    // click fails silently and reads as "the feature does nothing"
    const menu = (id: string): Promise<void> => clickAppMenuItem(app, page, id)
    /** the width the page should report at zoom `z`, ±1 for integer rounding */
    const atZoom = async (z: number): Promise<void> => {
      await expect
        .poll(() => guestWidth(page), { timeout: 20_000 })
        .toBeGreaterThan(Math.round(base / z) - 2)
      expect(await guestWidth(page)).toBeLessThan(Math.round(base / z) + 2)
    }

    await menu('browser-zoom-in')
    await atZoom(1.1)
    await menu('browser-zoom-in')
    await atZoom(1.25)
    await menu('browser-zoom-out')
    await atZoom(1.1)

    // the ladder has ENDS — it is a fixed set of steps, not free scaling, so pressing past
    // the bottom stops at 0.5 rather than running away
    for (let i = 0; i < 12; i++) await menu('browser-zoom-out')
    await atZoom(0.5)

    await menu('browser-zoom-reset')
    await atZoom(1)
  } finally {
    await server.close()
  }
})
