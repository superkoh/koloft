import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from '../../test/e2e/helpers/app'
import { gitCommitAll, gitInit, sendShortcut, startSessionIn, waitBooted } from '../../test/e2e/helpers/p1'
import { artifactBody, openFileTab, showChanges, workbenchPanel } from '../../test/e2e/helpers/workbench'
import { setupChangeFixture } from '../../test/e2e/helpers/filesFixture'

const CHANGE_EVERY = 8
const NEEDLE = 'needle_far_down'
const NEEDLE_LINE = 3900
const SETTLE_MS = 3000
const WIDTH_STEPS = 10
const CHUNK_ROWS = 250
const DRAWN_CHUNKS = 2

const line = (i: number, tag: string): string =>
  i === NEEDLE_LINE
    ? `export const ${NEEDLE} = ${i}`
    : `export const value_${i} = ${i} // ${tag} filler text so the row has some width ${i}`

function fileText(lines: number, tag: (i: number) => string): string {
  return Array.from({ length: lines }, (_, k) => line(k + 1, tag(k + 1))).join('\n') + '\n'
}

async function armLongTasks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __lt: number[]; __ltObs?: PerformanceObserver }
    w.__ltObs?.disconnect()
    w.__lt = []
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__lt.push(e.duration)
    })
    obs.observe({ type: 'longtask' })
    w.__ltObs = obs
  })
}

async function readLongTasks(page: Page): Promise<{ n: number; sum: number; max: number }> {
  return page.evaluate(() => {
    const lt = (window as unknown as { __lt: number[] }).__lt
    return {
      n: lt.length,
      sum: Math.round(lt.reduce((a, b) => a + b, 0)),
      max: Math.round(Math.max(0, ...lt))
    }
  })
}

async function openBigDiff(
  page: Page,
  env: { workspaces: { a: string } } & Parameters<typeof openFileTab>[1],
  lines: number
): Promise<ReturnType<typeof artifactBody>> {
  const ws = env.workspaces.a
  const abs = path.join(ws, 'src', 'big.ts')
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, fileText(lines, () => 'old'))
  gitInit(ws)
  gitCommitAll(ws)
  fs.writeFileSync(abs, fileText(lines, (i) => (i % CHANGE_EVERY === 0 ? 'new' : 'old')))
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await armLongTasks(page)
  await openFileTab(page, env, abs)
  const idiff = artifactBody(page).locator('.idiff')
  await expect(idiff).toBeVisible()
  await expect.poll(() => idiff.locator('.idiff-code > span').count()).toBeGreaterThan(0)
  await page.waitForTimeout(SETTLE_MS)
  return idiff
}

async function widthSteps(idiff: ReturnType<typeof artifactBody>): Promise<number[]> {
  return idiff.evaluate((el, steps) => {
    const box = el as HTMLElement
    const start = box.getBoundingClientRect().width
    const times: number[] = []
    for (let s = 1; s <= steps; s++) {
      box.style.width = `${start - s * 4}px`
      const t0 = performance.now()
      void box.scrollHeight
      times.push(Math.round((performance.now() - t0) * 10) / 10)
    }
    box.style.width = ''
    void box.scrollHeight
    return times
  }, WIDTH_STEPS)
}

test('a 562-row diff (what a windowed 4,500-row diff would draw at once) costs this to open', async ({
  page,
  env
}) => {
  const idiff = await openBigDiff(page, env, 500)
  const open = await readLongTasks(page)
  const rows = await idiff.locator('.idiff-row').count()
  const width = await widthSteps(idiff)
  console.log(JSON.stringify({ small: { rows, open, width } }))
})

