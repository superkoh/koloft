import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { snap, startSessionIn, waitBooted, wsRows } from './helpers/p1'

// D7 — a WORKSPACE is a thing you can pick, not just a folder you can fold open.
//
// Clicking a workspace head used to fold its group. Now it picks the workspace: the
// centre shows that workspace's welcome panel, no session row is selected, and the
// sessions that were running keep running behind it. Folding moved onto the folder icon.
//
// The whole point is that "a session is picked" and "nothing is picked" become one rule —
// the current workspace is the selection's workspace — so the workspace's own panel can be
// reached even when nothing is running in it.

/** One workspace's head row in the sidebar. */
const head = (page: Page, wsName: string): Locator => page.locator('.ws-head', { hasText: wsName })

// N11 — the plain case: nothing running at all. The click has to move the panel onto the
// workspace it names, and mark the head as the picked one.
test('N11: clicking a workspace head picks it and the centre shows its welcome panel', async ({
  env
}) => {
  test.setTimeout(120_000)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)

    // with nothing picked the panel lands on the array head (ws-a), so ws-b can only be
    // on screen because the click put it there
    const panel = page.locator('.w-empty')
    await expect(panel.locator('.big')).toHaveText('ws-a', { timeout: 20_000 })
    await expect(head(page, 'ws-b')).not.toHaveClass(/\bactive\b/)

    await head(page, 'ws-b').locator('.ws-name').click()

    await expect(head(page, 'ws-b')).toHaveClass(/\bactive\b/)
    await expect(head(page, 'ws-a')).not.toHaveClass(/\bactive\b/)
    await expect(panel.locator('.big')).toHaveText('ws-b')
    await expect(panel.locator('.quiet').first()).toHaveText('No running session')
    await snap(page, 'N11')
  } finally {
    await app.close().catch(() => {})
  }
})

// N12 — the case the feature exists for: a session IS running, and picking another
// workspace must not disturb it. The `.term-wrap` count is the assertion carrying this
// case: the tab and its pty stay, only the selection moves, so a build that closed or
// unmounted the session on the way out fails here even though every other clause passes.
test('N12: picking another workspace leaves the running session mounted, and going back restores it', async ({
  env
}) => {
  test.setTimeout(240_000)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')

    const rowA = wsRows(page, 'ws-a').first()
    await expect(rowA).toHaveClass(/\bactive\b/)
    const terms = page.locator('.term-wrap')
    await expect(terms).toHaveCount(1)
    await expect(page.locator('.w-empty')).toHaveCount(0)

    // pick ws-b — its welcome panel takes the centre
    await head(page, 'ws-b').locator('.ws-name').click()
    const panel = page.locator('.w-empty')
    await expect(panel.locator('.big')).toHaveText('ws-b')
    await expect(head(page, 'ws-b')).toHaveClass(/\bactive\b/)
    // no row co-highlights with the picked head
    await expect(rowA).not.toHaveClass(/\bactive\b/)
    // …and ws-a's session is still there, running, behind the panel
    await expect(terms).toHaveCount(1)

    // going back to the row hands the selection to the session again
    await rowA.click()
    await expect(rowA).toHaveClass(/\bactive\b/)
    await expect(head(page, 'ws-b')).not.toHaveClass(/\bactive\b/)
    await expect(page.locator('.w-empty')).toHaveCount(0)
    await expect(terms).toHaveCount(1)
    await snap(page, 'N12')
  } finally {
    await app.close().catch(() => {})
  }
})

// N13 — folding kept its home, it just moved onto the folder icon: the icon folds and
// unfolds, and it must NOT also pick the workspace (the click stops at the icon).
test('N13: the folder icon folds the group and never changes the pick', async ({ env }) => {
  test.setTimeout(240_000)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')

    const rowA = wsRows(page, 'ws-a').first()
    await expect(rowA).toHaveClass(/\bactive\b/)
    const group = page
      .locator('.ws')
      .filter({ has: head(page, 'ws-a') })
      .locator('.ws-tabs')
    await expect(group).toHaveCount(1)

    const fico = head(page, 'ws-a').locator('.fico')
    await fico.click()
    await expect(group).toHaveCount(0)
    // the fold changed nothing about what is picked: the session is still selected, so
    // the welcome panel never came up
    await expect(head(page, 'ws-a')).not.toHaveClass(/\bactive\b/)
    await expect(page.locator('.w-empty')).toHaveCount(0)

    await fico.click()
    await expect(group).toHaveCount(1)
    await expect(rowA).toHaveClass(/\bactive\b/)
    await expect(head(page, 'ws-a')).not.toHaveClass(/\bactive\b/)
    await snap(page, 'N13')
  } finally {
    await app.close().catch(() => {})
  }
})
