import fs from 'fs'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from '../e2e/helpers/app'
import { seedSettings } from '../e2e/helpers/env'
import {
  centerTerm,
  clickAppMenuItem,
  setNextSessionTitle,
  startSessionIn,
  termIds,
  waitBooted
} from '../e2e/helpers/p1'
import { bringFinderToFront, dockItemCenter, realClick, screenshotOf } from './helpers/macInput'

test.skip(process.env.KOLOFT_REAL_WINDOW !== '1', 'real-window only')

const rowTitled = (page: Page, title: string) =>
  page.locator('.ws-tab').filter({ has: page.locator('.ws-tab-title', { hasText: title }) })

async function termRect(app: ElectronApplication, page: Page) {
  const content = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getContentBounds()
  )
  const box = (await centerTerm(page).boundingBox())!
  return {
    x: Math.round(content.x + box.x),
    y: Math.round(content.y + box.y),
    width: Math.round(box.width),
    height: Math.round(box.height)
  }
}

async function inkOf(page: Page, png: Buffer): Promise<string> {
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
    const bmp = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height)
    const block = 16
    const bw = Math.ceil(width / block)
    const blocks = new Uint8Array(bw * Math.ceil(height / block))
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        if (0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2] > 128)
          blocks[Math.floor(y / block) * bw + Math.floor(x / block)] = 1
      }
    return blocks.join('')
  }, png.toString('base64'))
}

function difference(a: string, b: string): number {
  let inked = 0
  let differing = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '1' || b[i] === '1') inked++
    if (a[i] !== b[i]) differing++
  }
  return inked === 0 || a.length !== b.length ? 1 : differing / inked
}

test('PROBE: WebGL session terminal on a real screen after switch, minimize, full-width Workbench and being covered', async ({
  env
}, testInfo) => {
  test.setTimeout(240_000)
  delete env.launchEnv.KOLOFT_DOM_RENDERER
  env.launchEnv.KOLOFT_TEST_REAL_WINDOW = '1'
  seedSettings(env, { hintsOff: true })
  const app = await launchApp(env)
  const page = await app.firstWindow()
  const results: Record<string, number> = {}
  const grab = async (name: string): Promise<string> => {
    const file = testInfo.outputPath(`${name}.png`)
    const rect = await termRect(app, page)
    const content = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getContentBounds()
    )
    await page.mouse.move(rect.x - content.x + rect.width / 2, rect.y - content.y + 4)
    await page.waitForTimeout(500)
    screenshotOf(file, rect)
    return inkOf(page, fs.readFileSync(file))
  }
  try {
    await waitBooted(page)
    setNextSessionTitle(env, 'S1')
    await startSessionIn(page, 'ws-a')
    const [s1] = await termIds(page)
    setNextSessionTitle(env, 'S2')
    await startSessionIn(page, 'ws-a')
    await rowTitled(page, 'S1').click()
    await page.evaluate(
      ([id]) =>
        (
          window as unknown as { __koloftTerms: Record<string, { write(s: string): void }> }
        ).__koloftTerms[id].write('\r\n' + 'webgl 你好 ' + 'abcdefghij'.repeat(30) + '\r\n'),
      [s1]
    )
    await page.waitForTimeout(1500)
    const before = await grab('0-before')

    await rowTitled(page, 'S2').click()
    await page.waitForTimeout(800)
    await rowTitled(page, 'S1').click()
    await page.waitForTimeout(1500)
    results.switchedAwayAndBack = difference(before, await grab('1-switched'))

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
    await page.waitForTimeout(3000)
    realClick(dockItemCenter('Electron'))
    await page.waitForTimeout(2500)
    results.minimizedAndRestored = difference(before, await grab('2-restored'))

    await clickAppMenuItem(app, page, 'toggle-focus-mode')
    await expect(centerTerm(page)).toBeHidden()
    await clickAppMenuItem(app, page, 'toggle-focus-mode')
    await expect(centerTerm(page)).toBeVisible()
    await page.waitForTimeout(1500)
    results.fullWidthWorkbenchAndBack = difference(before, await grab('3-full-width-back'))

    bringFinderToFront()
    await page.waitForTimeout(3000)
    realClick(dockItemCenter('Electron'))
    await page.waitForTimeout(2500)
    results.coveredAndBack = difference(before, await grab('4-covered-back'))
  } finally {
    fs.writeFileSync(testInfo.outputPath('differences.json'), JSON.stringify(results, null, 2))
    console.log('WEBGL PROBE', JSON.stringify(results))
    await quitAndClose(app)
  }
})