test('the 4,500-row diff with far rows swapped by hand for sized boxes holding hidden text: find, select-all, and drawing them back', async ({
  app,
  page,
  env
}) => {
  const idiff = await openBigDiff(page, env, 4000)
  const fullText = await idiff.evaluate((el) =>
    [...el.querySelectorAll('.idiff-row .idiff-code')].map((c) => c.textContent ?? '').join('\n')
  )
  const estimate = await idiff.evaluate((el) => {
    const box = el as HTMLElement
    const codes = [...box.querySelectorAll<HTMLElement>('.idiff-row .idiff-code')]
    const cs = getComputedStyle(codes[0])
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.font = `${cs.fontSize} ${cs.fontFamily}`
    const charW = ctx.measureText('x'.repeat(100)).width / 100
    const lineH = parseFloat(getComputedStyle(codes[0].parentElement!).lineHeight)
    const colW = codes[0].clientWidth - parseFloat(cs.paddingRight)
    const perLine = Math.max(1, Math.floor(colW / charW))
    let real = 0
    let est = 0
    let wrong = 0
    for (const c of codes) {
      const row = c.parentElement!
      const n = Math.max(1, Math.ceil((c.textContent ?? '').length / perLine))
      const e = n * lineH
      real += row.offsetHeight
      est += e
      if (Math.abs(row.offsetHeight - e) > 1) wrong++
    }
    return { charW, lineH, colW, perLine, rows: codes.length, real, est, rowsOff: wrong }
  })

  const surgery = await idiff.evaluate(
    (el, { chunkRows, drawnChunks }) => {
      const box = el as HTMLElement
      const rows = [...box.querySelectorAll<HTMLElement>(':scope > .idiff-row')]
      const chunks: { box: HTMLElement; rows: HTMLElement[] }[] = []
      let undrawnRows = 0
      for (let c = 0; c * chunkRows < rows.length; c++) {
        const slice = rows.slice(c * chunkRows, (c + 1) * chunkRows)
        const holder = document.createElement('div')
        holder.className = 'probe-chunk'
        box.insertBefore(holder, slice[0])
        if (c < drawnChunks) {
          holder.append(...slice)
        } else {
          const first = slice[0]
          const last = slice[slice.length - 1]
          const h = last.offsetTop + last.offsetHeight - first.offsetTop
          const hidden = document.createElement('div')
          hidden.hidden = true
          hidden.textContent = slice.map((r) => r.querySelector('.idiff-code')?.textContent ?? '').join('')
          slice.forEach((r) => r.remove())
          holder.style.height = `${h}px`
          holder.append(hidden)
          undrawnRows += slice.length
        }
        chunks.push({ box: holder, rows: slice })
      }
      ;(window as unknown as { __chunks: typeof chunks }).__chunks = chunks
      return { chunks: chunks.length, undrawnRows, drawnRows: box.querySelectorAll('.idiff-row').length }
    },
    { chunkRows: CHUNK_ROWS, drawnChunks: DRAWN_CHUNKS }
  )

  const width = await widthSteps(idiff)

  await idiff.locator('.idiff-row').nth(2).click()
  await sendShortcut(app, 'shortcut:find')
  const bar = page.locator('.find-bar')
  await expect(bar.locator('.find-input')).toBeFocused()
  await armLongTasks(page)
  await page.keyboard.type('value_')
  await expect(bar.locator('.find-count')).toHaveText(/\/\d+$/)
  await page.waitForTimeout(500)
  const commonFind = await readLongTasks(page)
  const commonCount = await bar.locator('.find-count').innerText()
  await armLongTasks(page)
  await page.evaluate(() => {
    const chunks = (window as unknown as { __chunks: { box: HTMLElement; rows: HTMLElement[] }[] })
      .__chunks
    const c = chunks[5]
    c.box.style.height = ''
    c.box.replaceChildren(...c.rows)
  })
  await page.waitForTimeout(500)
  const recomputeOnOneChunkDraw = await readLongTasks(page)
  await page.keyboard.press('Meta+a')
  await page.keyboard.type(NEEDLE)
  await expect(bar.locator('.find-count')).toHaveText('1/1')
  await page.waitForTimeout(500)
  const jump = await idiff.evaluate((el, needle) => {
    const box = el as HTMLElement
    const view = box.getBoundingClientRect()
    const chunks = (window as unknown as { __chunks: { box: HTMLElement }[] }).__chunks
    const holding = chunks.findIndex((c) => (c.box.textContent ?? '').includes(needle))
    const r = chunks[holding].box.getBoundingClientRect()
    return {
      scrollTop: box.scrollTop,
      chunkHoldingMatch: holding,
      chunkOnScreen: r.bottom > view.top && r.top < view.bottom
    }
  }, NEEDLE)
  await page.keyboard.press('Escape')
  await page.evaluate(() => document.getSelection()?.removeAllRanges())

  await idiff.evaluate((el) => {
    ;(el as HTMLElement).scrollTop = 0
  })
  await idiff.locator('.idiff-row').nth(2).click()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.selectAll()
  })
  await page.waitForTimeout(300)
  const describe = (): Record<string, unknown> => {
    const s = document.getSelection()
    const where = (n: Node | null | undefined, off: number | undefined): string => {
      if (!n) return 'none'
      const el = n.nodeType === Node.TEXT_NODE ? n.parentElement : (n as HTMLElement)
      const tag = `${n.nodeName}${el && el !== n ? ` in ${el.tagName}.${el.className}` : `.${(n as HTMLElement).className ?? ''}`}`
      const hiddenUp = !!el?.closest('[hidden]')
      return `${tag} @${off}${hiddenUp ? ' (inside hidden)' : ''}`
    }
    const text = s?.toString() ?? ''
    return {
      length: text.length,
      anchor: where(s?.anchorNode, s?.anchorOffset),
      focus: where(s?.focusNode, s?.focusOffset)
    }
  }
  const beforeDraw = await page.evaluate(describe)
  await page.evaluate(() => {
    const chunks = (window as unknown as { __chunks: { box: HTMLElement; rows: HTMLElement[] }[] })
      .__chunks
    for (const c of chunks) {
      if (c.box.querySelector('.idiff-row')) continue
      c.box.style.height = ''
      c.box.replaceChildren(...c.rows)
    }
  })
  const afterDraw = await page.evaluate(describe)
  const afterText = await page.evaluate(() => document.getSelection()?.toString() ?? '')

  console.log(
    JSON.stringify(
      {
        estimate,
        surgery,
        width,
        commonCount,
        commonFind,
        recomputeOnOneChunkDraw,
        jump,
        selectAll: {
          fullLength: fullText.length,
          beforeDraw,
          afterDraw,
          afterEqualsFull: afterText === fullText
        }
      },
      null,
      2
    )
  )
})

