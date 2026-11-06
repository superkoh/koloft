import fs from 'fs'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import {
  centerTerm,
  clickAppMenuItem,
  openSessionTerminal,
  setNextSessionTitle,
  startSessionIn,
  termIds,
  waitBooted
} from './helpers/p1'
import { WORKBENCH } from './helpers/workbench'

async function launchWithWebGL(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  delete env.launchEnv.KOLOFT_DOM_RENDERER
  seedSettings(env, { hintsOff: true })
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app, page }
}

async function expectDrawnByWebGL(page: Page, tabId: string): Promise<void> {
  const hasGlyphAtlas = await page.evaluate((id) => {
    const t = (window as unknown as { __koloftTerms: Record<string, unknown> }).__koloftTerms[
      id
    ] as {
      _core?: { _renderService?: { _renderer?: { value?: { _charAtlas?: unknown } } } }
    }
    return !!t?._core?._renderService?._renderer?.value?._charAtlas
  }, tabId)
  expect(hasGlyphAtlas, `${tabId} draws through the WebGL glyph atlas`).toBe(true)
}

async function writeTo(page: Page, tabId: string, text: string): Promise<void> {
  await page.evaluate(
    ({ id, text }) =>
      new Promise<void>((done) => {
        const t = (
          window as unknown as {
            __koloftTerms: Record<string, { write(s: string, cb: () => void): void }>
          }
        ).__koloftTerms[id]
        t.write(text, done)
      }),
    { id: tabId, text }
  )
}

async function pixelsOf(page: Page, tabId: string): Promise<Buffer> {
  const box = await page.evaluate((id) => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    const el = (window as unknown as { __koloftTerms: Record<string, { element?: HTMLElement }> })
      .__koloftTerms[id]?.element
    const r = el?.getBoundingClientRect()
    return r && r.width > 0 && r.height > 0
      ? { x: r.x, y: r.y, width: r.width, height: r.height }
      : null
  }, tabId)
  if (!box) throw new Error(`${tabId} is not on screen`)
  return page.screenshot({ clip: box })
}

const INK_BLOCK_PX = 8
const INK_LUMINANCE_ABOVE_THE_DARK_BACKGROUND = 128
const REDRAWN_GLYPHS_MAY_SHIFT_A_FEW_BLOCKS = 0.05

interface Picture {
  png: Buffer
  ink: string
  rowInk: number[]
}

async function pictureOf(page: Page, tabId: string): Promise<Picture> {
  const png = await pixelsOf(page, tabId)
  const { ink, rowInk } = await page.evaluate(
    async ({ b64, id, block, luminance }) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
      const bmp = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(bmp.width, bmp.height)
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const { data, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height)
      const rows = (window as unknown as { __koloftTerms: Record<string, { rows: number }> })
        .__koloftTerms[id].rows
      const bw = Math.ceil(width / block)
      const bh = Math.ceil(height / block)
      const blocks = new Uint8Array(bw * bh)
      const rowInk = new Array<number>(rows).fill(0)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4
          if (0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2] <= luminance) continue
          blocks[Math.floor(y / block) * bw + Math.floor(x / block)] = 1
          rowInk[Math.min(rows - 1, Math.floor((y * rows) / height))]++
        }
      }
      return { ink: blocks.join(''), rowInk }
    },
    {
      b64: png.toString('base64'),
      id: tabId,
      block: INK_BLOCK_PX,
      luminance: INK_LUMINANCE_ABOVE_THE_DARK_BACKGROUND
    }
  )
  return { png, ink, rowInk }
}

function inkDifference(a: Picture, b: Picture): number {
  let inked = 0
  let differing = 0
  for (let i = 0; i < a.ink.length; i++) {
    if (a.ink[i] === '1' || b.ink[i] === '1') inked++
    if (a.ink[i] !== b.ink[i]) differing++
  }
  return inked === 0 || a.ink.length !== b.ink.length ? 1 : differing / inked
}

async function settledPictureOf(page: Page, tabId: string): Promise<Picture> {
  let last: Picture | null = null
  await expect
    .poll(async () => {
      const now = await pictureOf(page, tabId).catch(() => null)
      const same = !!now && !!last && now.ink === last.ink
      last = now
      return same
    })
    .toBe(true)
  return last!
}

async function expectSamePictureAgain(page: Page, tabId: string, before: Picture): Promise<void> {
  let now: Picture | null = null
  try {
    await expect
      .poll(async () => {
        now = await pictureOf(page, tabId).catch(() => null)
        return !!now && inkDifference(now, before) <= REDRAWN_GLYPHS_MAY_SHIFT_A_FEW_BLOCKS
      })
      .toBe(true)
  } catch (e) {
    fs.writeFileSync(test.info().outputPath('before.png'), before.png)
    if (now) fs.writeFileSync(test.info().outputPath('after.png'), (now as Picture).png)
    throw e
  }
}

