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

// Switching sessions from the sidebar. The click is answered in its own
// frame — the row highlight and a loading mask naming the target — and the target's
// xterm is displayed only afterwards, so however long its first render takes it never
// sits between the click and the first changed pixel. On WebGL the glyph atlas every
// terminal shares survives the switch, so coming back to a tab that did not change
// rasterizes nothing.

function rowOf(page: Page, title: string): Locator {
  return wsRows(page, 'ws-a').filter({
    has: page.locator('.ws-tab-title', { hasText: new RegExp(`^${title}$`) })
  })
}

/** The switch mask over the term island, whichever wording it carries. */
function mask(page: Page): Locator {
  return page.locator('.terminals .empty')
}

test('T-SWITCH-01: the click frame paints highlight + mask; the target xterm follows later', async ({
  env,
  page
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  setNextSessionTitle(env, 'S1')
  await startSessionIn(page, 'ws-a')
  setNextSessionTitle(env, 'S2')
  await startSessionIn(page, 'ws-a') // S2 is the selected one now
  await expect(rowOf(page, 'S2')).toHaveClass(/active/)
  await expect(mask(page)).toHaveCount(0)
  // a second session in one workspace earns the 'worktree' tip, whose card sits
  // over the very row this case clicks. The page fixture launched before this body
  // could switch tips off, so the card is dismissed the way a person would.
  await page
    .locator('.hint-card[data-hint="worktree"]')
    .getByRole('button', { name: 'Got it', exact: true })
    .click()

  // One log line per DOM change we care about, stamped with the mutation BATCH it landed
  // in — a batch is one task's worth of DOM changes, i.e. one React commit. Same batch
  // means same frame; the order of batches is the order the user would see.
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
  await expect(mask(page)).toHaveCount(0) // the switch settled: mask down, xterm on screen

  const log = await page.evaluate(
    () => (window as unknown as { __switchLog: string[] }).__switchLog
  )
  const batchOf = (marker: string): number => {
    const line = log.find((l) => l.includes(marker))
    expect(line, `no "${marker}" in ${JSON.stringify(log)}`).toBeDefined()
    return Number(line!.split(' ')[0])
  }
  // the mask names the target, and lands in the SAME commit as the highlight
  expect(log.find((l) => l.includes('mask-on'))).toContain('S1')
  expect(batchOf('mask-on')).toBe(batchOf('row-active S1'))
  // the target's xterm is displayed only in a later commit, and the mask outlives it
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
  await startSessionIn(page, 'ws-a') // S2 on screen
  await expect(mask(page)).toHaveCount(0)

  // Two clicks inside one task, with React's flush (a microtask) let through between
  // them: the switch to S1 is committed, but its two-frame display step has not run when
  // S2 is clicked again. S2's wrap never hid, so no repaint will ever be reported for
  // it — the mask has to come down on its own.
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
  // the real WebGL renderer: the atlas only exists there
  delete env.launchEnv.KOLOFT_DOM_RENDERER
  // a second session in one workspace earns the 'worktree' tip, whose card sits
  // over the very row this case clicks. Nothing here is about tips.
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

    // glyphs held by the atlas S2's renderer draws from (shared by every terminal).
    // `_charAtlas` is renderer-internal, reached the way TerminalView reaches _core.
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

    // a screen of distinct CJK in S2 while it is on screen: every glyph rasterized once
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

    // away to S1 and let that switch settle
    await rowOf(page, 'S1').click()
    await expect(rowOf(page, 'S1')).toHaveClass(/active/)
    await expect(mask(page)).toHaveCount(0)
    const settled = await glyphCount()

    // back to S2: nothing on its screen changed, so nothing is drawn into the atlas.
    // Clearing the atlas on show (the old behaviour) re-rasterizes every visible glyph,
    // and the count jumps by hundreds.
    await rowOf(page, 'S2').click()
    await expect(rowOf(page, 'S2')).toHaveClass(/active/)
    await expect(mask(page)).toHaveCount(0) // mask down = the show's repaint has run
    await page.waitForTimeout(300) // xterm's own debounced frame after that repaint
    expect(await glyphCount()).toBe(settled)
  } finally {
    await quitAndClose(app)
  }
})

// T-SWITCH-04 — the rule behind every click, stated once: the click's own
// commit changes what the user is looking at (the highlight, a mask over each island) and
// nothing else; everything about the TARGET lands only after that frame has painted. The
// Workbench panel used to break it. Fed from `activeTabId`, it switched sessions in the
// click's commit, and when the target's panel is collapsed and the source's is open that
// meant collapsing the column right there — laying out every node of the panel's content
// at width 0 before the first pixel could change. The user's report: leaving a session
// with the panel open for one without it stalls; between two open panels it does not.
// Now the panel follows `shown` like the xterm does (`landedTab`), and the column's
// width change — either direction — lands in a later commit than the masks.
test('T-SWITCH-04: the panel switches with the xterm, not with the click', async ({
  app,
  env,
  page
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  setNextSessionTitle(env, 'S1')
  await startSessionIn(page, 'ws-a')
  // S1: panel open, on a file tab with the find bar up — the panel's own overlays are
  // what the switch mask has to cover (their z-index would otherwise paint through it)
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
  // S2: panel collapsed. Main hands a new session the last state the user chose, so
  // after S1 was opened this one starts open too — collapse it explicitly.
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
      for (let i = 0; i < 5; i++) await Promise.resolve() // React's flush of the click
      // what is on top of the panel's find bar right now: the mask, or the bar itself
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

  // open → collapsed: the click's commit is the highlight and the two masks; the column
  // collapses later. THIS is the assertion that was red — the collapse used to share the
  // click's commit.
  const toS1 = await record('S1')
  expect(batchOf(toS1, 'col-on')).toBeGreaterThan(batchOf(toS1, 'mask-on term'))
  expect(batchOf(toS1, 'row-active S1')).toBe(batchOf(toS1, 'mask-on term'))
  expect(batchOf(toS1, 'mask-on panel')).toBe(batchOf(toS1, 'mask-on term'))
  await expect(mask(page)).toHaveCount(0)
  await expect.poll(() => layoutState(page)).toBe('T2')

  // the bar went with the file tab's artifact while S2 was on screen — raise it again
  await artifactBody(page).click({ position: { x: 4, y: 4 } })
  await sendShortcut(app, 'shortcut:find')
  await expect(page.locator(WORKBENCH.findBar)).toBeVisible()
  const toS2 = await record('S2')
  expect(batchOf(toS2, 'col-off')).toBeGreaterThan(batchOf(toS2, 'mask-on term'))
  // S1's find bar is still up under the mask — the mask, not the bar, is what is on top
  expect(toS2.find((l) => l.includes('over-findbar'))).toContain('mask')
  expect(batchOf(toS2, 'row-active S2')).toBe(batchOf(toS2, 'mask-on term'))
  await expect(mask(page)).toHaveCount(0)
  await expect.poll(() => layoutState(page)).toBe('T1')
})
