import { test, expect, pendingAttention } from './helpers/app'
import { centerTerm, runIn, startSessionIn, waitBooted } from './helpers/p1'

test('one bar per session carries working, approval and waiting side by side, and a red dot marks exactly the rows the pending list names; no roll-up, Needs-you strip, toast, Dock badge or OS notification says it', async ({
  app,
  page
}) => {
  test.setTimeout(150_000)
  await waitBooted(page)

  await startSessionIn(page, 'ws-a')
  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })
  await runIn(page, centerTerm(page), '/need-approval')
  await expect(page.locator('.ws-tab.st-approval')).toBeVisible({ timeout: 20_000 })

  await startSessionIn(page, 'ws-b')
  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })
  await runIn(page, centerTerm(page), '/busy')
  await expect(page.locator('.ws-tab.st-working')).toBeVisible({ timeout: 20_000 })

  await startSessionIn(page, 'ws-a')
  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })

  await expect(page.locator('.ws-tab.st-working')).toBeVisible()
  await expect(page.locator('.ws-tab.st-approval')).toBeVisible()
  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible()

  expect((await pendingAttention(page)).length).toBeGreaterThan(0)
  const dottedRowsMatchPending = async (): Promise<boolean> => {
    const pending = (await pendingAttention(page)).map((a) => a.tabId).sort()
    const dotted = await page
      .locator('.ws-tab:has(.ws-tab-unread)')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-tab-id') ?? '').sort())
    return JSON.stringify(pending) === JSON.stringify(dotted)
  }
  await expect.poll(dottedRowsMatchPending).toBe(true)

  await expect(page.locator('.sb-rollup')).toHaveCount(0)
  await expect(page.locator('.needs')).toHaveCount(0)
  await expect(page.locator('.needs-row')).toHaveCount(0)
  await expect(page.locator('.needs-head')).toHaveCount(0)
  await expect(page.locator('.needs-more')).toHaveCount(0)
  await expect(page.locator('.toast-layer')).toHaveCount(0)
  await expect(page.locator('.toast')).toHaveCount(0)

  const firstChild = await page
    .locator('.isl-sessions > *')
    .first()
    .evaluate((el) => el.className)
  expect(firstChild).toContain('ws-list')

  const badge = await app.evaluate(({ app }) => app.dock?.getBadge?.() ?? '')
  expect(badge).toBe('')
  const osCount = await app.evaluate(
    () => (globalThis as { __koloftOsNotifCount?: number }).__koloftOsNotifCount ?? -1
  )
  expect(osCount).toBe(0)
})
