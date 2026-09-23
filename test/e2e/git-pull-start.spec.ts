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

/**
 * Workspace git freshness on the two surviving creation surfaces
 * (workspace-git-pull design) §04, as re-hosted by
 * new-session-entrances design) §11): when the root checkout is behind but safely
 * fast-forwardable, C10 refuses to launch on the old base and its primary IS the fix —
 * Pull & Start, with no way past it (D6a). Every OTHER freshness state renders nothing
 * on the ⌘N path (D14), so the states that merely explain themselves are asserted where
 * the whole M4 apparatus survives: C8's create state.
 *
 * Only the `env` fixture is used: the repo state each case measures must exist before
 * the app boots. All remotes are local `file://` bare repos (§08).
 */

const BADGE_TIMEOUT = 30_000

/**
 * Fire the primary action through the ⏎ the button itself advertises (§04: "⏎ means the same") —
 * the keyboard half of the same submit the pointer reaches by clicking the button once.
 * T-GP-01 covers the pointer half; this case keeps the ⏎ path honest.
 */
async function pressPrimary(page: import('@playwright/test').Page): Promise<void> {
  await page.keyboard.press('Enter')
}

// The whole point of the slice: a stale root turns Start into Pull & Start, that is the
// ONLY way out of the picker other than leaving it, and one click both fast-forwards
// and launches. The gate is why ⌘N does not skip the picker here (§03A) even though the
// one pinned workspace would otherwise launch with no dialog at all.
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
    // the row the morph speaks for is the one the keyboard is on
    await expect(dlg.locator('[role="option"][aria-selected="true"] .wsp-name')).toHaveText('repo')

    // D6a — no escape hatch: the dialog offers Cancel and the primary and nothing
    // else, and the freshness line is text, not a way to start on the old base.
    const buttons = dlg.locator('button')
    await expect(buttons).toHaveCount(2)
    const foot = dlg.locator('.modal-foot button')
    expect((await foot.allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim())).toEqual([
      'Cancel',
      'Pull & Start⏎'
    ])
    await expect(line.locator('button, a, [role="button"], input')).toHaveCount(0)
    await snap(page, 'T-GP-01-dialog')

    // ONE real click: the footer declines the mousedown so nothing lifts between press
    // and release, and the first click is the one that acts (no ⏎ stand-in)
    await dialogPrimary(dlg).click()
    // one action did both. The pull lands first — asserted before the launch, because
    // the toast is a 4s slot and a session takes longer than that to bind
    await expect(page.locator('.toast')).toHaveText(/^repo · main: fast-forwarded 3 commits/, {
      timeout: 30_000
    })
    await expect(page.locator('.ws-behind')).toHaveCount(0)
    // …and the session it started is a real one: the row lands and binds
    const rows = wsRows(page, 'repo')
    await expect(rows).toHaveCount(1, { timeout: 40_000 })
    await expect(page.locator('.ws-tab.st-pending')).toHaveCount(0, { timeout: 60_000 })
    await snap(page, 'T-GP-01-started')
  } finally {
    await app.close().catch(() => {})
  }
})

// Dirty tree: the button never morphs, because Koloft's one write hand only touches a
// clean checkout — the line says so instead of hiding the number. On the ⌘N path this
// state renders nothing at all (D14), so C8's create state is where it is now read.
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

// D8 off: every AUTOMATIC fetch stops, and C8's open-time fetch (the last dialog that
// still triggers one) with it — the one entry point that keeps working is the fly-out's
// Fetch origin (D9, the self-lock fix).
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
    // past the startup sweep's 3s delay — with the switch off it never ran
    await page.waitForTimeout(6_000)
    await expect(page.locator('.ws-behind')).toHaveCount(0)

    const dlg = await openWorktreeSession(page, 'repo')
    await page.waitForTimeout(3_000)
    // git writes .git/FETCH_HEAD on every fetch and a fresh clone has none: the spy
    // is the repo itself, not a renderer counter
    expect(hasFetched(fx)).toBe(false)
    await expect(dlg.locator('.fresh-line.stale')).toHaveCount(0)
    await expect(dialogPrimary(dlg)).toContainText('Create worktree')
    await expect(dialogPrimary(dlg)).not.toContainText('Pull &')
    await snap(page, 'T-GP-03-no-fetch')

    // an empty field with no list row hot is the bottom rung: Esc closes the dialog
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

// An untracked file colliding with an incoming one is NOT a dirty tree (`-uno`), so the
// pull is offered and git refuses it at merge time. The brake: the failure is shown,
// nothing launches, and the button falls back to Start rather than morphing again.
test('T-GP-04: a pull refused by an untracked collision shows the error, starts nothing, reverts to Start', async ({
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
    // untracked ≠ dirty: the button morphs even though the pull is doomed
    await expect(dialogPrimary(dlg)).toContainText('Pull & Start', { timeout: 20_000 })

    await pressPrimary(page)
    const failed = dlg.locator('.field-hint.bad')
    await expect(failed).toBeVisible({ timeout: 60_000 })
    await expect(failed).toContainText('Pull failed:')
    await expect(failed).toContainText('untracked working tree files would be overwritten')
    await expect(dialogPrimary(dlg)).toContainText('Start')
    await expect(dialogPrimary(dlg)).not.toContainText('Pull &')
    // the brake held: nothing was launched on the old base behind the user's back
    await expect(wsRows(page, 'repo')).toHaveCount(0)
    // the lock took the keyboard away on its way in; releasing it hands it back to the
    // dialog itself, so ⏎ still starts the session the picker is now offering
    await expect(dlg).toBeFocused()
    await pressPrimary(page)
    await expect(wsRows(page, 'repo')).toHaveCount(1, { timeout: 40_000 })
    await snap(page, 'T-GP-04')
  } finally {
    await app.close().catch(() => {})
  }
})
