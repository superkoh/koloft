import { test, expect, launchApp } from './helpers/app'
import { setupGitFixture } from './helpers/gitFixture'
import { dialogPrimary, openMenu, openPicker, snap, startSessionIn, wsRows } from './helpers/p1'

/**
 * The M3 running-session guard on the C10 path (workspace-git-pull design) §03
 * M3 / D4, re-hosted by new-session-entrances design) §11): Pull & Start rewrites
 * files under whatever agents are already working in the root checkout, so the same
 * confirm the sidebar popover uses stacks on top of the picker — a reminder, not a veto,
 * and its Cancel puts the picker back exactly as it was rather than leaving a half-armed
 * one behind.
 *
 * The order is the case: a session must be RUNNING before origin moves. Discovering the
 * drift is its own step now — no dialog fetches on the ⌘N path any more, so the fly-out's
 * Fetch origin is what stands between the two phases (§11 migration map).
 */

test('T-GP-05: a running root session makes Pull & Start confirm once — Cancel restores the picker, Pull anyway pulls and launches', async ({
  env
}) => {
  test.setTimeout(180_000)
  const fx = setupGitFixture(env)

  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  try {
    await expect(page.locator('.ws-head')).toHaveCount(1, { timeout: 20_000 })
    // the session the guard is about: started in the root checkout, still alive
    await startSessionIn(page, 'repo')
    const rows = wsRows(page, 'repo')
    await expect(rows).toHaveCount(1)

    // only NOW does origin move, and a manual fetch is what discovers it
    fx.originAhead(3)
    await openMenu(page, page.locator('.ws-head', { hasText: 'repo' }))
    await page.locator('.menu .mi', { hasText: 'Fetch origin' }).click()
    await expect(page.locator('.ws-behind')).toHaveText('3', { timeout: 30_000 })

    const dlg = await openPicker(app, page)
    await expect(dialogPrimary(dlg)).toContainText('Pull & Start', { timeout: 30_000 })
    // what the primary resolves to, read where C10 states it: the selected row
    const hot = dlg.locator('[role="option"][aria-selected="true"] .wsp-name')
    await expect(hot).toHaveText('repo')

    // ONE click: it opens the confirm, and nothing has been pulled or launched yet
    await dialogPrimary(dlg).click()
    const confirm = page.locator('.modal:not(.wspicker)')
    await expect(confirm).toBeVisible()
    await expect(confirm.locator('.modal-header')).toContainText('Pull into main?')
    // the count only, singular, and never a list of which sessions (D4)
    await expect(confirm.locator('.field-hint')).toContainText(
      '1 Koloft session is running in this checkout'
    )
    await expect(confirm.locator('.field-hint')).toContainText(
      'Worktree sessions are not affected.'
    )
    expect(
      (await confirm.locator('.modal-foot button').allTextContents()).map((t) => t.trim())
    ).toEqual(['Cancel', 'Pull anyway'])
    await snap(page, 'T-GP-05-confirm')

    // Cancel = back to the dialog as it was: the confirm goes, the picker stays armed and unchanged,
    // and no pull happened behind it
    await confirm.locator('button', { hasText: 'Cancel' }).click()
    await expect(confirm).toHaveCount(0)
    await expect(dlg).toBeVisible()
    await expect(dialogPrimary(dlg)).toContainText('Pull & Start')
    await expect(hot).toHaveText('repo')
    await expect(page.locator('.ws-behind')).toHaveText('3')
    await expect(rows).toHaveCount(1)
    // the keyboard comes back to the picker — the confirm's primary had taken it, and
    // a dialog you can only drive with the mouse is not "exactly as it was"
    await expect(dlg).toBeFocused()
    await snap(page, 'T-GP-05-cancelled')

    // second time through, all the way: one confirm, then the pull and the launch.
    // The confirm is accepted with the KEYBOARD: its primary takes focus on open, so
    // ⏎ carries the whole flow (the picker's own ⏎ refuses while it is stacked).
    await expect(page.locator('.ws-tab.cold')).toHaveCount(0)
    await dialogPrimary(dlg).click()
    await expect(confirm).toBeVisible()
    await expect(confirm.locator('button', { hasText: 'Pull anyway' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('.toast')).toHaveText(/^repo · main: fast-forwarded 3 commits/, {
      timeout: 30_000
    })
    await expect(page.locator('.ws-behind')).toHaveCount(0)
    await expect(rows).toHaveCount(2, { timeout: 40_000 })
    await expect(page.locator('.ws-tab.st-pending')).toHaveCount(0, { timeout: 60_000 })
    await snap(page, 'T-GP-05-pulled')
  } finally {
    await app.close().catch(() => {})
  }
})
