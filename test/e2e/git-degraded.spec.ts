import { test, expect, launchApp } from './helpers/app'
import { seedSettings } from './helpers/env'
import { fetchedAtMs, headSha, setupGitFixture } from './helpers/gitFixture'
import {
  addWorkspace,
  dialogPrimary,
  openPicker,
  openWorktreeSession,
  snap,
  wsRows
} from './helpers/p1'

const BADGE_TIMEOUT = 30_000
const PAST_PER_WORKSPACE_REMEASURE_FLOOR_MS = 11_000
const AGE_SHOWN_AS_MINUTES_AGO_MS = 40 * 60_000

test.describe('Git freshness · degraded data (fetch failed, auto-fetch off, fetch in flight) is never painted as up to date', () => {
  test('T-GP-06: with origin unreachable the badge keeps its count, the popover alarms, C8 stays Create, and a later local re-measure keeps the alarm', async ({
    env
  }) => {
    test.setTimeout(150_000)
    const fx = setupGitFixture(env)
    fx.originAhead(3)
    fx.externalFetch(AGE_SHOWN_AS_MINUTES_AGO_MS)
    fx.deleteOrigin()

    const app = await launchApp(env)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    try {
      const badge = page.locator('.ws-behind')
      await expect(badge).toHaveText('3', { timeout: BADGE_TIMEOUT })
      await expect(badge).not.toHaveClass(/\binfo\b/)

      await badge.click()
      const pop = page.locator('.tbu-pop.fx')
      const alarm = pop.locator('.fx-note .tbu-alarm')
      await expect(alarm).toContainText("can't reach origin — check network or credentials.", {
        timeout: BADGE_TIMEOUT
      })
      await expect(pop.locator('.tbu-pop-head .age')).toHaveText(/^last fetch \d+ min ago$/)
      await expect(pop.locator('.fx-counts')).toContainText('↓ 3 behind')
      await expect(pop.locator('.tbu-act.pull')).toBeDisabled()
      await snap(page, 'T-GP-06-popover')
      await page.keyboard.press('Escape')

      const dlg = await openWorktreeSession(page, 'repo')
      const line = dlg.locator('.fresh-line.stale')
      await expect(line).toBeVisible({ timeout: 20_000 })
      await expect(line).toContainText('main is 3 commits behind origin/main')
      await expect(line).toContainText(/\(last fetch \d+ min ago\)/)
      await expect(line).toContainText("can't reach origin. Start uses the current HEAD.")
      await expect(dialogPrimary(dlg)).toContainText('Create worktree')
      await expect(dialogPrimary(dlg)).not.toContainText('Pull &')
      await snap(page, 'T-GP-06-dialog')
      await page.keyboard.press('Escape')
      await expect(dlg).toHaveCount(0)

      fx.localCommit()
      await page.waitForTimeout(PAST_PER_WORKSPACE_REMEASURE_FLOOR_MS)
      await addWorkspace(page, env.workspaces.a)
      await badge.click()
      await expect(pop.locator('.fx-counts')).toContainText('↑ 1 ahead', { timeout: BADGE_TIMEOUT })
      await expect(alarm).toContainText("can't reach origin")
      await snap(page, 'T-GP-06-rescanned')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-GP-07: with auto-fetch off the C10 line carries its fetch age and still morphs to Pull & Start', async ({
    env
  }) => {
    test.setTimeout(120_000)
    const fx = setupGitFixture(env)
    fx.originAhead(3)
    fx.externalFetch(AGE_SHOWN_AS_MINUTES_AGO_MS)
    seedSettings(env, { gitAutoFetch: false })
    const fetchedBefore = fetchedAtMs(fx)
    expect(fetchedBefore).toBeGreaterThan(0)

    const app = await launchApp(env)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    try {
      await expect(page.locator('.ws-behind')).toHaveText('3', { timeout: BADGE_TIMEOUT })

      const dlg = await openPicker(app, page)
      const line = dlg.locator('.fresh-line.stale')
      await expect(line).toBeVisible({ timeout: 20_000 })
      await page.waitForTimeout(3_000)
      // PLATFORM§30
      expect(fetchedAtMs(fx)).toBe(fetchedBefore)

      await expect(line).toContainText('main is 3 commits behind origin/main')
      await expect(line).toContainText(/\(fetched \d+ min ago\)/)
      await expect(line).toContainText('Pull & Start will fast-forward first.')
      await expect(dialogPrimary(dlg)).toContainText('Pull & Start')
      await snap(page, 'T-GP-07')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-GP-08: ⏎ while the check is still in flight creates on the old base and pulls nothing', async ({
    env
  }) => {
    test.setTimeout(120_000)
    const fx = setupGitFixture(env)
    fx.originAhead(3)
    fx.externalFetch()
    fx.hangOrigin()
    const before = headSha(fx)

    const app = await launchApp(env)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    try {
      await expect(page.locator('.ws-head')).toHaveCount(1, { timeout: 20_000 })
      const dlg = await openWorktreeSession(page, 'repo')

      const busy = dlg.locator('.fresh-line.busy')
      await expect(busy).toContainText('Checking origin…')
      await page.keyboard.type('inflight')
      await expect(dialogPrimary(dlg)).toContainText('Create worktree')
      await expect(dialogPrimary(dlg)).not.toContainText('Pull &')
      await expect(busy).toContainText('Checking origin…')
      await snap(page, 'T-GP-08-checking')

      await page.keyboard.press('Enter')
      await expect(dlg).toHaveCount(0)
      await expect(wsRows(page, 'repo')).toHaveCount(1, { timeout: 40_000 })
      await expect(page.locator('.ws-tab.st-pending')).toHaveCount(0, { timeout: 60_000 })

      expect(headSha(fx)).toBe(before)
      await expect(page.locator('.toast', { hasText: 'fast-forwarded' })).toHaveCount(0)
      await snap(page, 'T-GP-08-started')
    } finally {
      await app.close().catch(() => {})
    }
  })
})
