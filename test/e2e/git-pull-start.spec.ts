import { test, expect, launchApp } from './helpers/app'
import { seedSettings } from './helpers/env'
import { hasFetched, setupGitFixture } from './helpers/gitFixture'
import {
  dialogPrimary,
  openMenu,
  openPicker,
  openWorktreeSession,
  snap,
  wsRows
} from './helpers/p1'

const BADGE_TIMEOUT = 30_000
const PAST_STARTUP_SWEEP_MS = 6_000

async function pressPrimary(page: import('@playwright/test').Page): Promise<void> {
  await page.keyboard.press('Enter')
}

test.describe('Git freshness · Pull & Start on the ⌘N picker, and the explain-only states in New worktree session', () => {
  test('T-GP-01: a stale root turns Start into the only exit — Pull & Start, which pulls then launches', async ({
    env
  }) => {
    test.setTimeout(120_000)
    const fx = setupGitFixture(env)
    fx.originAhead(3)

    const app = await launchApp(env)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    try {
      await expect(page.locator('.ws-behind')).toHaveText('3', { timeout: BADGE_TIMEOUT })
      const dlg = await openPicker(app, page)

      const line = dlg.locator('.fresh-line.stale')
      await expect(line).toBeVisible({ timeout: 20_000 })
      await expect(line).toContainText('main is 3 commits behind origin/main')
      await expect(line).toContainText('Pull & Start will fast-forward first.')
      await expect(dialogPrimary(dlg)).toContainText('Pull & Start')
      await expect(dlg.locator('[role="option"][aria-selected="true"] .wsp-name')).toHaveText(
        'repo'
      )

      const buttons = dlg.locator('button')
      await expect(buttons).toHaveCount(2)
      const foot = dlg.locator('.modal-foot button')
      expect((await foot.allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim())).toEqual([
        'Cancel',
        'Pull & Start⏎'
      ])
      await expect(line.locator('button, a, [role="button"], input')).toHaveCount(0)
      await snap(page, 'T-GP-01-dialog')

      await dialogPrimary(dlg).click()
      await expect(page.locator('.toast')).toHaveText(/^repo · main: fast-forwarded 3 commits/, {
        timeout: 30_000
      })
      await expect(page.locator('.ws-behind')).toHaveCount(0)
      const rows = wsRows(page, 'repo')
      await expect(rows).toHaveCount(1, { timeout: 40_000 })
      await expect(page.locator('.ws-tab.st-pending')).toHaveCount(0, { timeout: 60_000 })
      await snap(page, 'T-GP-01-started')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-GP-02: with local changes the C8 button stays Create and the line gives the clean-tree reason', async ({
    env
  }) => {
    const fx = setupGitFixture(env)
    fx.originAhead(2)
    fx.makeDirty()

    const app = await launchApp(env)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    try {
      await expect(page.locator('.ws-behind')).toHaveText('2', { timeout: BADGE_TIMEOUT })
      const dlg = await openWorktreeSession(page, 'repo')

      const line = dlg.locator('.fresh-line.stale')
      await expect(line).toBeVisible({ timeout: 20_000 })
      await expect(line).toContainText('main is 2 commits behind origin/main')
      await expect(line).toContainText(
        'working tree has local changes; Koloft only pulls into a clean tree. Start uses the current HEAD.'
      )
      await expect(dialogPrimary(dlg)).toContainText('Create worktree')
      await expect(dialogPrimary(dlg)).not.toContainText('Pull &')
      await snap(page, 'T-GP-02')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-GP-03: with auto-fetch off C8 fetches nothing, and menu Fetch origin still finds the drift', async ({
    env
  }) => {
    const fx = setupGitFixture(env)
    fx.originAhead(3)
    seedSettings(env, { gitAutoFetch: false })

    const app = await launchApp(env)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    try {
      await expect(page.locator('.ws-head')).toHaveCount(1, { timeout: 20_000 })
      await page.waitForTimeout(PAST_STARTUP_SWEEP_MS)
      await expect(page.locator('.ws-behind')).toHaveCount(0)

      const dlg = await openWorktreeSession(page, 'repo')
      await page.waitForTimeout(3_000)
      // PLATFORM§30
      expect(hasFetched(fx)).toBe(false)
      await expect(dlg.locator('.fresh-line.stale')).toHaveCount(0)
      await expect(dialogPrimary(dlg)).toContainText('Create worktree')
      await expect(dialogPrimary(dlg)).not.toContainText('Pull &')
      await snap(page, 'T-GP-03-no-fetch')

      await page.keyboard.press('Escape')
      await expect(dlg).toHaveCount(0)
      await openMenu(page, page.locator('.ws-head', { hasText: 'repo' }))
      await page.locator('.menu .mi', { hasText: 'Fetch origin' }).click()
      await expect(page.locator('.ws-behind')).toHaveText('3', { timeout: BADGE_TIMEOUT })
      expect(hasFetched(fx)).toBe(true)
      await snap(page, 'T-GP-03-manual-fetch')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-GP-04: an untracked file is not a dirty tree, so a pull git refuses over an untracked collision shows the error, starts nothing, reverts to Start', async ({
    env
  }) => {
    const fx = setupGitFixture(env)
    fx.untrackedCollision()

    const app = await launchApp(env)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    try {
      await expect(page.locator('.ws-behind')).toHaveText('1', { timeout: BADGE_TIMEOUT })
      const dlg = await openPicker(app, page)
      await expect(dialogPrimary(dlg)).toContainText('Pull & Start', { timeout: 20_000 })

      await pressPrimary(page)
      const failed = dlg.locator('.field-hint.bad')
      await expect(failed).toBeVisible({ timeout: 60_000 })
      await expect(failed).toContainText('Pull failed:')
      await expect(failed).toContainText('untracked working tree files would be overwritten')
      await expect(dialogPrimary(dlg)).toContainText('Start')
      await expect(dialogPrimary(dlg)).not.toContainText('Pull &')
      await expect(wsRows(page, 'repo')).toHaveCount(0)
      await expect(dlg).toBeFocused()
      await pressPrimary(page)
      await expect(wsRows(page, 'repo')).toHaveCount(1, { timeout: 40_000 })
      await snap(page, 'T-GP-04')
    } finally {
      await app.close().catch(() => {})
    }
  })
})
