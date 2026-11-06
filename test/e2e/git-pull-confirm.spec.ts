import { test, expect, launchApp } from './helpers/app'
import { installCodex } from './helpers/env'
import { setupGitFixture } from './helpers/gitFixture'
import {
  centerTerm,
  dialogPrimary,
  fetchNowInGitPanel,
  openPicker,
  runIn,
  snap,
  startSessionIn,
  wsRows
} from './helpers/p1'

test.describe('Git freshness · Pull & Start confirms only over a root session mid-task (a reminder, not a veto)', () => {
  test('T-GP-05: a root session working on a task makes Pull & Start confirm once — Cancel restores the picker, Pull anyway pulls and launches', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const fx = setupGitFixture(env)

    const app = await launchApp(env)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    try {
      await expect(page.locator('.ws-head')).toHaveCount(1, { timeout: 20_000 })
      await startSessionIn(page, 'repo')
      const rows = wsRows(page, 'repo')
      await expect(rows).toHaveCount(1)

      fx.originAhead(3)
      await fetchNowInGitPanel(page, 'repo')
      await expect(page.locator('.ws-behind')).toHaveText('3', { timeout: 30_000 })
      await expect(page.locator('.ws .ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })
      await runIn(page, centerTerm(page), '/busy')
      await expect(page.locator('.ws .ws-tab.st-working')).toBeVisible({ timeout: 20_000 })

      const dlg = await openPicker(app, page)
      await expect(dialogPrimary(dlg)).toContainText('Pull & Start', { timeout: 30_000 })
      const hot = dlg.locator('[role="option"][aria-selected="true"] .wsp-name')
      await expect(hot).toHaveText('repo')

      await dialogPrimary(dlg).click()
      const confirm = page.locator('.modal:not(.wspicker)')
      await expect(confirm).toBeVisible()
      await expect(confirm.locator('.modal-header')).toContainText('Pull into main?')
      await expect(confirm.locator('.field-hint')).toContainText(
        '1 Koloft session is working on a task in this checkout'
      )
      await expect(confirm.locator('.field-hint')).toContainText(
        'Worktree sessions are not affected.'
      )
      expect(
        (await confirm.locator('.modal-foot button').allTextContents()).map((t) => t.trim())
      ).toEqual(['Cancel', 'Pull anyway'])
      await snap(page, 'T-GP-05-confirm')

      await confirm.locator('button', { hasText: 'Cancel' }).click()
      await expect(confirm).toHaveCount(0)
      await expect(dlg).toBeVisible()
      await expect(dialogPrimary(dlg)).toContainText('Pull & Start')
      await expect(hot).toHaveText('repo')
      await expect(page.locator('.ws-behind')).toHaveText('3')
      await expect(rows).toHaveCount(1)
      await expect(dlg).toBeFocused()
      await snap(page, 'T-GP-05-cancelled')

      await expect(page.locator('.ws .ws-tab.cold')).toHaveCount(0)
      await dialogPrimary(dlg).click()
      await expect(confirm).toBeVisible()
      await expect(confirm.locator('button', { hasText: 'Pull anyway' })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.locator('.toast')).toHaveText(/^repo · main: fast-forwarded 3 commits/, {
        timeout: 30_000
      })
      await expect(page.locator('.ws-behind')).toHaveCount(0)
      await expect(rows).toHaveCount(2, { timeout: 40_000 })
      await expect(page.locator('.ws .ws-tab.st-pending')).toHaveCount(0, { timeout: 60_000 })
      await snap(page, 'T-GP-05-pulled')
    } finally {
      await app.close().catch(() => {})
    }
  })

  for (const method of ['Claude', 'Codex'] as const)
    test(`T-GP-09 (${method}): a root ${method} session waiting at its prompt does not make Pull & Start ask — it pulls and launches straight away`, async ({
      env
    }) => {
      test.setTimeout(180_000)
      const fx = setupGitFixture(env)
      if (method === 'Codex') installCodex(env)

      const app = await launchApp(env)
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      try {
        await expect(page.locator('.ws-head')).toHaveCount(1, { timeout: 20_000 })
        await startSessionIn(page, 'repo', method === 'Codex' ? { method } : {})
        const rows = wsRows(page, 'repo')
        await expect(rows).toHaveCount(1)
        await expect(page.locator('.ws .ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })

        fx.originAhead(3)
        await fetchNowInGitPanel(page, 'repo')
        await expect(page.locator('.ws-behind')).toHaveText('3', { timeout: 30_000 })

        const dlg = await openPicker(app, page)
        await expect(dialogPrimary(dlg)).toContainText('Pull & Start', { timeout: 30_000 })
        await dialogPrimary(dlg).click()
        await expect(page.locator('.toast')).toHaveText(/^repo · main: fast-forwarded 3 commits/, {
          timeout: 30_000
        })
        await expect(page.locator('.modal-header', { hasText: 'Pull into main?' })).toHaveCount(0)
        await expect(page.locator('.ws-behind')).toHaveCount(0)
        await expect(rows).toHaveCount(2, { timeout: 40_000 })
      } finally {
        await app.close().catch(() => {})
      }
    })
})
