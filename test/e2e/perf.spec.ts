import { test, expect, launchApp } from './helpers/app'
import { resumedId, seedJsonl, snap, waitForCalls } from './helpers/p1'

// T-PERF-01 — order-of-magnitude guardrails over a 300-session Claude storage
// : the list must render promptly (catches O(n²)
// pathologies), scroll to the bottom under real wheel input fast, and keep rows
// clickable. No frame-rate or implementation-mechanism assertions.

const COUNT = 300
const OLDEST = `Perf session ${COUNT - 1}`

test('T-PERF-01: 300 sessions render fast, wheel to bottom is fast, bottom row is clickable', async ({
  env
}) => {
  test.setTimeout(180_000)
  const now = Date.now()
  let oldestId = ''
  for (let i = 0; i < COUNT; i++) {
    // newest first: mtime (and timestamp) fall one minute per index
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

    // ① a known-title row is on screen within the 5s budget
    await expect(page.locator('.ws-tab', { hasText: 'Perf session 150' })).toBeVisible({
      timeout: 5_000
    })
    await expect(page.locator('.ws-tab')).toHaveCount(COUNT)

    // ② real wheel input reaches the mtime-oldest row (bottom of the cold sort)
    //    within 2s. "Visible" here means inside the list viewport — Playwright's
    //    visibility doesn't account for scroll clipping.
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
    expect(elapsed, `reaching the bottom took ${elapsed}ms`).toBeLessThanOrEqual(2_000)
    await snap(page, 'T-PERF-01')

    // ③ the bottom row responds to a click: the cold row resumes (its session id)
    //    and takes the selected state within the default expect budget
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
