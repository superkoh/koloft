import type { Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { startSessionIn, waitBooted } from './helpers/p1'
import { setupChangeFixture } from './helpers/filesFixture'
import {
  WORKBENCH,
  countGitSpawns,
  installGitSpawnLog,
  isAggregateDiff,
  waitGitQuiet,
  workbenchIcon,
  workbenchPanel
} from './helpers/workbench'

/**
 * The panel's two NFR cases that are about COST rather than about what is on screen: the
 * time NFR-01 gives the first screenful, and the one baseline resolution NFR-02 allows a
 * COLD open (WB-C17 carries every later refresh).
 *
 * NFR-01's TIME half — the one the cases doc sends to a manual round, automated here as a
 * ceiling rather than as the requirement.
 *
 * Read the number below before changing it. NFR-01 says the first screenful of a large
 * change set is readable within ~3 seconds ON THE DEV MACHINE, and the spec explicitly
 * declines to make that a CI threshold: there is no fleet promise, and 3000ms asserted on
 * a loaded four-worker runner would fail for the machine's reasons rather than the code's.
 * So this asserts a much looser ceiling, and what it actually defends is a DIFFERENT and
 * cruder failure: the stream becoming unreadable-for-seconds because something started
 * doing O(change set) work up front again.
 *
 * WB-C16 already pins the structural half (no highlight spans in an off-screen block), and
 * it is the sharper of the two — a build that highlights everything eagerly fails there
 * first. This case exists for the ways a stream can be slow WITHOUT failing that: a
 * blocking parse, a synchronous layout pass, an N² anchor computation. The measurement is
 * printed so a human doing the dev-machine baseline can read the real number off a normal
 * run instead of building the fixture by hand.
 */

/** Deliberately far above NFR-01's 3s. See the header: this is "not catastrophically
 *  slow", which is the only timing claim a shared runner can honestly make. */
const CEILING_MS = 20_000

test('NFR-01: a large change set puts its first block on screen without a stall', async ({
  page,
  env
}) => {
  test.setTimeout(240_000)
  const fx = setupChangeFixture(env.workspaces.a)
  // ~10800 diff lines across six files — the same shape WB-C16 uses, which is what makes
  // the two cases comparable when one of them moves
  fx.bigChange()

  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

  const pinned = page.locator(WORKBENCH.tabFiles)
  if (!(await workbenchPanel(page).isVisible())) await workbenchIcon(page).click()
  if (!(await pinned.getAttribute('class'))?.split(/\s+/).includes('on')) await pinned.click()

  // the clock starts at the gesture that asks for Changes, not at app launch: NFR-01 is
  // about the view, and folding session startup in would measure the harness
  const changes = page
    .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
    .filter({ hasText: 'Changes' })
  await expect(changes).toBeVisible({ timeout: 20_000 })
  const t0 = Date.now()
  if ((await changes.getAttribute('aria-pressed')) !== 'true') await changes.click()

  // "readable" is the first block having its rows, not merely a box existing — a skeleton
  // that appears instantly and fills in later would satisfy a visibility check while
  // failing the requirement.
  const firstRows = page.locator('.wb-panel .cv-blk').first().locator('.idiff-row')
  await expect(firstRows.first()).toBeVisible({ timeout: CEILING_MS })
  const elapsed = Date.now() - t0

  // eslint-disable-next-line no-console -- the dev-machine baseline is read off this line
  console.log(`NFR01 first-block-readable: ${elapsed}ms (ceiling ${CEILING_MS}ms, target ~3000ms)`)
  expect(elapsed).toBeLessThan(CEILING_MS)

  // …and the stream really is the big one, so a fixture that silently shrank cannot make
  // the timing look good
  await expect(page.locator('.wb-panel .cv-blk')).toHaveCount(6, { timeout: 30_000 })
})

// ---- NFR-02, the cold open ----------------------------------------------------------------

/**
 * NFR-02 — the FIRST expand resolves the baseline once, exactly like every later refresh.
 *
 * WB-C17 (workbench-changes.spec.ts) owns the steady-state half and structurally cannot see
 * this one: it opens its counting window with `waitGitQuiet`, i.e. after the cold open has
 * already happened, so it only ever measures a panel whose baseline is long since resolved.
 * The window here is the WHOLE launch, which is why the spawn log has to be installed before
 * anything expands the panel — the relaunch below is that, and it is the only reason this
 * case cannot simply live beside WB-C17.
 *
 * What it caught: `FilesView` handed the stream `base ?? null`, folding the panel's "still
 * resolving" (undefined) into "there is no baseline" (null). `baseArg(null)` is `''`, main
 * reads `''` as "resolve one yourself", and so every un-based run of the stream's fetch made
 * main derive a merge-base privately and diff the whole change set against it. Measured on
 * this fixture, the cold open cost 3 baseline resolutions and 4 aggregates where 1 and 2 are
 * the work: the stream fired un-based at mount, again when the status map landed, and a
 * third time once the panel's real baseline arrived. It now WAITS for that baseline instead.
 *
 * The two numbers, and why they are those numbers:
 *  · merge-base 1 — `gitStatus.diffBase` is its only caller in the app, so counting it IS
 *    counting baseline resolutions. `toBe(1)` rather than `toBeGreaterThan(0)` is the whole
 *    case; the bug scored 3.
 *  · aggregate diff 2 — the honest number, not a target. The panel's poll publishes the
 *    baseline and the status map in two separate commits (it resolves the base, THEN runs
 *    status), and the stream re-queries on each; the second is FR-58's in-place update, not
 *    re-derived work. The bug scored 4.
 */
test('NFR-02: the first expand on Changes resolves the baseline once', async ({
  app,
  page,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)
  fx.modifyTracked(2)
  const ws = env.workspaces.a

  // the shim is a launch-time seam, so the fixture's already-running app has to be replaced
  // before the panel has done anything at all (the mirror of WB-C17's `relaunchWithGitLog`,
  // which cannot be reused: it lives in the Changes spec)
  await app.close().catch(() => {})
  installGitSpawnLog(env)
  const next = await launchApp(env)
  const p = await next.firstWindow()
  await p.waitForLoadState('domcontentloaded')
  await waitBooted(p)

  try {
    await startSessionIn(p, 'ws-a')
    await expect(workbenchPanel(p)).toBeVisible({ timeout: 25_000 })
    await showChangesHere(p)

    // The cold open produced a REAL screen. Without this barrier the counts below would pass
    // just as happily against a build whose stream never ran at all — the failure mode every
    // "assert a small number" case has to rule out first.
    await expect(p.locator(`${WORKBENCH.panel} .cv-row`)).toHaveCount(2, { timeout: 30_000 })
    await expect(p.locator(`${WORKBENCH.panel} .cv-blk:not([data-ready="1"])`)).toHaveCount(0, {
      timeout: 30_000
    })
    await waitGitQuiet(env, { root: ws })

    // Absolute counts, not a difference: this launch created the log, and at a workspace root
    // only the Workbench emits `merge-base` or a bare `diff <rev> --` (helpers/gitSpawnLog.ts
    // enumerates who emits what, and why the freshness engine cannot be confused for it).
    expect(countGitSpawns(env, { root: ws, subcommand: 'merge-base' })).toBe(1)
    expect(countGitSpawns(env, { root: ws, argv: isAggregateDiff })).toBe(2)
  } finally {
    await next.close().catch(() => {})
  }
})

/** Changes on screen, in the one form this file needs. The fuller `showChanges` belongs to
 *  the Changes cases; here the panel is brand new, so nothing has moved it off Changes yet
 *  and only the pinned tab is worth asserting. */
async function showChangesHere(page: Page): Promise<void> {
  const panel = workbenchPanel(page)
  if (!(await panel.isVisible())) await workbenchIcon(page).click()
  await expect(panel).toBeVisible({ timeout: 20_000 })
  const pinned = page.locator(WORKBENCH.tabFiles)
  if (!(await pinned.getAttribute('class'))?.split(/\s+/).includes('on')) await pinned.click()
  await expect(page.locator(`${WORKBENCH.panel} .fv`)).toHaveAttribute('data-view', 'changes', {
    timeout: 20_000
  })
}
