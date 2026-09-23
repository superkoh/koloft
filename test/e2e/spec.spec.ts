import type { Locator, Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import { gitInit, snap, startSessionIn } from './helpers/p1'
import { WORKBENCH, showBrowse } from './helpers/workbench'

async function assertHotspot(page: Page, loc: Locator, size: number): Promise<void> {
  const paint = (): Promise<{ bg: string; img: string }> =>
    loc.evaluate((el) => {
      const s = getComputedStyle(el)
      return { bg: s.backgroundColor, img: s.backgroundImage }
    })

  await expect(loc).toBeVisible()
  expect(await paint()).toEqual({ bg: 'rgba(0, 0, 0, 0)', img: 'none' })

  await loc.hover()
  expect(await paint()).toEqual({ bg: 'rgba(0, 0, 0, 0)', img: 'none' })

  const box = await loc.boundingBox()
  expect(box, 'the hotspot has no box at all').toBeTruthy()
  expect(Math.round(box!.width)).toBe(size)
  expect(Math.round(box!.height)).toBe(size)
  await page.mouse.move(0, 0)
}

test.describe('V0: a functional icon is a hotspot — a fixed box, a glyph, colour as its only state, never a plate', () => {
  test('T-SPEC-01: functional icon hotspots are transparent and correctly sized, idle and hovered', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)

    await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
    await assertHotspot(page, page.locator('.tb-ico[aria-label="Settings"]'), 32)

    await startSessionIn(page, 'ws-a')
    await showBrowse(page)
    await assertHotspot(
      page,
      page.locator(`${WORKBENCH.kindBar} .icobtn[aria-label="Search files"]`),
      24
    )
    await page
      .locator(`${WORKBENCH.panel} .ft-node.ft-file`, { hasText: 'NOTES.md' })
      .click({ timeout: 30_000 })
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md')
    await assertHotspot(
      page,
      page.locator(`${WORKBENCH.panel} .fv-artifact-hd .icobtn[aria-label="Reload"]`),
      24
    )

    await assertHotspot(page, page.locator(WORKBENCH.newTab), 24)
    await snap(page, 'T-SPEC-01')
  })
})
