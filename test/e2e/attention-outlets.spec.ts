import { test, expect, osOutlets, pendingAttention } from './helpers/app'
import { centerTerm, runIn, startSessionIn, waitBooted, wsRows } from './helpers/p1'
import { ATTENTION_REASON, PLACEHOLDER_SESSION_TITLE } from '../../src/shared/types'

test('one bar per session carries working, approval and waiting side by side, and a red dot marks exactly the rows the pending list names; no roll-up, Needs-you strip or toast says it, while the Dock badge counts the marks and each mark raises an OS notification naming its session, why, and its folder', async ({
  app,
  page
}) => {
  test.setTimeout(150_000)
  await waitBooted(page)

  await startSessionIn(page, 'ws-a')
  await expect(page.locator('.ws .ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })
  await runIn(page, centerTerm(page), '/need-approval')
  await expect(page.locator('.ws .ws-tab.st-approval')).toBeVisible({ timeout: 20_000 })

  await startSessionIn(page, 'ws-b')
  await expect(page.locator('.ws .ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })
  await runIn(page, centerTerm(page), '/busy')
  await expect(page.locator('.ws .ws-tab.st-working')).toBeVisible({ timeout: 20_000 })

  await startSessionIn(page, 'ws-a')
  await expect(page.locator('.ws .ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })

  await expect(page.locator('.ws .ws-tab.st-working')).toBeVisible()
  await expect(page.locator('.ws .ws-tab.st-approval')).toBeVisible()
  await expect(page.locator('.ws .ws-tab.st-waiting')).toBeVisible()

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

  const realBadge = await app.evaluate(({ app }) => app.dock?.getBadge?.() ?? '')
  expect(realBadge).toBe('')

  const tabsInA = await wsRows(page, 'ws-a').evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-tab-id'))
  )
  const everyMarkHasItsBadgeAndNotification = async (): Promise<string> => {
    const pending = await pendingAttention(page)
    const outlets = await osOutlets(app)
    const missing = pending
      .map((e) => ({
        title: e.title || PLACEHOLDER_SESSION_TITLE,
        body: `${ATTENTION_REASON[e.kind]} · ${tabsInA.includes(e.tabId) ? 'ws-a' : 'ws-b'}`
      }))
      .filter((n) => !outlets.notifications.some((o) => o.title === n.title && o.body === n.body))
    return JSON.stringify({ badge: outlets.dockBadge === String(pending.length), missing })
  }
  await expect
    .poll(everyMarkHasItsBadgeAndNotification)
    .toBe(JSON.stringify({ badge: true, missing: [] }))
  expect((await osOutlets(app)).notifications.map((n) => n.body)).toContain(
    'waiting for your approval · ws-a'
  )
})
