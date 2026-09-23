import { test, expect, launchApp } from './helpers/app'
import type { ElectronApplication, Page } from '@playwright/test'
import type { E2EEnv } from './helpers/env'
import {
  killSession,
  processAlive,
  resumedId,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'

// F7 fallback — the "Session unreachable" Force Close path. A reload now
// RE-ADOPTS main's live ptys (reload-recovery.spec.ts covers that), so a reload alone
// no longer orphans anything. These specs pin the fallback that guards every way
// adoption can fail: KOLOFT_TEST_NO_ADOPT is the main-side seam that answers an empty
// inventory (tabs:list), reproducing exactly the adoption-failed state — the renderer
// path exercised is an ordinary cold boot, no test branches in product code.

async function launchNoAdopt(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  env.launchEnv.KOLOFT_TEST_NO_ADOPT = '1'
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

test('T-ORPH-01: a session orphaned by a reload force-closes, then resumes like any cold row', async ({
  env
}) => {
  test.setTimeout(180_000)
  const { app, page } = await launchNoAdopt(env)
  try {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [launch] = await waitForCalls(env, 1)
    const row = wsRows(page, 'ws-a').first()
    await expect(row).not.toHaveClass(/\bcold\b/)
    expect(processAlive(launch.pid)).toBe(true)

    // the orphaning event itself — the tabs die with the renderer, the ptys do not
    await page.reload()
    await waitBooted(page)
    await expect(row).not.toHaveClass(/\bcold\b/, { timeout: 30_000 })
    expect(processAlive(launch.pid)).toBe(true)

    // clicking it used to do nothing at all: no tab to activate, no other branch
    await row.click()
    const modal = page.locator('.modal', { hasText: 'Session unreachable' })
    await expect(modal).toBeVisible({ timeout: 15_000 })
    await modal.locator('.btn-primary').click()

    // the kill reaches the real claude, and its exit is what turns the row cold
    await expect.poll(() => processAlive(launch.pid), { timeout: 30_000 }).toBe(false)
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })

    // …which is the point: the row is an ordinary cold row again, so it resumes
    await row.click()
    const calls = await waitForCalls(env, 2)
    expect(resumedId(calls[1])).toBe(launch.sessionId)
  } finally {
    await app.close().catch(() => {})
  }
})

test('T-ORPH-02: Cancel leaves the orphan running — the confirm is not a kill switch', async ({
  env
}) => {
  test.setTimeout(180_000)
  const { app, page } = await launchNoAdopt(env)
  try {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [launch] = await waitForCalls(env, 1)

    await page.reload()
    await waitBooted(page)
    const row = wsRows(page, 'ws-a').first()
    await row.click()
    const modal = page.locator('.modal', { hasText: 'Session unreachable' })
    await expect(modal).toBeVisible({ timeout: 15_000 })
    await modal.locator('.mini', { hasText: 'Cancel' }).click()

    await expect(modal).toHaveCount(0)
    expect(processAlive(launch.pid)).toBe(true)
    await expect(row).not.toHaveClass(/\bcold\b/)
  } finally {
    await app.close().catch(() => {})
  }
})

test('T-ORPH-03: a binding that dies while the confirm is up fails loudly, not silently', async ({
  env
}) => {
  test.setTimeout(180_000)
  const { app, page } = await launchNoAdopt(env)
  try {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [launch] = await waitForCalls(env, 1)

    await page.reload()
    await waitBooted(page)
    const row = wsRows(page, 'ws-a').first()
    await row.click()
    const modal = page.locator('.modal', { hasText: 'Session unreachable' })
    await expect(modal).toBeVisible({ timeout: 15_000 })

    // the session ends on its own while the confirm is up, so main has nothing bound
    // left to kill — the same answer a claude running OUTSIDE Koloft would get
    killSession(launch.pid, env)
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
    await modal.locator('.btn-primary').click()

    await expect(page.locator('.toast')).toHaveText(/Could not force close/, { timeout: 15_000 })
  } finally {
    await app.close().catch(() => {})
  }
})
