import type { Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import {
  growWindowHeightBy,
  launchWithWebGL,
  readAllCalls,
  rowTitled,
  setNextSessionTitle,
  startSessionIn,
  switchToRow,
  terminalText,
  termIds,
  writeTo
} from './helpers/p1'

const REPAINT_BUDGET_UNDER_1S_SYNC_SAFETY_TIMEOUT_MS = 600
const SYNC_FRAME_NEVER_CLOSED_REPAINT_BUDGET_MS = 1600
const FIT_DONE_WELL_INSIDE_XTERMS_1S_SYNC_TIMEOUT_MS = 300
const WIDE_LINE = '中文宽字符一帧画完再显示'

type Term = {
  rows: number
  cols: number
  element?: HTMLElement
  dimensions?: { css: { cell: { height: number } } }
  onRender(cb: () => void): void
  buffer: { active: { viewportY: number; baseY: number } }
  _core?: { coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } } }
}

async function countRenders(page: Page, id: string): Promise<void> {
  await page.evaluate((tabId) => {
    const w = window as unknown as {
      __koloftTerms: Record<string, Term>
      __renders?: Record<string, number>
    }
    w.__renders ??= {}
    w.__renders[tabId] = 0
    w.__koloftTerms[tabId].onRender(() => {
      w.__renders![tabId] += 1
    })
  }, id)
}

function rendersOf(page: Page, id: string): Promise<number> {
  return page.evaluate(
    (tabId) => (window as unknown as { __renders: Record<string, number> }).__renders[tabId],
    id
  )
}

function screenOf(
  page: Page,
  id: string
): Promise<{
  onScreen: boolean
  syncOpen: boolean
  atBottom: boolean
  cols: number
  rows: number
}> {
  return page.evaluate((tabId) => {
    const t = (window as unknown as { __koloftTerms: Record<string, Term> }).__koloftTerms[tabId]
    return {
      onScreen: (t.element?.clientHeight ?? 0) > 0,
      syncOpen: t._core?.coreService?.decPrivateModes?.synchronizedOutput === true,
      atBottom: t.buffer.active.viewportY === t.buffer.active.baseY,
      cols: t.cols,
      rows: t.rows
    }
  }, id)
}

test("a Claude Code tab's claude starts told to wrap every frame in sync output and scroll by region, without the Apple_Terminal name that keeps it from asking; a fit landing inside a sync window still repaints promptly, with no second of black terminal on resize", async ({
  env
}) => {
  const { app, page } = await launchWithWebGL(env)
  try {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await startSessionIn(page, 'ws-a')
    const launches = readAllCalls(env)
    expect(launches.length).toBeGreaterThan(0)
    for (const l of launches) {
      expect(l.forceSyncOutput).toBe('1')
      expect(l.decstbm).toBe('1')
      expect(l.termProgram).toBeNull()
    }
    const [tab] = await termIds(page)
    await countRenders(page, tab)
    expect((await screenOf(page, tab)).rows).toBeGreaterThan(4)
    await writeTo(page, tab, `\r\n${WIDE_LINE}\r\n`)

    const fitRenderDelay = async (dh: number): Promise<number> => {
      const mark = await rendersOf(page, tab)
      await growWindowHeightBy(app, dh)
      const t0 = Date.now()
      await expect
        .poll(() => rendersOf(page, tab), { timeout: 3000, intervals: [20] })
        .toBeGreaterThan(mark)
      return Date.now() - t0
    }

    const controlDelay = await fitRenderDelay(-80)
    expect(controlDelay).toBeLessThan(REPAINT_BUDGET_UNDER_1S_SYNC_SAFETY_TIMEOUT_MS)

    // PLATFORM§21 CC§12
    await writeTo(page, tab, '\x1b[?2026h')
    const bugDelay = await fitRenderDelay(80)
    expect(bugDelay).toBeLessThan(REPAINT_BUDGET_UNDER_1S_SYNC_SAFETY_TIMEOUT_MS)
    expect(await terminalText(page, tab)).toContain(WIDE_LINE)
    expect((await screenOf(page, tab)).atBottom).toBe(true)

    expect(errors).toEqual([])
  } finally {
    await app.close().catch(() => {})
  }
})

