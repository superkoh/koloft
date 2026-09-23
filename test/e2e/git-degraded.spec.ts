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

/**
 * The three states where the DATA is not what it wants to be
 * (workspace-git-pull design) §04 M4 / §06): the fetch failed, the fetch was
 * never allowed to run, or the fetch has not come back yet. All three share one rule —
 * Koloft never paints unknown as up to date, and it only morphs the primary into a write
 * when the write itself is safe. Since C7 retired, the states that only explain
 * themselves are read in C8 (the one dialog that keeps all six, §04C) and the one that
 * morphs is read in C10 (§11 migration map).
 *
 * Each fixture pre-fetches from OUTSIDE the app, so the numbers on screen are real
 * measurements that are merely old — the only honest way to reach these states.
 */

const BADGE_TIMEOUT = 30_000
/** old enough that every age label the specs read is "<n> min ago", never "just now" */
const STALE_AGE_MS = 40 * 60_000

// Offline: origin is gone AFTER the clone learned it was behind. The number survives,
// the alarm explains it, and the primary refuses to morph — a pull would need an origin
// it cannot reach. The error is the ENGINE's state, so a later local re-measure (which
// knows nothing about the network) must not quietly stamp it 'ok' again.
test('T-GP-06: with origin unreachable the badge keeps its count, the popover alarms, and C8 stays Create', async ({
  env
}) => {
  test.setTimeout(150_000)
  const fx = setupGitFixture(env)
  fx.originAhead(3)
  fx.externalFetch(STALE_AGE_MS)
  fx.deleteOrigin()

  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  try {
    // the count was measured before the outage and is not thrown away (§06 degraded mode)
    const badge = page.locator('.ws-behind')
    await expect(badge).toHaveText('3', { timeout: BADGE_TIMEOUT })
    await expect(badge).not.toHaveClass(/\binfo\b/)

    await badge.click()
    const pop = page.locator('.tbu-pop.fx')
    const alarm = pop.locator('.fx-note .tbu-alarm')
    // the startup sweep's fetch is what fails — waited for here, not slept on
    await expect(alarm).toContainText("can't reach origin — check network or credentials.", {
      timeout: BADGE_TIMEOUT
    })
    await expect(pop.locator('.tbu-pop-head .age')).toHaveText(/^last fetch \d+ min ago$/)
    await expect(pop.locator('.fx-counts')).toContainText('↓ 3 behind')
    await expect(pop.locator('.tbu-act.pull')).toBeDisabled()
    await snap(page, 'T-GP-06-popover')
    await page.keyboard.press('Escape')

    // C8: the same measurement, the same refusal — and the line says which of the two
    // numbers is the stale one
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

    // …and it survives a rescan. The local commit is the probe: `ahead` can only move
    // when a fresh LOCAL measurement runs, so seeing ↑ 1 proves one did — and the alarm
    // still standing next to it proves that measurement did not clear the fetch failure.
    fx.localCommit()
    // the Tier-1 piggyback keeps a 10s floor per workspace, and the dialog's own failed
    // fetch just re-stamped it — clearing the floor is what makes the next rescan
    // actually re-measure instead of skipping
    await page.waitForTimeout(11_000)
    await addWorkspace(page, env.workspaces.a)
    await badge.click()
    await expect(pop.locator('.fx-counts')).toContainText('↑ 1 ahead', { timeout: BADGE_TIMEOUT })
    await expect(alarm).toContainText("can't reach origin")
    await snap(page, 'T-GP-06-rescanned')
  } finally {
    await app.close().catch(() => {})
  }
})

// D8 off with data already on disk: Koloft fetches nothing, but what a previous fetch left
// behind is still a real measurement — so the line shows it WITH its age, and the button
// still morphs (D6④: the pull itself is safe; only the number is old).
test('T-GP-07: with auto-fetch off the C10 line carries its fetch age and still morphs to Pull & Start', async ({
  env
}) => {
  test.setTimeout(120_000)
  const fx = setupGitFixture(env)
  fx.originAhead(3)
  fx.externalFetch(STALE_AGE_MS)
  seedSettings(env, { gitAutoFetch: false })
  const fetchedBefore = fetchedAtMs(fx)
  expect(fetchedBefore).toBeGreaterThan(0)

  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  try {
    // Tier-1 is local-only and never gated by the switch: the badge comes from the
    // tracking ref the external fetch already moved
    await expect(page.locator('.ws-behind')).toHaveText('3', { timeout: BADGE_TIMEOUT })

    const dlg = await openPicker(app, page)
    const line = dlg.locator('.fresh-line.stale')
    await expect(line).toBeVisible({ timeout: 20_000 })
    // the spy is the repo: git rewrites .git/FETCH_HEAD on every fetch, so an unchanged
    // mtime is proof the picker opened without one
    await page.waitForTimeout(3_000)
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

// The check has not come back yet: `checking` never blocks the dialog (D6), so ⏎ acts
// immediately — branching from the CURRENT HEAD, with no pull, exactly as the button
// then reads. C8 is the only surface that can still be `checking` (D14: the ⌘N path
// renders nothing but the pullable state), so this is where the case lives now.
// The remote is an `ext::` helper that answers nothing, so the fetch really does hang.
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
    // a name is what C8 acts on; the still-hanging check neither blocks it nor morphs it
    await page.keyboard.type('inflight')
    await expect(dialogPrimary(dlg)).toContainText('Create worktree')
    await expect(dialogPrimary(dlg)).not.toContainText('Pull &')
    await expect(busy).toContainText('Checking origin…')
    await snap(page, 'T-GP-08-checking')

    await page.keyboard.press('Enter')
    await expect(dlg).toHaveCount(0)
    await expect(wsRows(page, 'repo')).toHaveCount(1, { timeout: 40_000 })
    await expect(page.locator('.ws-tab.st-pending')).toHaveCount(0, { timeout: 60_000 })

    // the checkout never moved, and no pull ever reported one
    expect(headSha(fx)).toBe(before)
    await expect(page.locator('.toast', { hasText: 'fast-forwarded' })).toHaveCount(0)
    await snap(page, 'T-GP-08-started')
  } finally {
    await app.close().catch(() => {})
  }
})
