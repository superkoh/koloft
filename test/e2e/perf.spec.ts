import { test, expect, launchApp } from './helpers/app'
import { resumedId, seedJsonl, snap, waitForCalls } from './helpers/p1'

const COUNT = 300
const OLDEST = `Perf session ${COUNT - 1}`
const FIRST_ROW_BUDGET_MS = 5_000
const WHEEL_TO_BOTTOM_BUDGET_MS = 2_000

test.describe('order-of-magnitude guardrails over a 300-session storage (catches O(n²), never pins frame rate or mechanism)', () => {
  test('T-PERF-01: 300 sessions render fast, wheel to bottom is fast, bottom row is clickable', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const now = Date.now()
    let oldestId = ''
    for (let i = 0; i < COUNT; i++) {
      const id = seedJsonl(env, env.workspaces.a, {
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        summary: `Perf session ${i}`,
        timestamp: now - i * 60_000,
        mtime: now - i * 60_000
      })
      if (i === COUNT - 1) oldestId = id
    }

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator('.ws-list')).toBeVisible({ timeout: 20_000 })

      await expect(page.locator('.ws-tab', { hasText: 'Perf session 150' })).toBeVisible({
        timeout: FIRST_ROW_BUDGET_MS
      })
      await expect(page.locator('.ws-tab')).toHaveCount(COUNT)

      const inListViewport = (): Promise<boolean> =>
        page.evaluate((title) => {
          const list = document.querySelector('.ws-list')
          if (!list) return false
          const lr = list.getBoundingClientRect()
          const row = [...document.querySelectorAll('.ws-tab')].find((r) =>
            r.textContent?.includes(title)
          )
          if (!row) return false
          const rr = row.getBoundingClientRect()
          return rr.top < lr.bottom && rr.bottom > lr.top
        }, OLDEST)

      const box = await page.locator('.ws-list').boundingBox()
      expect(box).not.toBeNull()
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
      const t0 = Date.now()
      let reached = await inListViewport()
      while (!reached && Date.now() - t0 < 5_000) {
        await page.mouse.wheel(0, 4000)
        reached = await inListViewport()
      }
      const elapsed = Date.now() - t0
      expect(reached, 'wheeling never reached the oldest row').toBe(true)
      expect(elapsed, `reaching the bottom took ${elapsed}ms`).toBeLessThanOrEqual(
        WHEEL_TO_BOTTOM_BUDGET_MS
      )
      await snap(page, 'T-PERF-01')

      await page.locator('.ws-tab', { hasText: OLDEST }).click()
      const calls = await waitForCalls(env, 1)
      expect(resumedId(calls[0])).toBe(oldestId)
      await expect(page.locator('.ws-tab.active', { hasText: OLDEST })).toBeVisible({
        timeout: 30_000
      })
    } finally {
      await app.close().catch(() => {})
    }
  })
})
