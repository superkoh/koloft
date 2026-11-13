import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from '../../test/e2e/helpers/app'
import { gitCommitAll, gitInit, startSessionIn, waitBooted } from '../../test/e2e/helpers/p1'
import { artifactBody, openFileTab } from '../../test/e2e/helpers/workbench'

const FILE_LINES = 4000
const CHANGE_EVERY = 8
const SETTLE_MS = 3000
const CHUNK_ROWS = 250
const DRAWN_CHUNKS = 2
const DRAG_PX = 200
const DRAG_STEPS = 30

const line = (i: number, tag: string): string =>
  `export const value_${i} = ${i} // ${tag} filler text so the row has some width ${i}`

function fileText(tag: (i: number) => string): string {
  return Array.from({ length: FILE_LINES }, (_, k) => line(k + 1, tag(k + 1))).join('\n') + '\n'
}

async function dragFrames(page: Page): Promise<{ frames: number; avg: number; worst: number; over50: number }> {
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
  await page.mouse.move(box.x - DRAG_PX, box.y + box.height / 2, { steps: DRAG_STEPS })
  await page.mouse.move(box.x, box.y + box.height / 2, { steps: DRAG_STEPS })
  await page.mouse.up()
  const gaps = await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __stop: boolean }
    w.__stop = true
    return w.__gaps.slice(1)
  })
  return {
    frames: gaps.length,
    avg: Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10,
    worst: Math.round(Math.max(...gaps)),
    over50: gaps.filter((g) => g > 50).length
  }
}

test('dragging the Workbench divider with a 4,500-row diff open: fully drawn, then with far chunks swapped by hand for hidden-text boxes', async ({
  page,
  env
}) => {
  const ws = env.workspaces.a
  const abs = path.join(ws, 'src', 'big.ts')
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, fileText(() => 'old'))
  gitInit(ws)
  gitCommitAll(ws)
  fs.writeFileSync(abs, fileText((i) => (i % CHANGE_EVERY === 0 ? 'new' : 'old')))
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await openFileTab(page, env, abs)
  const idiff = artifactBody(page).locator('.idiff')
  await expect(idiff).toBeVisible()
  await expect.poll(() => idiff.locator('.idiff-code > span').count()).toBeGreaterThan(0)
  await page.waitForTimeout(SETTLE_MS)

  const fullyDrawn = [await dragFrames(page), await dragFrames(page)]

  await idiff.evaluate(
    (el, { chunkRows, drawnChunks }) => {
      const box = el as HTMLElement
      const rows = [...box.querySelectorAll<HTMLElement>(':scope > .idiff-row')]
      for (let c = drawnChunks; c * chunkRows < rows.length; c++) {
        const slice = rows.slice(c * chunkRows, (c + 1) * chunkRows)
        const first = slice[0]
        const last = slice[slice.length - 1]
        const holder = document.createElement('div')
        holder.style.height = `${last.offsetTop + last.offsetHeight - first.offsetTop}px`
        const hidden = document.createElement('div')
        hidden.hidden = true
        hidden.textContent = slice.map((r) => r.querySelector('.idiff-code')?.textContent ?? '').join('')
        holder.append(hidden)
        box.insertBefore(holder, first)
        slice.forEach((r) => r.remove())
      }
    },
    { chunkRows: CHUNK_ROWS, drawnChunks: DRAWN_CHUNKS }
  )
  const handWindowed = [await dragFrames(page), await dragFrames(page)]

  console.log(JSON.stringify({ fullyDrawn, handWindowed }, null, 2))
})
