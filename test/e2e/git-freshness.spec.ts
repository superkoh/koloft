import { test, expect, launchApp } from './helpers/app'
import { setupGitFixture } from './helpers/gitFixture'
import { closeMenu, menuItemTexts, openMenu, snap } from './helpers/p1'

const BADGE_TIMEOUT = 30_000
const PAST_HOVER_INTENT_DELAY_MS = 500

test.describe('Git freshness · sidebar behind badge, popover and fast-forward pull', () => {
  test('T-GF-01: hovering an amber behind count of 3 opens a popover (not the head fly-out) whose pull fast-forwards the workspace', async ({
    env
  }) => {
    const fx = setupGitFixture(env)
    fx.originAhead(3)

    const app = await launchApp(env)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    try {
      const badge = page.locator('.ws-behind')
      await expect(badge).toHaveText('3', { timeout: BADGE_TIMEOUT })
      await expect(badge).not.toHaveClass(/\binfo\b/)
      await snap(page, 'T-GF-01-badge')

      await badge.hover()
      const pop = page.locator('.tbu-pop.fx')
      await expect(pop).toBeVisible()
      await page.waitForTimeout(PAST_HOVER_INTENT_DELAY_MS)
      await expect(page.locator('.menu')).toHaveCount(0)
      await expect(pop.locator('.fx-counts')).toContainText('↓ 3 behind')
      await expect(pop.locator('.fx-note')).toContainText('Working tree clean')
      const pull = pop.locator('.tbu-act.pull')
      await expect(pull).toContainText('Pull · fast-forward')
      await expect(pull).toBeEnabled()
      await snap(page, 'T-GF-01-popover')

      await pop.hover()
      await badge.hover()
      await page.waitForTimeout(200)
      await expect(pop).toBeVisible()
      await page.locator('.ws-head .ws-name').hover()
      await expect(pop).toHaveCount(0)
      await expect(page.locator('.menu')).toBeVisible()
      await closeMenu(page)
      await page.mouse.move(600, 400)
      await expect(pop).toHaveCount(0)
      await page.locator('.ws-git svg').hover()
      await expect(pop).toBeVisible()

      await pull.click()
      await expect(page.locator('.toast')).toHaveText(/^repo · main: fast-forwarded 3 commits/, {
        timeout: 30_000
      })
      await expect(page.locator('.ws-behind')).toHaveCount(0)
      await snap(page, 'T-GF-01-pulled')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-GF-02: a dirty tree keeps the badge but disables Pull with the clean-tree reason', async ({
    env
  }) => {
    const fx = setupGitFixture(env)
    fx.originAhead(2)
    fx.makeDirty()

    const app = await launchApp(env)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    try {
      const badge = page.locator('.ws-behind')
      await expect(badge).toHaveText('2', { timeout: BADGE_TIMEOUT })
      await badge.click()

      const pop = page.locator('.tbu-pop.fx')
      await expect(pop.locator('.fx-note')).toContainText(
        'Koloft only pulls into a clean tree — commit or discard local changes first.'
      )
      await expect(pop.locator('.tbu-act.pull')).toBeDisabled()
      await expect(pop.locator('.tbu-act', { hasText: 'Fetch now' })).toBeEnabled()
      await snap(page, 'T-GF-02')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-GF-03: on a feature branch the badge is grey info and Pull explains the default-branch rule', async ({
    env
  }) => {
    const fx = setupGitFixture(env)
    fx.originAhead(2)
    fx.checkoutFeatureBranch('fix-auth')

    const app = await launchApp(env)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    try {
      const badge = page.locator('.ws-behind')
      await expect(badge).toHaveText('2', { timeout: BADGE_TIMEOUT })
      await expect(badge).toHaveClass(/\binfo\b/)
      await badge.click()

      const pop = page.locator('.tbu-pop.fx')
      await expect(pop.locator('.tbu-pop-head')).toContainText('fix-auth · origin/main')
      await expect(pop.locator('.fx-note')).toContainText(
        'Root is on fix-auth — Koloft only pulls the default branch.'
      )
      await expect(pop.locator('.tbu-act.pull')).toBeDisabled()
      await snap(page, 'T-GF-03')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-GF-04: a git workspace fly-out lists Fetch origin between New session and Remove', async ({
    env
  }) => {
    setupGitFixture(env)

    const app = await launchApp(env)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    try {
      await expect(page.locator('.ws-head')).toHaveCount(1, { timeout: 20_000 })
      await openMenu(page, page.locator('.ws-head', { hasText: 'repo' }))
      expect(await menuItemTexts(page)).toEqual([
        'New session⌘N',
        'New worktree session…⇧⌘N',
        'Restore session…',
        'Fetch origin',
        'Scheduled jobs…',
        'Remove workspace'
      ])
      await snap(page, 'T-GF-04')
      await closeMenu(page)
    } finally {
      await app.close().catch(() => {})
    }
  })
})
