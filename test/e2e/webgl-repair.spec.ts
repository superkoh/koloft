import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { seedSettings } from './helpers/env'
import {
  openSessionTerminal,
  panelTerm,
  runIn,
  startSessionIn,
  termIds,
  waitBooted
} from './helpers/p1'

const MERGE_SIGNAL_REFRESH_SETTLE_MS = 500

function zshCjkColorStorm(doneMarker: string): string {
  return `for c in 31 32 33 34 35 36; do for i in {19968..23968}; do print -n "\\e[\${c}m\${(#)i}"; done; done; print "\\e[0m"; touch '${doneMarker}'`
}

async function writeAndPaint(page: Page, id: string, s: string): Promise<void> {
  await page.evaluate(
    ({ id, s }) =>
      new Promise<void>((done) => {
        const t = (
          window as unknown as {
            __koloftTerms: Record<string, { write(s: string, cb: () => void): void }>
          }
        ).__koloftTerms[id]
        t.write(s, () => requestAnimationFrame(() => requestAnimationFrame(() => done())))
      }),
    { id, s }
  )
}

const CJK_FIRST = 0x4e00
const ANSI_COLOURS_THAT_FORCE_PAGE_MERGES = [
  31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 95, 96, 37, 97, 90, 30
]
const CJK_PER_COLOUR = 6400
const CJK_PER_SCREEN = 800

async function paintCjkColourStorm(page: Page, id: string, offset: number): Promise<void> {
  for (const c of ANSI_COLOURS_THAT_FORCE_PAGE_MERGES) {
    for (let start = 0; start < CJK_PER_COLOUR; start += CJK_PER_SCREEN) {
      let s = `\x1b[2J\x1b[H\x1b[${c}m`
      for (let i = 0; i < CJK_PER_SCREEN; i++)
        s += String.fromCodePoint(CJK_FIRST + offset + start + i)
      await writeAndPaint(page, id, s + '\x1b[0m')
    }
  }
}

const ASCII_SCREEN =
  '\x1b[2J\x1b[H' +
  Array.from({ length: 20 }, () => 'The quick brown fox jumps over the lazy dog 0123456789').join(
    '\r\n'
  )

const INK_LUMINANCE_ABOVE_THE_DARK_BACKGROUND = 128

async function inkedPixels(page: Page, id: string): Promise<number> {
  const box = await page.evaluate((id) => {
    const el = (window as unknown as { __koloftTerms: Record<string, { element: HTMLElement }> })
      .__koloftTerms[id].element
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, id)
  const png = await page.screenshot({ clip: box })
  return page.evaluate(
    async ({ b64, luminance }) => {
      const bmp = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${b64}`)).blob()
      )
      const canvas = new OffscreenCanvas(bmp.width, bmp.height)
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) {
        if (0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2] > luminance) n++
      }
      return n
    },
    { b64: png.toString('base64'), luminance: INK_LUMINANCE_ABOVE_THE_DARK_BACKGROUND }
  )
}

// PLATFORM§20
async function wipeGlyphTexturesTheWayTheGpuLosesThem(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => {
    const t = (window as unknown as { __koloftTerms: Record<string, any> }).__koloftTerms[id]
    const renderer = t._core._renderService._renderer.value
    const gl = renderer._gl as WebGL2RenderingContext
    renderer._glyphRenderer.value._atlasTextures.forEach(
      (tex: { texture: WebGLTexture }, unit: number) => {
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, tex.texture)
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          1,
          1,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          new Uint8Array(4)
        )
      }
    )
    t.refresh(0, t.rows - 1)
  }, id)
}

async function sendWebglRepair(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('webgl:repair')
  })
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

  test('webgl:repair brings back glyphs the GPU lost even after heavy CJK output and an earlier repair have reshaped the shared atlas', async ({
    env
  }) => {
    test.setTimeout(180_000)
    delete env.launchEnv.KOLOFT_DOM_RENDERER
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const [tui] = await termIds(page)

      // PLATFORM§23
      await paintCjkColourStorm(page, tui, 3000)
      await sendWebglRepair(app)
      await paintCjkColourStorm(page, tui, 9000)
      await writeAndPaint(page, tui, ASCII_SCREEN)
      const drawn = await inkedPixels(page, tui)
      expect(drawn).toBeGreaterThan(0)

      await wipeGlyphTexturesTheWayTheGpuLosesThem(page, tui)
      await expect.poll(() => inkedPixels(page, tui)).toBeLessThan(drawn / 10)

      await sendWebglRepair(app)
      await expect.poll(() => inkedPixels(page, tui)).toBeGreaterThan(drawn * 0.9)
    } finally {
      await app.close().catch(() => {})
    }
  })
})
