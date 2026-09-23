import { test, expect, pendingAttention } from './helpers/app'
import { centerTerm, runIn, startSessionIn, waitBooted } from './helpers/p1'

/**
 * Requirement: "this session needs you" is said ONCE, by the tab row's status dot.
 *
 * The v0.5 cockpit said it up to five times at once — a roll-up count, a pinned
 * Needs-you strip, a row badge, an in-window toast, and the dot. The other four are
 * gone. This spec is the regression fence around that, and it proves BOTH halves,
 * because either one alone is easy to pass by accident:
 *
 *   1. the four removed channels never render, even with markers pending, and
 *   2. every run-state the dot has to carry is still distinguishable — working,
 *      approval and waiting rendered side by side in one screenshot's worth of DOM.
 *
 * It also inherits three assertions that used to live in toast.spec.ts and exist
 * nowhere else: the Dock is never touched, NO `new Notification` is ever constructed
 * (the two halves of D8, which no longer has an in-app outlet to fall back to), and
 * `/need-approval` — the only end-to-end drive of the approval path — is exercised.
 */
test('one dot per session, and nothing else says it', async ({ app, page }) => {
  test.setTimeout(150_000)
  await waitBooted(page)

  // ── session 1 (ws-a): parked on a permission prompt → approval ──────
  await startSessionIn(page, 'ws-a')
  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })
  // the run-state Notification hook fires with a "needs your permission" message
  await runIn(page, centerTerm(page), '/need-approval')
  await expect(page.locator('.ws-tab.st-approval')).toBeVisible({ timeout: 20_000 })

  // ── session 2 (ws-b): mid-turn on a long task → working ─────────────
  await startSessionIn(page, 'ws-b')
  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })
  await runIn(page, centerTerm(page), '/busy') // ~30s in flight, no Stop
  await expect(page.locator('.ws-tab.st-working')).toBeVisible({ timeout: 20_000 })

  // ── session 3 (ws-a): a finished turn, left alone → waiting ─────────
  // (well inside IDLE_MS, so it cannot have decayed to 'idle' by the asserts below)
  await startSessionIn(page, 'ws-a')
  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })

  // all three run-states on screen AT ONCE. This is the premise of the whole removal:
  // if the dot couldn't carry them apart, the deleted channels would be load-bearing.
  await expect(page.locator('.ws-tab.st-working')).toBeVisible()
  await expect(page.locator('.ws-tab.st-approval')).toBeVisible()
  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible()

  // markers really are pending — every absence assertion below would be vacuous if the
  // attention layer simply had nothing to say right now
  expect((await pendingAttention(page)).length).toBeGreaterThan(0)

  // ── 1. the four removed channels ────────────────────────────────────
  await expect(page.locator('.sb-rollup')).toHaveCount(0) // roll-up summary line
  await expect(page.locator('.needs')).toHaveCount(0) // Needs-you strip
  await expect(page.locator('.needs-row')).toHaveCount(0)
  await expect(page.locator('.needs-head')).toHaveCount(0)
  await expect(page.locator('.needs-more')).toHaveCount(0)
  await expect(page.locator('.ws-badge')).toHaveCount(0) // per-row badge
  await expect(page.locator('.toast-layer')).toHaveCount(0) // in-window toast
  await expect(page.locator('.toast')).toHaveCount(0)

  // the sessions island opens straight into the tab list — nothing is pinned above it
  const firstChild = await page
    .locator('.isl-sessions > *')
    .first()
    .evaluate((el) => el.className)
  expect(firstChild).toContain('ws-list')

  // the renderer doesn't subscribe to the pending set any more; it can only query it
  const hasOnUpdate = await page.evaluate(
    () => typeof (window.api.attention as { onUpdate?: unknown }).onUpdate
  )
  expect(hasOnUpdate).toBe('undefined')

  // ── 2. D8, inherited from toast.spec.ts: no OS-level outlet, ever ───
  // With the toast gone these are the only outlets route() can pick, so a routing
  // regression that leaks past the background-test guard has nowhere else to surface.
  const badge = await app.evaluate(({ app }) => app.dock?.getBadge?.() ?? '')
  expect(badge).toBe('')
  const osCount = await app.evaluate(
    () => (globalThis as { __koloftOsNotifCount?: number }).__koloftOsNotifCount ?? -1
  )
  expect(osCount).toBe(0)
})
