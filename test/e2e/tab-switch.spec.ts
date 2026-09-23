import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  sendShortcut,
  setNextSessionTitle,
  startSessionIn,
  waitBooted,
  wsRows,
  termIds
} from './helpers/p1'
import type { Locator, Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { seedSettings } from './helpers/env'
import {
  WORKBENCH,
  artifactBody,
  layoutState,
  openFileTab,
  workbenchIcon,
  workbenchPanel
} from './helpers/workbench'

function rowOf(page: Page, title: string): Locator {
  return wsRows(page, 'ws-a').filter({
    has: page.locator('.ws-tab-title', { hasText: new RegExp(`^${title}$`) })
  })
}

function mask(page: Page): Locator {
  return page.locator('.terminals .empty')
}

const XTERM_DEBOUNCED_FRAME_MS = 300

test.describe('switching sessions from the sidebar: the click frame paints only the highlight and a mask, the target lands after', () => {
  test('T-SWITCH-01: the click frame paints highlight + mask; the target xterm follows later', async ({
    env,
    page
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    setNextSessionTitle(env, 'S1')
    await startSessionIn(page, 'ws-a')
    setNextSessionTitle(env, 'S2')
    await startSessionIn(page, 'ws-a')
    await expect(rowOf(page, 'S2')).toHaveClass(/active/)
    await expect(mask(page)).toHaveCount(0)
    await page
      .locator('.hint-card[data-hint="worktree"]')
      .getByRole('button', { name: 'Got it', exact: true })
      .click()

    await page.evaluate(() => {
      const log: string[] = []
      let batch = 0
      const mo = new MutationObserver((recs) => {
        batch++
        for (const r of recs) {
          const el = r.target as HTMLElement
          if (r.type === 'attributes' && r.attributeName === 'class') {
            if (el.classList.contains('ws-tab') && el.classList.contains('active')) {
              log.push(`${batch} row-active ${el.querySelector('.ws-tab-title')?.textContent}`)
            }
          } else if (r.type === 'attributes' && r.attributeName === 'style') {
            if (el.classList.contains('term-wrap') && el.style.display !== 'none') {
              log.push(`${batch} wrap-shown`)
            }
          } else if (r.type === 'childList') {
            for (const n of r.addedNodes) {
              if ((n as HTMLElement).classList?.contains('empty')) {
                log.push(`${batch} mask-on ${(n as HTMLElement).textContent}`)
              }
            }
            for (const n of r.removedNodes) {
              if ((n as HTMLElement).classList?.contains('empty')) log.push(`${batch} mask-off`)
            }
          }
        }
      })
      mo.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
        childList: true
      })
      ;(window as unknown as { __switchLog: string[] }).__switchLog = log
    })

    await rowOf(page, 'S1').click()
    await expect(rowOf(page, 'S1')).toHaveClass(/active/)
    await expect(mask(page)).toHaveCount(0)

    const log = await page.evaluate(
      () => (window as unknown as { __switchLog: string[] }).__switchLog
    )
    const batchOf = (marker: string): number => {
      const line = log.find((l) => l.includes(marker))
      expect(line, `no "${marker}" in ${JSON.stringify(log)}`).toBeDefined()
      return Number(line!.split(' ')[0])
    }
    expect(log.find((l) => l.includes('mask-on'))).toContain('S1')
    expect(batchOf('mask-on')).toBe(batchOf('row-active S1'))
    expect(batchOf('wrap-shown')).toBeGreaterThan(batchOf('mask-on'))
    expect(batchOf('mask-off')).toBeGreaterThanOrEqual(batchOf('wrap-shown'))
  })

  test('T-SWITCH-03: away and straight back before the switch lands drops the mask', async ({
    env,
    page
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    setNextSessionTitle(env, 'S1')
    await startSessionIn(page, 'ws-a')
    setNextSessionTitle(env, 'S2')
    await startSessionIn(page, 'ws-a')
    await expect(mask(page)).toHaveCount(0)

    await page.evaluate(async () => {
      const rows = [...document.querySelectorAll<HTMLElement>('.ws-tab')]
      const row = (t: string): HTMLElement =>
        rows.find((r) => r.querySelector('.ws-tab-title')?.textContent === t)!
      row('S1').click()
      await Promise.resolve()
      await Promise.resolve()
      row('S2').click()
    })
    await expect(rowOf(page, 'S2')).toHaveClass(/active/)
    await expect(mask(page)).toHaveCount(0)
  })

  test('T-SWITCH-02: coming back to an unchanged tab rasterizes no glyph (shared atlas kept)', async ({
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
      setNextSessionTitle(env, 'S1')
      await startSessionIn(page, 'ws-a')
      const before = new Set(await termIds(page))
      setNextSessionTitle(env, 'S2')
      await startSessionIn(page, 'ws-a')
      const s2 = (await termIds(page)).find((i) => !before.has(i))!

      const glyphCount = (): Promise<number> =>
        page.evaluate((id) => {
          type Atlas = { pages: { glyphs: ReadonlyArray<unknown> }[] }
          const t = (window as unknown as { __koloftTerms: Record<string, unknown> }).__koloftTerms[
            id
          ] as {
            _core?: { _renderService?: { _renderer?: { value?: { _charAtlas?: Atlas } } } }
          }
          const atlas = t?._core?._renderService?._renderer?.value?._charAtlas
          if (!atlas) return -1
          return atlas.pages.reduce((n, p) => n + p.glyphs.length, 0)
        }, s2)
      test.skip((await glyphCount()) < 0, 'no WebGL atlas here (DOM renderer fallback)')

      await page.evaluate(
        (id) =>
          new Promise<void>((done) => {
            const t = (
              window as unknown as {
                __koloftTerms: Record<string, { write(s: string, cb: () => void): void }>
              }
            ).__koloftTerms[id]
            let s = ''
            for (let r = 0; r < 20; r++) {
              let line = ''
              for (let c = 0; c < 30; c++) line += String.fromCodePoint(0x4e00 + r * 30 + c)
              s += line + '\r\n'
            }
            t.write(s, done)
          }),
        s2
      )
      await expect.poll(glyphCount, { timeout: 10_000 }).toBeGreaterThan(500)

      await rowOf(page, 'S1').click()
      await expect(rowOf(page, 'S1')).toHaveClass(/active/)
      await expect(mask(page)).toHaveCount(0)
      const settled = await glyphCount()

      await rowOf(page, 'S2').click()
      await expect(rowOf(page, 'S2')).toHaveClass(/active/)
      await expect(mask(page)).toHaveCount(0)
      await page.waitForTimeout(XTERM_DEBOUNCED_FRAME_MS)
      expect(await glyphCount()).toBe(settled)
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-SWITCH-04: the panel switches with the xterm, not with the click — its column width changes in a later commit than the masks', async ({
    app,
    env,
    page
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    setNextSessionTitle(env, 'S1')
    await startSessionIn(page, 'ws-a')
    if (!(await workbenchPanel(page).isVisible())) await workbenchIcon(page).click()
    await expect.poll(() => layoutState(page)).toBe('T2')
    const doc = path.join(env.workspaces.a, 'switch04.md')
    fs.writeFileSync(doc, '# switch04\n\nbody\n')
    await openFileTab(page, env, doc)
    await artifactBody(page).click({ position: { x: 4, y: 4 } })
    await sendShortcut(app, 'shortcut:find')
    await expect(page.locator(WORKBENCH.findBar)).toBeVisible()
    setNextSessionTitle(env, 'S2')
    await startSessionIn(page, 'ws-b')
    if (await workbenchPanel(page).isVisible()) await workbenchIcon(page).click()
    await expect.poll(() => layoutState(page)).toBe('T1')
    await expect(mask(page)).toHaveCount(0)

    const record = async (title: string): Promise<string[]> => {
      return page.evaluate(async (title) => {
        const log: string[] = []
        let batch = 0
        const col = document.querySelector('.wb-col') as HTMLElement
        let wasOff = col.classList.contains('off')
        const mo = new MutationObserver((recs) => {
          batch++
          for (const r of recs) {
            const el = r.target as HTMLElement
            if (r.type === 'attributes' && r.attributeName === 'class') {
              if (el.classList.contains('ws-tab') && el.classList.contains('active')) {
                log.push(`${batch} row-active ${el.querySelector('.ws-tab-title')?.textContent}`)
              }
              if (el === col && el.classList.contains('off') !== wasOff) {
                wasOff = el.classList.contains('off')
                log.push(`${batch} col-${wasOff ? 'off' : 'on'}`)
              }
            } else if (r.type === 'childList') {
              for (const n of r.addedNodes) {
                const e = n as HTMLElement
                if (!e.classList?.contains('empty')) continue
                log.push(`${batch} mask-on ${e.closest('.wb-col') ? 'panel' : 'term'}`)
              }
            }
          }
        })
        mo.observe(document.body, {
          subtree: true,
          attributes: true,
          attributeFilter: ['class'],
          childList: true
        })
        const rows = [...document.querySelectorAll<HTMLElement>('.ws-tab')]
        rows.find((r) => r.querySelector('.ws-tab-title')?.textContent === title)!.click()
        for (let i = 0; i < 5; i++) await Promise.resolve()
        const bar = document.querySelector('.wb-panel .find-bar')
        if (bar) {
          const b = bar.getBoundingClientRect()
          const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
          log.push(`${batch} over-findbar ${top?.closest('.wb-col > .empty') ? 'mask' : 'bar'}`)
        }
        await new Promise((r) => setTimeout(r, 500))
        mo.disconnect()
        return log
      }, title)
    }
    const batchOf = (log: string[], marker: string): number => {
      const line = log.find((l) => l.includes(marker))
      expect(line, `no "${marker}" in ${JSON.stringify(log)}`).toBeDefined()
      return Number(line!.split(' ')[0])
    }

    const toS1 = await record('S1')
    expect(batchOf(toS1, 'col-on')).toBeGreaterThan(batchOf(toS1, 'mask-on term'))
    expect(batchOf(toS1, 'row-active S1')).toBe(batchOf(toS1, 'mask-on term'))
    expect(batchOf(toS1, 'mask-on panel')).toBe(batchOf(toS1, 'mask-on term'))
    await expect(mask(page)).toHaveCount(0)
    await expect.poll(() => layoutState(page)).toBe('T2')

    await artifactBody(page).click({ position: { x: 4, y: 4 } })
    await sendShortcut(app, 'shortcut:find')
    await expect(page.locator(WORKBENCH.findBar)).toBeVisible()
    const toS2 = await record('S2')
    expect(batchOf(toS2, 'col-off')).toBeGreaterThan(batchOf(toS2, 'mask-on term'))
    expect(toS2.find((l) => l.includes('over-findbar'))).toContain('mask')
    expect(batchOf(toS2, 'row-active S2')).toBe(batchOf(toS2, 'mask-on term'))
    await expect(mask(page)).toHaveCount(0)
    await expect.poll(() => layoutState(page)).toBe('T1')
  })
})

test.describe('find in a Workbench file tab', () => {
  test('find folds case without changing the text length, so a file holding İ (U+0130) still highlights every later match at its own place', async ({
    app,
    env,
    page
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    if (!(await workbenchPanel(page).isVisible())) await workbenchIcon(page).click()
    await expect.poll(() => layoutState(page)).toBe('T2')
    const doc = path.join(env.workspaces.a, 'fold.md')
    fs.writeFileSync(doc, '# Title\n\nİstanbul\n\nfind me once\n\nFIND ME twice\n')
    await openFileTab(page, env, doc)
    await expect(artifactBody(page)).toContainText('FIND ME twice', { timeout: 15_000 })
    await artifactBody(page).click({ position: { x: 4, y: 4 } })
    await sendShortcut(app, 'shortcut:find')
    const bar = page.locator(WORKBENCH.findBar)
    await expect(bar.locator('.find-input')).toBeFocused()
    await page.keyboard.type('find me')
    await expect(bar.locator('.find-count')).toHaveText('1/2')

    const highlighted = await page.evaluate(() => {
      const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights
      const texts: string[] = []
      for (const name of ['find-active', 'find-all'])
        registry.get(name)?.forEach((range) => texts.push(range.toString()))
      return texts.sort()
    })
    expect(highlighted).toEqual(['FIND ME', 'find me'])
  })
})
