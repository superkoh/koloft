import type { Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import { startSessionIn, waitBooted } from './helpers/p1'
import { setupChangeFixture } from './helpers/filesFixture'
import { WORKBENCH, workbenchIcon, workbenchPanel } from './helpers/workbench'
import { newWebTab, activeKind } from './helpers/browser'

const LAYOUT_STEP_CEILING_BETWEEN_MEASURED_17_FIXED_AND_73_UNFIXED_MS = 45
const DRAG_FRAME_AVG_CEILING_BETWEEN_MEASURED_14_FIXED_AND_60_UNFIXED_MS = 35
const SIDEBAR_DRAG_COMMITS_CEILING_BETWEEN_MEASURED_FIXED_AND_UNFIXED = 20
const SIDEBAR_DRAG_PX = 160

test.describe('Sidebar edge drag writes the width, not the store, on each mouse move', () => {
  test('dragging the sidebar edge resizes it live, saves the width once on release, and re-renders the app only a few times', async ({
    page
  }) => {
    await startSessionIn(page, 'ws-a')
    await page.addInitScript(() => {
      const w = window as unknown as { __commits: number; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }
      w.__commits = 0
      w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        checkDCE: () => {},
        onScheduleFiberRoot: () => {},
        onCommitFiberUnmount: () => {},
        onPostCommitFiberRoot: () => {},
        onCommitFiberRoot: () => {
          w.__commits++
        }
      }
    })
    await page.reload()
    await waitBooted(page)

    const side = page.locator('.side')
    const start = (await side.boundingBox())!.width
    const grip = (await page.locator('.side-grip').boundingBox())!
    const x = grip.x + grip.width / 2
    const y = grip.y + grip.height / 2
    await page.evaluate(() => {
      ;(window as unknown as { __commits: number }).__commits = 0
    })
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + SIDEBAR_DRAG_PX, y, { steps: 30 })
    const far = (await side.boundingBox())!.width
    expect(far, 'the width follows the mouse during the drag').toBeGreaterThan(
      start + SIDEBAR_DRAG_PX / 2
    )
    await page.mouse.move(x + SIDEBAR_DRAG_PX / 2, y, { steps: 30 })
    await page.mouse.up()
    const commits = await page.evaluate(
      () => (window as unknown as { __commits: number }).__commits
    )
    console.log(`RESIZE-PERF sidebar drag: ${commits} React commits over 60 mouse moves`)

    const end = (await side.boundingBox())!.width
    expect(far - end).toBeCloseTo(SIDEBAR_DRAG_PX / 2, 0)
    await expect
      .poll(() => page.evaluate(() => window.api.settings.get().then((s) => s.sidebarWidth)))
      .toBeCloseTo(end, 0)
    expect(commits, 'the sidebar drag must write the DOM, not the store').toBeLessThan(
      SIDEBAR_DRAG_COMMITS_CEILING_BETWEEN_MEASURED_FIXED_AND_UNFIXED
    )
  })
})

test.describe('Workbench gutter drag over a large Changes stream stays smooth', () => {
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

  async function layoutCost(page: Page): Promise<number> {
    const times = await page.evaluate(() => {
      const col = document.querySelector<HTMLElement>('.wb-col')!
      const start = col.offsetWidth
      const out: number[] = []
      for (let i = 0; i < 10; i++) {
        col.style.width = `${start + (i % 2 ? 40 : -40)}px`
        const t0 = performance.now()
        void col.offsetHeight
        out.push(performance.now() - t0)
      }
      col.style.width = `${start}px`
      void col.offsetHeight
      return out
    })
    const avg = times.reduce((a, b) => a + b, 0) / times.length
    console.log(
      `RESIZE-PERF layout per step: avg ${avg.toFixed(1)}ms max ${Math.max(...times).toFixed(1)}ms`
    )
    return avg
  }

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
    console.log(
      `RESIZE-PERF drag frame gap: avg ${avg.toFixed(1)}ms worst ${worst.toFixed(1)}ms (not pinned: the first frame pays for the resize gate) over ${gaps.length} frames`
    )
    return avg
  }

  test('resizing the Workbench over a large change set stays smooth', async ({ page, env }) => {
    test.setTimeout(240_000)
    setupChangeFixture(env.workspaces.a).bigChange()
    await bigStream(page)

    const layout = await layoutCost(page)
    const frame = await dragFrameAvg(page)
    expect(layout, 'off-screen change blocks must stay out of layout').toBeLessThan(
      LAYOUT_STEP_CEILING_BETWEEN_MEASURED_17_FIXED_AND_73_UNFIXED_MS
    )
    expect(frame, 'the gutter drag must write the DOM, not the store').toBeLessThan(
      DRAG_FRAME_AVG_CEILING_BETWEEN_MEASURED_14_FIXED_AND_60_UNFIXED_MS
    )
  })

  test('resizing with the change set hidden behind a web tab is just as smooth, and the hidden stream keeps its scroll so it is never display:none', async ({
    page,
    env
  }) => {
    test.setTimeout(240_000)
    setupChangeFixture(env.workspaces.a).bigChange()
    await bigStream(page)

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
    expect(layout, 'off-screen change blocks must stay out of layout').toBeLessThan(
      LAYOUT_STEP_CEILING_BETWEEN_MEASURED_17_FIXED_AND_73_UNFIXED_MS
    )
    expect(frame, 'the gutter drag must write the DOM, not the store').toBeLessThan(
      DRAG_FRAME_AVG_CEILING_BETWEEN_MEASURED_14_FIXED_AND_60_UNFIXED_MS
    )

    await page.locator(WORKBENCH.tabFiles).click()
    await expect.poll(() => activeKind(page)).toBe('files')
    expect(await stream.evaluate((el) => el.scrollTop)).toBe(before)
  })
})
