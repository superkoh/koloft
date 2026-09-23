import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { snap, startSessionIn, waitBooted, wsRows } from './helpers/p1'

const head = (page: Page, wsName: string): Locator => page.locator('.ws-head', { hasText: wsName })

test.describe('Picking a workspace: its head picks it and shows its welcome panel, running sessions keep running, and folding moved to the folder icon', () => {
  test('N11: clicking a workspace head picks it and the centre shows its welcome panel', async ({
    env
  }) => {
    test.setTimeout(120_000)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      const panel = page.locator('.w-empty')
      await expect(panel.locator('.big')).toHaveText('ws-a', { timeout: 20_000 })
      await expect(head(page, 'ws-b')).not.toHaveClass(/\bactive\b/)

      await head(page, 'ws-b').locator('.ws-name').click()

      await expect(head(page, 'ws-b')).toHaveClass(/\bactive\b/)
      await expect(head(page, 'ws-a')).not.toHaveClass(/\bactive\b/)
      await expect(panel.locator('.big')).toHaveText('ws-b')
      await expect(panel.locator('.quiet').first()).toHaveText('No running session')
      await snap(page, 'N11')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('N12: picking another workspace leaves the running session mounted, and going back restores it', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')

      const rowA = wsRows(page, 'ws-a').first()
      await expect(rowA).toHaveClass(/\bactive\b/)
      const terms = page.locator('.term-wrap')
      await expect(terms).toHaveCount(1)
      await expect(page.locator('.w-empty')).toHaveCount(0)

      await head(page, 'ws-b').locator('.ws-name').click()
      const panel = page.locator('.w-empty')
      await expect(panel.locator('.big')).toHaveText('ws-b')
      await expect(head(page, 'ws-b')).toHaveClass(/\bactive\b/)
      await expect(rowA).not.toHaveClass(/\bactive\b/)
      await expect(terms).toHaveCount(1)

      await rowA.click()
      await expect(rowA).toHaveClass(/\bactive\b/)
      await expect(head(page, 'ws-b')).not.toHaveClass(/\bactive\b/)
      await expect(page.locator('.w-empty')).toHaveCount(0)
      await expect(terms).toHaveCount(1)
      await snap(page, 'N12')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('N13: the folder icon folds the group and never changes the pick', async ({ env }) => {
    test.setTimeout(240_000)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')

      const rowA = wsRows(page, 'ws-a').first()
      await expect(rowA).toHaveClass(/\bactive\b/)
      const group = page
        .locator('.ws')
        .filter({ has: head(page, 'ws-a') })
        .locator('.ws-tabs')
      await expect(group).toHaveCount(1)

      const fico = head(page, 'ws-a').locator('.fico')
      await fico.click()
      await expect(group).toHaveCount(0)
      await expect(head(page, 'ws-a')).not.toHaveClass(/\bactive\b/)
      await expect(page.locator('.w-empty')).toHaveCount(0)

      await fico.click()
      await expect(group).toHaveCount(1)
      await expect(rowA).toHaveClass(/\bactive\b/)
      await expect(head(page, 'ws-a')).not.toHaveClass(/\bactive\b/)
      await snap(page, 'N13')
    } finally {
      await app.close().catch(() => {})
    }
  })
})
