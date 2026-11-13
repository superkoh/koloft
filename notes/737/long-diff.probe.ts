import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from '../../test/e2e/helpers/app'
import { gitCommitAll, gitInit, sendShortcut, startSessionIn, waitBooted } from '../../test/e2e/helpers/p1'
import { artifactBody, openFileTab } from '../../test/e2e/helpers/workbench'

const FILE_LINES = 4000
const CHANGE_EVERY = 8
const NEEDLE = 'needle_far_down'
const NEEDLE_LINE = 3900
const SETTLE_MS = 3000
const WIDTH_STEPS = 10

const line = (i: number, tag: string): string =>
  i === NEEDLE_LINE
    ? `export const ${NEEDLE} = ${i}`
    : `export const value_${i} = ${i} // ${tag} filler text so the row has some width ${i}`

function fileText(tag: (i: number) => string): string {
  return Array.from({ length: FILE_LINES }, (_, k) => line(k + 1, tag(k + 1))).join('\n') + '\n'
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

test('measure a 4,500-row inline diff: open, change on disk, width step, select-all, find', async ({
  app,
  page,
  env
}) => {
  const ws = env.workspaces.a
  const rel = path.join('src', 'big.ts')
  const abs = path.join(ws, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, fileText(() => 'old'))
  gitInit(ws)
  gitCommitAll(ws)
  fs.writeFileSync(abs, fileText((i) => (i % CHANGE_EVERY === 0 ? 'new' : 'old')))

  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await armLongTasks(page)
  await openFileTab(page, env, abs)
  const idiff = artifactBody(page).locator('.idiff')
  await expect(idiff).toBeVisible()
  await expect.poll(() => idiff.locator('.idiff-code > span').count()).toBeGreaterThan(0)
  await page.waitForTimeout(SETTLE_MS)
  const rowCount = await idiff.locator('.idiff-row').count()
  const open = await readLongTasks(page)
  const framesRun = await page.evaluate(
    () =>
      new Promise<boolean>((res) => {
        const t = setTimeout(() => res(false), 1000)
        requestAnimationFrame(() => {
          clearTimeout(t)
          res(true)
        })
      })
  )
  const relayoutAll = await idiff.evaluate((el) => {
    const box = el as HTMLElement
    box.style.fontSize = '12.6px'
    const t0 = performance.now()
    void box.scrollHeight
    const ms = performance.now() - t0
    box.style.fontSize = ''
    void box.scrollHeight
    return Math.round(ms)
  })

  await armLongTasks(page)
  fs.writeFileSync(abs, fileText((i) => (i % CHANGE_EVERY === 0 || i % 397 === 0 ? 'new' : 'old')))
  await expect(idiff.locator('.idiff-row', { hasText: 'new filler text so the row has some width 397' })).toHaveCount(
    1
  )
  await page.waitForTimeout(SETTLE_MS)
  const onDisk = await readLongTasks(page)

  const width = await idiff.evaluate((el, steps) => {
    const box = el as HTMLElement
    const start = box.getBoundingClientRect().width
    const times: number[] = []
    for (let s = 1; s <= steps; s++) {
      box.style.width = `${start - s * 4}px`
      const t0 = performance.now()
      void box.scrollHeight
      times.push(performance.now() - t0)
    }
    box.style.width = ''
    return { start, times: times.map((t) => Math.round(t * 10) / 10) }
  }, WIDTH_STEPS)

  await idiff.locator('.idiff-row').nth(2).click()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.selectAll()
  })
  await page.waitForTimeout(500)
  const sel = await page.evaluate(() => {
    const s = document.getSelection()
    const text = s?.toString() ?? ''
    const box = document.querySelector('.wb-artifact:not([style*="hidden"]) .idiff')
    return {
      type: s?.type,
      length: text.length,
      lines: text.split('\n').length,
      head: text.slice(0, 160),
      tail: text.slice(-160),
      anchorInDiff: !!(s?.anchorNode && box?.contains(s.anchorNode)),
      focusInDiff: !!(s?.focusNode && box?.contains(s.focusNode)),
      nbsp: (text.match(/ /g) ?? []).length
    }
  })
  const selText = await page.evaluate(() => document.getSelection()?.toString() ?? '')
  const rowTexts = await idiff.evaluate((el) =>
    [...el.querySelectorAll('.idiff-row .idiff-code')].map((c) => (c as HTMLElement).textContent ?? '')
  )
  const fromRows = rowTexts.join('\n')
  fs.writeFileSync(test.info().outputPath('selection.txt'), selText)
  fs.writeFileSync(test.info().outputPath('rows-joined.txt'), fromRows)
  const selMatchesRows = selText === fromRows
  await page.evaluate(() => document.getSelection()?.removeAllRanges())

  await idiff.locator('.idiff-row').nth(2).click()
  const topBefore = await idiff.evaluate((el) => el.scrollTop)
  await sendShortcut(app, 'shortcut:find')
  const bar = page.locator('.find-bar')
  await expect(bar.locator('.find-input')).toBeFocused()
  await armLongTasks(page)
  await page.keyboard.type(NEEDLE)
  await expect(bar.locator('.find-count')).toHaveText('1/1')
  await page.waitForTimeout(500)
  const topAfter = await idiff.evaluate((el) => el.scrollTop)
  const find = await readLongTasks(page)
  await page.keyboard.press('Escape')
  await armLongTasks(page)
  await bar.locator('.find-input').focus().catch(() => {})
  await sendShortcut(app, 'shortcut:find')
  await expect(bar.locator('.find-input')).toBeFocused()
  await page.keyboard.press('Meta+a')
  await page.keyboard.type('value_')
  await expect(bar.locator('.find-count')).toHaveText(/\/\d+$/)
  await page.waitForTimeout(500)
  const commonCount = await bar.locator('.find-count').innerText()
  const commonFind = await readLongTasks(page)

  console.log(
    JSON.stringify(
      { rowCount, open, framesRun, relayoutAll, selMatchesRows, onDisk, width, sel, find: { topBefore, topAfter, ...find }, commonCount, commonFind },
      null,
      2
    )
  )
})
