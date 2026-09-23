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

const LOOSE_STALL_CEILING_FOR_SHARED_RUNNERS_MS = 20_000
const BASELINE_RESOLUTIONS_ON_COLD_OPEN = 1
const AGGREGATE_DIFFS_ON_COLD_OPEN_ONE_PER_BASE_AND_STATUS_COMMIT = 2

test.describe('Workbench Changes cost: the first screenful of a large change set, and the cold open', () => {
  test('NFR-01: a large change set puts its first block on screen without a stall', async ({
    page,
    env
  }) => {
    test.setTimeout(240_000)
    const fx = setupChangeFixture(env.workspaces.a)
    fx.bigChange()

    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

    const pinned = page.locator(WORKBENCH.tabFiles)
    if (!(await workbenchPanel(page).isVisible())) await workbenchIcon(page).click()
    if (!(await pinned.getAttribute('class'))?.split(/\s+/).includes('on')) await pinned.click()

    const changes = page
      .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
      .filter({ hasText: 'Changes' })
    await expect(changes).toBeVisible({ timeout: 20_000 })
    const t0 = Date.now()
    if ((await changes.getAttribute('aria-pressed')) !== 'true') await changes.click()

    const firstRows = page.locator('.wb-panel .cv-blk').first().locator('.idiff-row')
    await expect(firstRows.first()).toBeVisible({
      timeout: LOOSE_STALL_CEILING_FOR_SHARED_RUNNERS_MS
    })
    const elapsed = Date.now() - t0

    console.log(
      `NFR01 first-block-readable: ${elapsed}ms (ceiling ${LOOSE_STALL_CEILING_FOR_SHARED_RUNNERS_MS}ms, target ~3000ms)`
    )
    expect(elapsed).toBeLessThan(LOOSE_STALL_CEILING_FOR_SHARED_RUNNERS_MS)

    await expect(page.locator('.wb-panel .cv-blk')).toHaveCount(6, { timeout: 30_000 })
  })

  test('NFR-02: the first expand on Changes resolves the baseline once', async ({
    app,
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    fx.modifyTracked(2)
    const ws = env.workspaces.a

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

      await expect(p.locator(`${WORKBENCH.panel} .cv-row`)).toHaveCount(2, { timeout: 30_000 })
      await expect(p.locator(`${WORKBENCH.panel} .cv-blk:not([data-ready="1"])`)).toHaveCount(0, {
        timeout: 30_000
      })
      await waitGitQuiet(env, { root: ws })

      expect(countGitSpawns(env, { root: ws, subcommand: 'merge-base' })).toBe(
        BASELINE_RESOLUTIONS_ON_COLD_OPEN
      )
      expect(countGitSpawns(env, { root: ws, argv: isAggregateDiff })).toBe(
        AGGREGATE_DIFFS_ON_COLD_OPEN_ONE_PER_BASE_AND_STATUS_COMMIT
      )
    } finally {
      await next.close().catch(() => {})
    }
  })

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
})
