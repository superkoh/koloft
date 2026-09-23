import type { Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import { startSessionIn } from './helpers/p1'
import { setupChangeFixture } from './helpers/filesFixture'
import { WORKBENCH, workbenchIcon, workbenchPanel } from './helpers/workbench'
import { newWebTab, activeKind } from './helpers/browser'

/**
 * Dragging the Workbench gutter with a big Changes stream in the panel must stay smooth —
 * whether the stream is the tab on top, or sits hidden behind a web tab.
 *
 * Two numbers, printed and pinned:
 *  · LAYOUT — the browser's own cost of laying the column out at a new width, measured
 *    in-page (set the width, force layout, read the clock). This is what a drag step pays
 *    before anything can paint, independent of React and of the harness.
 *  · DRAG — the average gap between two animation frames while a real mouse drag moves
 *    the gutter, which is what the user's hand feels.
 *
 * Measured on a Mac, 6×900-line fixture, before → after:
 *   Changes on top:   layout per step 75ms → 17ms · drag frame avg 61ms → 14ms
 *   behind a web tab: layout per step 73ms → 17ms · drag frame avg 60ms → 12ms
 * The fixes: off-screen blocks are no longer laid out (changesView.css), and the drag
 * writes the DOM instead of the store (App.tsx). Each ceiling sits between the two
 * numbers: a loaded runner can't cross it, and undoing either fix can't stay under it.
 * The WORST frame is printed but not pinned — the first frame of a drag pays for the
 * resize gate and the overlay, and that is not what this case is about.
 */
const LAYOUT_CEILING_MS = 45
const FRAME_AVG_CEILING_MS = 35

async function showChanges(page: Page): Promise<void> {
  const panel = workbenchPanel(page)
  if (!(await panel.isVisible())) await workbenchIcon(page).click()
  await expect(panel).toBeVisible({ timeout: 20_000 })
  const pinned = page.locator(WORKBENCH.tabFiles)
  if (!(await pinned.getAttribute('class'))?.split(/\s+/).includes('on')) await pinned.click()
  const changes = page
    .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
    .filter({ hasText: 'Changes' })
  await expect(changes).toBeVisible({ timeout: 20_000 })
  if ((await changes.getAttribute('aria-pressed')) !== 'true') await changes.click()
}

/** the big stream, on screen and fully rendered */
async function bigStream(page: Page): Promise<void> {
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
  await showChanges(page)
  await expect(page.locator('.wb-panel .cv-blk')).toHaveCount(6, { timeout: 60_000 })
  await expect(page.locator('.wb-panel .cv-blk:not([data-ready="1"])')).toHaveCount(0, {
    timeout: 60_000
  })
  expect(await page.locator('.wb-panel .idiff-row').count()).toBeGreaterThan(5000)
}

/** ① pure layout cost of a width change, 10 steps alternating ±40px */
async function layoutCost(page: Page): Promise<number> {
  const times = await page.evaluate(() => {
    const col = document.querySelector<HTMLElement>('.wb-col')!
    const start = col.offsetWidth
    const out: number[] = []
    for (let i = 0; i < 10; i++) {
      col.style.width = `${start + (i % 2 ? 40 : -40)}px`
      const t0 = performance.now()
      void col.offsetHeight // force layout
      out.push(performance.now() - t0)
    }
    col.style.width = `${start}px`
    void col.offsetHeight
    return out
  })
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  // eslint-disable-next-line no-console -- the dev-machine baseline is read off this line
  console.log(
    `RESIZE-PERF layout per step: avg ${avg.toFixed(1)}ms max ${Math.max(...times).toFixed(1)}ms`
  )
  return avg
}

/** ② a real drag: 30 mouse steps out and 30 back, frame gaps recorded in-page */
async function dragFrameAvg(page: Page): Promise<number> {
  const gutter = page.locator('.center-row .gutter-v').last()
  const box = (await gutter.boundingBox())!
  await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __stop: boolean }
    w.__gaps = []
    w.__stop = false
    let last = performance.now()
    const tick = (): void => {
      const now = performance.now()
      w.__gaps.push(now - last)
      last = now
      if (!w.__stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 200, box.y + box.height / 2, { steps: 30 })
  await page.mouse.move(box.x, box.y + box.height / 2, { steps: 30 })
  await page.mouse.up()
  const gaps = await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __stop: boolean }
    w.__stop = true
    return w.__gaps.slice(1)
  })
  const worst = Math.max(...gaps)
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length
  // eslint-disable-next-line no-console -- the dev-machine baseline is read off this line
  console.log(
    `RESIZE-PERF drag frame gap: avg ${avg.toFixed(1)}ms worst ${worst.toFixed(1)}ms over ${gaps.length} frames`
  )
  return avg
}

test('resizing the Workbench over a large change set stays smooth', async ({ page, env }) => {
  test.setTimeout(240_000)
  setupChangeFixture(env.workspaces.a).bigChange()
  await bigStream(page)

  const layout = await layoutCost(page)
  const frame = await dragFrameAvg(page)
  expect(layout).toBeLessThan(LAYOUT_CEILING_MS)
  expect(frame).toBeLessThan(FRAME_AVG_CEILING_MS)
})

/**
 * The same stream, hidden behind a blank web tab. A hidden Files body keeps its box
 * (`visibility`, so the scroll position survives the round trip) — and a box that is
 * still in the layout is still re-laid out at every width, whether or not anyone can
 * see it. So the drag paid the whole stream's line-wrapping for a tab that was showing
 * about:blank — the same 73ms a step as with Changes on top. `content-visibility` skips
 * the hidden body's off-screen blocks just as it skips the visible one's, so the same
 * fix covers both. The scroll check at the end is what keeps a future fix honest: the
 * cheap way to skip a hidden body's layout entirely is `display:none`, which would
 * reset that scroll.
 */
test('resizing with the change set hidden behind a web tab is just as smooth', async ({
  page,
  env
}) => {
  test.setTimeout(240_000)
  setupChangeFixture(env.workspaces.a).bigChange()
  await bigStream(page)

  // scroll the stream somewhere that is not the top, so the round trip has something to lose
  const stream = page.locator('.wb-panel .cv-stream')
  const before = await stream.evaluate((el) => {
    el.scrollTop = 1500
    return el.scrollTop
  })
  expect(before).toBeGreaterThan(1000)

  await newWebTab(page)
  await expect.poll(() => activeKind(page)).toBe('web')

  const layout = await layoutCost(page)
  const frame = await dragFrameAvg(page)
  expect(layout).toBeLessThan(LAYOUT_CEILING_MS)
  expect(frame).toBeLessThan(FRAME_AVG_CEILING_MS)

  await page.locator(WORKBENCH.tabFiles).click()
  await expect.poll(() => activeKind(page)).toBe('files')
  expect(await stream.evaluate((el) => el.scrollTop)).toBe(before)
})