for (const title of [
  'Changes today: with ⌘F active on a match in the first block, scrolling down to a far block that then draws',
  'Changes today, control without find: scrolling down to a far block that then draws'
])
test(title, async ({
  app,
  page,
  env
}) => {
  test.slow()
  setupChangeFixture(env.workspaces.a).bigChange()
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
  await showChanges(page)
  const streamBox = page.locator('.wb-panel .cv-stream')
  const first = page.locator('.wb-panel .cv-blk[data-path="bulk/part-1.ts"]')
  const far = page.locator('.wb-panel .cv-blk[data-path="bulk/part-6.ts"]')
  await expect(far).toHaveCount(1, { timeout: 60_000 })
  await expect(first.locator('.idiff-row').first()).toBeVisible({ timeout: 60_000 })
  await expect(far.locator('.idiff-row')).toHaveCount(0)

  await first.locator('.idiff-row').first().click()
  const withFind = test.info().title.includes('⌘F')
  if (withFind) {
    await sendShortcut(app, 'shortcut:find')
    const bar = page.locator('.find-bar')
    await expect(bar.locator('.find-input')).toBeFocused()
    await page.keyboard.type('part1rewritten_')
    await expect(bar.locator('.find-count')).toHaveText(/^1\/\d+$/)
  } else {
    await first.locator('.idiff-row').nth(400).scrollIntoViewIfNeeded()
  }
  await page.waitForTimeout(500)
  const atMatch = await streamBox.evaluate((el) => el.scrollTop)

  const farTop = await far.evaluate((el) => (el as HTMLElement).offsetTop)
  await streamBox.evaluate((el, y) => {
    el.scrollTop = y
  }, farTop)
  await expect.poll(() => far.locator('.idiff-row').count(), { timeout: 30_000 }).toBeGreaterThan(0)
  await page.waitForTimeout(1500)
  const after = await streamBox.evaluate((el) => el.scrollTop)
  console.log(JSON.stringify({ changesYank: { withFind, atMatch, scrolledTo: farTop, after } }))
})