async function viewportRowOf(page: Page, tabId: string, needle: string): Promise<number> {
  return page.evaluate(
    ({ id, needle }) => {
      const t = (
        window as unknown as {
          __koloftTerms: Record<
            string,
            {
              rows: number
              buffer: {
                active: {
                  viewportY: number
                  getLine(i: number): { translateToString(): string } | undefined
                }
              }
            }
          >
        }
      ).__koloftTerms[id]
      const b = t.buffer.active
      for (let r = 0; r < t.rows; r++) {
        if (
          b
            .getLine(b.viewportY + r)
            ?.translateToString()
            .includes(needle)
        )
          return r
      }
      return -1
    },
    { id: tabId, needle }
  )
}

const CJK_FIRST = 0x4e00
const CJK_COUNT_THAT_FILLS_SEVERAL_ATLAS_PAGES = 4000
const ANSI_COLOURS = [31, 32, 33, 34, 35, 36]

function cjkColorStorm(): string {
  let s = ''
  for (const c of ANSI_COLOURS) {
    s += `\x1b[${c}m`
    for (let i = 0; i < CJK_COUNT_THAT_FILLS_SEVERAL_ATLAS_PAGES; i++) {
      s += String.fromCodePoint(CJK_FIRST + i)
    }
  }
  return s + '\x1b[0m'
}

function rowTitled(page: Page, title: string) {
  return page
    .locator('.ws .ws-tab')
    .filter({ has: page.locator('.ws-tab-title', { hasText: title }) })
}

test.describe('the WebGL terminal users run (the suite otherwise draws with the DOM renderer): common moves leave it drawn, judged by where its screenshot has ink', () => {
  test('switching to another session and back shows the same picture when nothing changed, and the new line when one arrived while it was hidden', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const { app, page } = await launchWithWebGL(env)
    try {
      setNextSessionTitle(env, 'S1')
      await startSessionIn(page, 'ws-a')
      const [s1] = await termIds(page)
      setNextSessionTitle(env, 'S2')
      await startSessionIn(page, 'ws-a')
      await expectDrawnByWebGL(page, s1)

      await rowTitled(page, 'S1').click()
      await expect(rowTitled(page, 'S1')).toHaveClass(/active/)
      await writeTo(page, s1, '\r\nwebgl-before-switch\r\n')
      const before = await settledPictureOf(page, s1)

      await rowTitled(page, 'S2').click()
      await expect(rowTitled(page, 'S2')).toHaveClass(/active/)
      await rowTitled(page, 'S1').click()
      await expect(rowTitled(page, 'S1')).toHaveClass(/active/)
      await expectSamePictureAgain(page, s1, before)

      await rowTitled(page, 'S2').click()
      await expect(rowTitled(page, 'S2')).toHaveClass(/active/)
      await writeTo(page, s1, 'webgl-written-while-hidden\r\n')
      await rowTitled(page, 'S1').click()
      await expect(rowTitled(page, 'S1')).toHaveClass(/active/)
      const row = await viewportRowOf(page, s1, 'webgl-written-while-hidden')
      expect(row).toBeGreaterThanOrEqual(0)
      const after = await settledPictureOf(page, s1)
      expect(after.rowInk[row]).toBeGreaterThan(2 * before.rowInk[row])
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('the Workbench going full width over the session terminal and back leaves the terminal painted as before', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const { app, page } = await launchWithWebGL(env)
    try {
      await startSessionIn(page, 'ws-a')
      const [tui] = await termIds(page)
      await expectDrawnByWebGL(page, tui)
      await writeTo(page, tui, '\r\nwebgl-before-full-width\r\n')
      const before = await settledPictureOf(page, tui)

      await clickAppMenuItem(app, page, 'toggle-focus-mode')
      await expect(centerTerm(page)).toBeHidden()
      await clickAppMenuItem(app, page, 'toggle-focus-mode')
      await expect(centerTerm(page)).toBeVisible()
      await expectSamePictureAgain(page, tui, before)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('opening a Workbench shell, filling it with new glyphs and closing it leaves the session terminal painted as before', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const { app, page } = await launchWithWebGL(env)
    try {
      await startSessionIn(page, 'ws-a')
      const [tui] = await termIds(page)
      await writeTo(page, tui, '\r\nwebgl-before-shell\r\n')

      await openSessionTerminal(app, page)
      const shell = (await termIds(page)).find((id) => id !== tui)!
      await expectDrawnByWebGL(page, tui)
      await expectDrawnByWebGL(page, shell)
      const before = await settledPictureOf(page, tui)

      // PLATFORM§23
      await writeTo(page, shell, cjkColorStorm() + '\r\nwebgl-shell-done\r\n')
      await expect
        .poll(() => viewportRowOf(page, shell, 'webgl-shell-done'))
        .toBeGreaterThanOrEqual(0)
      await page
        .locator(`${WORKBENCH.panel} .wb-tab:not(.pinned)`)
        .locator(WORKBENCH.tabCloseIn)
        .click()
      await expect(page.locator('.wb-panel .wb-term')).toHaveCount(0, { timeout: 20_000 })

      await expectSamePictureAgain(page, tui, before)
    } finally {
      await app.close().catch(() => {})
    }
  })
})
