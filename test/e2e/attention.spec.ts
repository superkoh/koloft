import { test, expect, pendingAttention } from './helpers/app'
import {
  centerTerm,
  FAKE_SESSION_TITLE,
  killSession,
  runIn,
  startSessionIn,
  waitBooted,
  waitForCalls
} from './helpers/p1'

const PAST_TWO_LIVENESS_SWEEPS_MS = 6_000

test.describe('attention markers come from real session-status transitions (shim → hooks → tracker → attention set)', () => {
  test('a finished turn pends attention and a red dot on its row even with the window unfocused, and visiting the tab clears both', async ({
    page
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')

    await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })

    await expect
      .poll(() => pendingAttention(page), { timeout: 10_000 })
      .toMatchObject([{ kind: 'turn-done', title: expect.stringContaining('project notes') }])
    await expect(page.locator('.ws-tab.st-waiting .ws-tab-unread')).toHaveCount(1)

    const head = page.locator('.ws-head', { hasText: 'ws-a' })
    await head.locator('.fico').click()
    await expect(head.locator('.ws-unread-count')).toHaveText('1')
    await head.locator('.fico').click()
    await expect(head.locator('.ws-unread-count')).toHaveCount(0)

    await expect(page.locator('.needs')).toHaveCount(0)
    await expect(page.locator('.sb-rollup')).toHaveCount(0)
    await expect(page.locator('.toast')).toHaveCount(0)

    await page.locator('.ws-tab').first().click()
    await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(0)
    await expect(page.locator('.ws-tab.st-waiting')).toBeVisible()
    await expect(page.locator('.ws-tab-unread')).toHaveCount(0)
  })

  test('a graceful /exit clears pending and never raises exited, not even after two liveness sweeps', async ({
    page
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await expect.poll(() => pendingAttention(page), { timeout: 25_000 }).toHaveLength(1)

    // CC§1
    await runIn(page, centerTerm(page), '/exit')
    await expect.poll(() => pendingAttention(page), { timeout: 15_000 }).toHaveLength(0)
    await page.waitForTimeout(PAST_TWO_LIVENESS_SWEEPS_MS)
    expect(await pendingAttention(page)).toHaveLength(0)
  })

  test('T-LIFE-04: a hard-killed claude turns its row cold in place, keeping its title and an exited red dot that clicking the row clears', async ({
    page,
    env
  }) => {
    test.setTimeout(150_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })

    const [call] = await waitForCalls(env, 1)
    killSession(call.pid, env)

    const row = page.locator('.ws-tab', { hasText: FAKE_SESSION_TITLE })
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
    await expect(page.locator('.ws-tab.st-waiting')).toHaveCount(0)
    await expect(page.locator('.ws-tab.st-approval')).toHaveCount(0)

    await expect
      .poll(async () => (await pendingAttention(page)).map((a) => a.kind))
      .toEqual(['exited'])
    await expect(row.locator('.ws-tab-unread')).toHaveCount(1)

    await row.click()
    await expect
      .poll(async () => (await pendingAttention(page)).map((a) => a.kind), { timeout: 10_000 })
      .not.toContain('exited')
  })
})
