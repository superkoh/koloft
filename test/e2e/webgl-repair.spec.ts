import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import { openSessionTerminal, panelTerm, runIn, startSessionIn, waitBooted } from './helpers/p1'

const MERGE_SIGNAL_REFRESH_SETTLE_MS = 500

function zshCjkColorStorm(doneMarker: string): string {
  return `for c in 31 32 33 34 35 36; do for i in {19968..23968}; do print -n "\\e[\${c}m\${(#)i}"; done; done; print "\\e[0m"; touch '${doneMarker}'`
}

test.describe('webgl:repair after OS resume or a display change: clear the shared glyph atlas and repaint every live WebGL tab', () => {
  test('webgl:repair repaints every live tab sharing one atlas without breaking the terminal', async ({
    env
  }) => {
    test.setTimeout(180_000)
    delete env.launchEnv.KOLOFT_DOM_RENDERER

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(String(e)))

      await expect(page.locator('.center')).toContainText('No running session', {
        timeout: 20_000
      })
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')

      await openSessionTerminal(app, page)
      await openSessionTerminal(app, page)
      await expect(page.locator('.wb-panel .wb-term')).toHaveCount(2, { timeout: 30_000 })

      const marker = path.join(env.home, 'repair-marker')
      await runIn(page, panelTerm(page), `touch '${marker}.before'`)
      await expect.poll(() => fs.existsSync(`${marker}.before`), { timeout: 15_000 }).toBe(true)

      await app.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send('webgl:repair')
      })

      await runIn(page, panelTerm(page), `touch '${marker}.after'`)
      await expect.poll(() => fs.existsSync(`${marker}.after`), { timeout: 15_000 }).toBe(true)

      expect(errors).toEqual([])
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('atlas page-merge stress: 24k distinct CJK glyph keys, far past the atlas page cap, break nothing', async ({
    env
  }) => {
    test.setTimeout(180_000)
    delete env.launchEnv.KOLOFT_DOM_RENDERER

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(String(e)))

      await expect(page.locator('.center')).toContainText('No running session', {
        timeout: 20_000
      })
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      await openSessionTerminal(app, page)

      const marker = path.join(env.home, 'stress-marker')
      // PLATFORM§23
      await runIn(page, panelTerm(page), zshCjkColorStorm(marker))
      await expect.poll(() => fs.existsSync(marker), { timeout: 30_000 }).toBe(true)

      await page.waitForTimeout(MERGE_SIGNAL_REFRESH_SETTLE_MS)

      await runIn(page, panelTerm(page), `touch '${marker}.after'`)
      await expect.poll(() => fs.existsSync(`${marker}.after`), { timeout: 15_000 }).toBe(true)

      expect(errors).toEqual([])
    } finally {
      await app.close().catch(() => {})
    }
  })
})