test("a fit or a re-show that keeps the terminal's size leaves an open sync frame unpainted until claude closes it, or for at most a second when it never does", async ({
  env
}) => {
  test.setTimeout(180_000)
  const { app, page } = await launchWithWebGL(env)
  try {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    setNextSessionTitle(env, 'S1')
    await startSessionIn(page, 'ws-a')
    const [s1] = await termIds(page)
    setNextSessionTitle(env, 'S2')
    await startSessionIn(page, 'ws-a')
    await switchToRow(page, rowTitled(page, 'S1'))
    await countRenders(page, s1)
    await writeTo(page, s1, `\r\n${WIDE_LINE}\r\n`)
    const size = await screenOf(page, s1)

    const expectFrameHeld = async (renders: number): Promise<void> => {
      const now = await screenOf(page, s1)
      expect(now.onScreen).toBe(true)
      expect(now.syncOpen, 'the sync frame is still open').toBe(true)
      expect({ cols: now.cols, rows: now.rows }).toEqual({ cols: size.cols, rows: size.rows })
      expect(await rendersOf(page, s1), 'nothing painted inside the frame').toBe(renders)
    }
    const expectWholeFramePainted = async (renders: number, line: string): Promise<void> => {
      await expect.poll(() => rendersOf(page, s1)).toBeGreaterThan(renders)
      const now = await screenOf(page, s1)
      expect(now.syncOpen).toBe(false)
      expect(now.atBottom).toBe(true)
      const text = await terminalText(page, s1)
      expect(text).toContain(WIDE_LINE)
      expect(text).toContain(line)
    }

    // PLATFORM§21 CC§12
    const heightLeavingTheRowCountAlone = await page.evaluate((tabId) => {
      const t = (window as unknown as { __koloftTerms: Record<string, Term> }).__koloftTerms[tabId]
      const spare = t.element!.parentElement!.clientHeight % t.dimensions!.css.cell.height
      return spare >= 2 ? -1 : 1
    }, s1)
    await writeTo(page, s1, `\x1b[?2026h半帧-甲\r\n`)
    let renders = await rendersOf(page, s1)
    await growWindowHeightBy(app, heightLeavingTheRowCountAlone)
    await page.waitForTimeout(FIT_DONE_WELL_INSIDE_XTERMS_1S_SYNC_TIMEOUT_MS)
    await expectFrameHeld(renders)
    await writeTo(page, s1, '\x1b[?2026l')
    await expectWholeFramePainted(renders, '半帧-甲')

    await switchToRow(page, rowTitled(page, 'S2'))
    await writeTo(page, s1, `\x1b[?2026h半帧-乙\r\n`)
    renders = await rendersOf(page, s1)
    await rowTitled(page, 'S1').click()
    await page.waitForTimeout(FIT_DONE_WELL_INSIDE_XTERMS_1S_SYNC_TIMEOUT_MS)
    await expectFrameHeld(renders)
    await expect(rowTitled(page, 'S1')).toHaveClass(/\bactive\b/)
    await writeTo(page, s1, '\x1b[?2026l')
    await expectWholeFramePainted(renders, '半帧-乙')

    await switchToRow(page, rowTitled(page, 'S2'))
    await writeTo(page, s1, `\x1b[?2026h半帧-丙\r\n`)
    renders = await rendersOf(page, s1)
    const shownAt = Date.now()
    await switchToRow(page, rowTitled(page, 'S1'))
    await expect
      .poll(() => rendersOf(page, s1), {
        timeout: SYNC_FRAME_NEVER_CLOSED_REPAINT_BUDGET_MS,
        intervals: [20]
      })
      .toBeGreaterThan(renders)
    expect(Date.now() - shownAt).toBeLessThan(SYNC_FRAME_NEVER_CLOSED_REPAINT_BUDGET_MS)
    await expectWholeFramePainted(renders, '半帧-丙')

    expect(errors).toEqual([])
  } finally {
    await app.close().catch(() => {})
  }
})
