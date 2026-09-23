import { test, expect, launchApp } from './helpers/app'
import { setupGitFixture } from './helpers/gitFixture'
import { closeMenu, menuItemTexts, openMenu, snap } from './helpers/p1'

/**
 * The sidebar half of workspace git freshness (workspace-git-pull design)
 * §02/§03, slice P1-b): the badge is the feature's only resident pixel, the popover is
 * its detail card, and a fast-forward pull is the single write Koloft's one hand performs.
 *
 * Only the `env` fixture is used: the repo state a case measures has to exist BEFORE
 * the app boots — main reads layout.json once, and the engine's startup sweep is what
 * turns that state into a badge. Every remote is a local `file://` bare repo (§08), so
 * nothing here reaches the network.
 */

// Startup sweep (3s) + fetch + the rows push that carries the result.
const BADGE_TIMEOUT = 30_000

// origin 3 ahead → the amber badge appears, its popover offers the pull, and the pull
// leaves the workspace level with origin: badge gone, one toast naming the repo.
test('T-GF-01: an amber behind count of 3 opens a popover whose pull fast-forwards the workspace', async ({
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
    // amber = Koloft can fix it; the grey info variant carries `.info` on top (D5)
    await expect(badge).not.toHaveClass(/\binfo\b/)
    await snap(page, 'T-GF-01-badge')

    // hovering the count is the door — no click — and the head's hover-intent fly-out
    // (350 ms) must not come up behind it while the pointer sits on the badge
    await badge.hover()
    const pop = page.locator('.tbu-pop.fx')
    await expect(pop).toBeVisible()
    await page.waitForTimeout(500)
    await expect(page.locator('.menu')).toHaveCount(0)
    await expect(pop.locator('.fx-counts')).toContainText('↓ 3 behind')
    await expect(pop.locator('.fx-note')).toContainText('Working tree clean')
    const pull = pop.locator('.tbu-act.pull')
    await expect(pull).toContainText('Pull · fast-forward')
    await expect(pull).toBeEnabled()
    await snap(page, 'T-GF-01-popover')

    // badge → card → badge keeps it up; leaving badge and card takes it down again,
    // like the fly-out
    await pop.hover()
    await badge.hover()
    await page.waitForTimeout(200)
    await expect(pop).toBeVisible()
    // sweeping off the badge onto the head's own name gives the head back its
    // fly-out: the card goes, the hover-intent menu still comes
    await page.locator('.ws-head .ws-name').hover()
    await expect(pop).toHaveCount(0)
    await expect(page.locator('.menu')).toBeVisible()
    await closeMenu(page)
    await page.mouse.move(600, 400)
    await expect(pop).toHaveCount(0)
    // the git icon is part of the door too, not just the count
    await page.locator('.ws-git svg').hover()
    await expect(pop).toBeVisible()

    await pull.click()
    // the toast is the pull's own summary — its count comes from the two real
    // endpoints, and it is prefixed with the workspace name (one global slot)
    await expect(page.locator('.toast')).toHaveText(/^repo · main: fast-forwarded 3 commits/, {
      timeout: 30_000
    })
    await expect(page.locator('.ws-behind')).toHaveCount(0)
    await snap(page, 'T-GF-01-pulled')
  } finally {
    await app.close().catch(() => {})
  }
})

// A dirty tree is information, not a hidden badge: the workspace still shows how far
// behind it is, and the popover explains the one reason the pull is unavailable.
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
    // the manual fetch is never gated on pull eligibility
    await expect(pop.locator('.tbu-act', { hasText: 'Fetch now' })).toBeEnabled()
    await snap(page, 'T-GF-02')
  } finally {
    await app.close().catch(() => {})
  }
})

// Root parked on a feature branch: the same measurement, but Koloft can only explain it —
// the badge drops to the grey info variant and the pull says why (D5).
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

// The resident manual entry (D9): a git workspace's fly-out carries Fetch origin
// whether or not a badge is showing — it is what survives auto-fetch being off.
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
