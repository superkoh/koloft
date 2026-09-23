import type { Locator, Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import { gitInit, snap, startSessionIn } from './helpers/p1'
import { WORKBENCH, showBrowse } from './helpers/workbench'

// Spec sampling. The V0 rule the whole redesign
// leans on: a functional icon is a HOTSPOT, not a widget — a fixed box, a Lucide
// glyph, and colour as its only state. Nothing paints a plate under it, hovered or
// not. Four samples from the four places the rule has to hold: the titlebar (the
// 32×32 tier), the `files` kind bar, the artifact header inside the Workbench's
// `files` tab, and the Workbench tab strip's ＋ (which was the terminal island's strip
// until retired it).

/** One hotspot, asserted the way the eye checks it: idle first, then hovered — a
 *  background that only appears on :hover is the exact regression this guards. */
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
  // park the pointer somewhere inert so the next sample starts un-hovered
  await page.mouse.move(0, 0)
}

// T-SPEC-01 — the four sampled hotspots. tb-ico is the titlebar tier (32×32 box,
// 20px glyph); the other three are the T2 tier the header button family was merged
// into (24×24 box, 16px glyph).
test('T-SPEC-01: functional icon hotspots are transparent and correctly sized, idle and hovered', async ({
  page,
  env
}) => {
  test.setTimeout(180_000)
  gitInit(env.workspaces.a)

  // ① titlebar (always there)
  await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
  await assertHotspot(page, page.locator('.tb-ico[aria-label="Settings"]'), 32)

  // ② the `files` kind bar's search toggle. The SAMPLE moved surfaces; the rule did not.
  // It used to be taken with no session at all, off the sidebar Files island's
  // unconditional top bar — but "unconditional" was incidental to what is being measured
  // here, which is the 24px hotspot tier. The tree retired into the panel's pinned tab
  // (FR-44), so the same control now needs a session and Browse under it, and is still
  // 24×24 with no plate. Read a failure here as the geometry rule breaking, never as the
  // button having moved.
  // ③ the reading area's reload, from the artifact header (FR-31). Scoped to
  // `.fv-artifact-hd`: the kind bar sampled at ② carries a ↻ of its own (FR-58), and an
  // unscoped [aria-label="Reload"] would match both.
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

  // ④ the Workbench tab strip's ＋ — the last surface the rule has to hold on.
  // retired the terminal island, and with it `.ttab-plus`; the panel's own ＋ (which now
  // opens terminal tabs too) is the tab-strip ＋ the rule applies to.
  await assertHotspot(page, page.locator(WORKBENCH.newTab), 24)
  await snap(page, 'T-SPEC-01')
})
