import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import type { ElectronApplication, Page } from '@playwright/test'
import type { E2EEnv } from './helpers/env'
import { setupChangeFixture } from './helpers/filesFixture'
import {
  centerTerm,
  clickAppMenuItem,
  seedJsonl,
  layoutOnDisk,
  openSessionTerminal,
  panelTerm,
  runIn,
  sendShortcut,
  setNextSessionTitle,
  settingsOnDisk,
  startSessionIn,
  waitBooted,
  waitForCalls
} from './helpers/p1'
import {
  WORKBENCH,
  seedWorkbench,
  sessionWorkbenchOnDisk,
  waitPanelAttached,
  wbTabs,
  wbUnreadTabs,
  workbenchDefaultOnDisk,
  appRegion,
  workbenchIcon,
  workbenchPanel
} from './helpers/workbench'

async function toggleWorkbench(app: ElectronApplication, page: Page): Promise<void> {
  await clickAppMenuItem(app, page, 'toggle-browser')
}

async function toggleFull(app: ElectronApplication, page: Page): Promise<void> {
  await clickAppMenuItem(app, page, 'toggle-focus-mode')
}

async function layoutState(page: Page): Promise<'T1' | 'T2' | 'T3'> {
  return page.evaluate(() => {
    const panel = document.querySelector('.wb-panel') as HTMLElement | null
    if (!panel || getComputedStyle(panel).visibility === 'hidden' || panel.offsetWidth === 0) {
      return 'T1' as const
    }
    const tui = document.querySelector('.term-island') as HTMLElement | null
    return tui && tui.offsetWidth > 0 ? ('T2' as const) : ('T3' as const)
  })
}

async function relaunch(
  app: ElectronApplication,
  env: E2EEnv
): Promise<{ app: ElectronApplication; page: Page }> {
  await app.close().catch(() => {})
  const next = await launchApp(env)
  const page = await next.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app: next, page }
}

const T3_ISLAND_GAP_FROM_SIDEBAR_PX = 10
const CLICK_FRAME_LAYOUT_BUDGET_MS = 60

test.describe('Workbench panel layout: T1 collapsed, T2 right column, T3 the TUI yields — derived from the session’s own open flag plus a transient full-width flag', () => {
  test('WB-L01: ⇧⌘B and the titlebar icon both toggle the panel, shell tab and all', async ({
    app,
    page
  }) => {
    test.setTimeout(180_000)
    await startSessionIn(page, 'ws-a')
    await openSessionTerminal(app, page)
    await expect(workbenchPanel(page)).toBeVisible()
    await runIn(page, panelTerm(page), 'echo WBL01_BEFORE')
    await expect(panelTerm(page)).toContainText('WBL01_BEFORE', { timeout: 25_000 })

    await toggleWorkbench(app, page)
    await expect.poll(() => layoutState(page)).toBe('T1')

    await toggleWorkbench(app, page)
    await expect.poll(() => layoutState(page)).toBe('T2')

    await workbenchIcon(page).click()
    await expect.poll(() => layoutState(page)).toBe('T1')
    await workbenchIcon(page).click()
    await expect.poll(() => layoutState(page)).toBe('T2')

    await expect(panelTerm(page)).toBeVisible()
    await expect(panelTerm(page)).toContainText('WBL01_BEFORE', { timeout: 25_000 })
    await runIn(page, panelTerm(page), 'echo WBL01_ALIVE')
    await expect(panelTerm(page)).toContainText('WBL01_ALIVE', { timeout: 25_000 })
  })

  test('WB-L01b: the toggle keeps its spot, on the strip when open and on the ground when collapsed', async ({
    page
  }) => {
    test.setTimeout(120_000)
    await startSessionIn(page, 'ws-a')
    if ((await layoutState(page)) !== 'T2') await workbenchIcon(page).click()
    await expect.poll(() => layoutState(page)).toBe('T2')
    const open = (await workbenchIcon(page).boundingBox())!
    const strip = (await page.locator(WORKBENCH.tabStrip).boundingBox())!
    const plus = (await page.locator(WORKBENCH.newTab).boundingBox())!
    expect(open.y).toBeGreaterThanOrEqual(strip.y)
    expect(open.y + open.height).toBeLessThanOrEqual(strip.y + strip.height)
    expect(open.x).toBeGreaterThan(plus.x + plus.width)
    expect(open.x + open.width).toBeLessThan(strip.x + strip.width)

    await workbenchIcon(page).click()
    await expect.poll(() => layoutState(page)).toBe('T1')
    const closed = (await workbenchIcon(page).boundingBox())!
    expect(closed).toEqual(open)
  })

  test('WB-L02: ⌘⏎ and ⤢ move between T2 and T3', async ({ app, page }) => {
    await startSessionIn(page, 'ws-a')
    await expect.poll(() => layoutState(page)).toBe('T2')

    expect(await appRegion(page, WORKBENCH.dragHandle)).toBe('drag')

    await toggleFull(app, page)
    await expect.poll(() => layoutState(page)).toBe('T3')
    const side = (await page.locator('.side').boundingBox())!
    const island = (await page.locator(WORKBENCH.column).boundingBox())!
    expect(island.x - (side.x + side.width)).toBeGreaterThanOrEqual(T3_ISLAND_GAP_FROM_SIDEBAR_PX)
    expect(await appRegion(page, WORKBENCH.dragHandle)).toBe('drag')
    await toggleFull(app, page)
    await expect.poll(() => layoutState(page)).toBe('T2')

    const expand = page.locator('.wb-bar .icobtn[aria-label^="Full width"]')
    const restore = page.locator('.wb-bar .icobtn[aria-label^="Restore"]')
    await expand.click()
    await expect.poll(() => layoutState(page)).toBe('T3')
    await restore.click()
    await expect.poll(() => layoutState(page)).toBe('T2')
  })

  test('WB-L03: ⇧⌘B in T3 collapses straight to T1, never stopping at T2', async ({
    app,
    page
  }) => {
    await startSessionIn(page, 'ws-a')
    await toggleFull(app, page)
    await expect.poll(() => layoutState(page)).toBe('T3')

    await toggleWorkbench(app, page)
    await expect.poll(() => layoutState(page)).toBe('T1')
    await expect(centerTerm(page)).toBeVisible()
  })

  test('WB-L04: ⌘⏎ at T1 is a no-op', async ({ app, page }) => {
    await startSessionIn(page, 'ws-a')
    await toggleWorkbench(app, page)
    await expect.poll(() => layoutState(page)).toBe('T1')

    await toggleFull(app, page)
    await expect.poll(() => layoutState(page)).toBe('T1')
  })

  test('WB-L05: with no session the panel is unavailable', async ({ app, page }) => {
    await expect(page.locator('.aux-icons .aux-ico')).toHaveCount(1)
    await expect(workbenchIcon(page)).toHaveAttribute('aria-disabled', 'true')

    await toggleWorkbench(app, page)
    await sendShortcut(app, 'shortcut:find-files')
    await toggleFull(app, page)
    await expect(workbenchPanel(page)).toBeHidden()

    await expect
      .poll(() =>
        app.evaluate(
          ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('toggle-focus-mode')?.enabled
        )
      )
      .toBe(false)

    await expect
      .poll(() =>
        app.evaluate(
          ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('new-terminal-tab')?.enabled
        )
      )
      .toBe(false)
  })

  test('WB-L06: switching sessions dissolves T3 and lands on the target’s own open state', async ({
    app,
    page
  }) => {
    await startSessionIn(page, 'ws-a')
    await startSessionIn(page, 'ws-a')
    const rows = page.locator('.ws-tab')
    await expect(rows).toHaveCount(2, { timeout: 20_000 })
    const rowB = rows.nth(0)
    const rowA = rows.nth(1)

    await rowB.click()
    await toggleWorkbench(app, page)
    await expect.poll(() => layoutState(page)).toBe('T1')

    await rowA.click()
    await expect(workbenchPanel(page)).toBeVisible()
    await toggleFull(app, page)
    await expect.poll(() => layoutState(page)).toBe('T3')

    await rowB.click()
    await expect.poll(() => layoutState(page)).toBe('T1')

    await rowA.click()
    await expect.poll(() => layoutState(page)).toBe('T2')
  })

  test('WB-L07: the divider clamps at 440 for every tab kind, since a web page below it hits mobile breakpoints, and the width survives a restart', async ({
    app,
    page,
    env
  }) => {
    await startSessionIn(page, 'ws-a')

    const gutter = page.locator('.center-row .gutter-v').last()
    const box = await gutter.boundingBox()
    expect(box).not.toBeNull()

    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()
    await page.mouse.move(box!.x + 4000, box!.y + box!.height / 2, { steps: 12 })
    await page.mouse.up()
    const clamped = (await workbenchPanel(page).boundingBox())!.width
    expect(clamped).toBeGreaterThanOrEqual(438)
    expect(clamped).toBeLessThan(470)

    const after = (await gutter.boundingBox())!
    await page.mouse.move(after.x + after.width / 2, after.y + after.height / 2)
    await page.mouse.down()
    await page.mouse.move(after.x - 220, after.y + after.height / 2, { steps: 12 })
    await page.mouse.up()
    const widened = (await workbenchPanel(page).boundingBox())!.width
    expect(widened).toBeGreaterThan(600)
    await expect.poll(() => settingsOnDisk(env).workbenchWidth as number).toBeGreaterThan(600)

    const next = await relaunch(app, env)
    await startSessionIn(next.page, 'ws-a')
    const restored = (await workbenchPanel(next.page).boundingBox())!.width
    expect(Math.abs(restored - widened)).toBeLessThan(6)
    await next.app.close().catch(() => {})
  })

  test('WB-L09: ⌃` expands a collapsed panel and leaves T2 and T3 exactly where they are', async ({
    app,
    page
  }) => {
    test.setTimeout(240_000)
    await startSessionIn(page, 'ws-a')

    await toggleWorkbench(app, page)
    await expect.poll(() => layoutState(page)).toBe('T1')
    await openSessionTerminal(app, page)
    await expect.poll(() => layoutState(page)).toBe('T2')

    await openSessionTerminal(app, page)
    await expect.poll(() => layoutState(page)).toBe('T2')

    await toggleFull(app, page)
    await expect.poll(() => layoutState(page)).toBe('T3')
    await openSessionTerminal(app, page)
    await expect.poll(() => layoutState(page)).toBe('T3')
  })

  test('WB-L10: a T2→T3→T2 round trip leaves the TUI’s buffer and its pty intact', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await startSessionIn(page, 'ws-a')

    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    await runIn(page, centerTerm(page), 'WB_L10_MARK')
    await expect(centerTerm(page)).toContainText('WB_L10_MARK', { timeout: 25_000 })
    const before = await centerTerm(page).innerText()

    await toggleFull(app, page)
    await expect.poll(() => layoutState(page)).toBe('T3')
    await toggleFull(app, page)
    await expect.poll(() => layoutState(page)).toBe('T2')

    await expect.poll(() => centerTerm(page).innerText()).toBe(before)

    const marker = path.join(env.workspaces.a, 'wb-l10-marker.txt')
    await runIn(page, centerTerm(page), '/write wb-l10-marker.txt')
    await expect.poll(() => fs.existsSync(marker), { timeout: 30_000 }).toBe(true)

    expect(errors).toEqual([])
  })

  test('WB-P01: tabs and open survive a restart; activeId, unread and the backlink do not, so a tab switch never writes layout.json', async ({
    app,
    env
  }) => {
    const sessionId = 'restart-session-1'
    seedJsonl(env, env.workspaces.a, { id: sessionId, owned: false })
    const filePath = path.join(env.workspaces.a, 'a.md')
    fs.writeFileSync(filePath, '# a\n')
    seedWorkbench(env, sessionId, {
      open: true,
      tabs: [
        { kind: 'web', title: 'A', url: 'http://127.0.0.1:1/a' },
        { kind: 'file', title: 'a.md', path: filePath }
      ]
    })

    const next = await relaunch(app, env)
    const stored = sessionWorkbenchOnDisk(env, sessionId)
    expect(stored?.open).toBe(true)
    expect(stored?.tabs.map((t) => t.kind)).toEqual(['web', 'file'])
    const raw = JSON.stringify(stored)
    expect(raw).not.toContain('activeId')
    expect(raw).not.toContain('unread')
    expect(raw).not.toContain('sourceTabId')
    await next.app.close().catch(() => {})
  })

  test('WB-P03: a v2 layout upgrades without losing workspaces or sessions, idempotently', async ({
    app,
    env
  }) => {
    await app.close().catch(() => {})
    const wsPath = env.workspaces.a
    for (const id of ['sid-browser', 'sid-preview', 'sid-collapsed']) {
      seedJsonl(env, wsPath, { id, owned: false })
    }
    fs.writeFileSync(
      path.join(env.userData, 'layout.json'),
      JSON.stringify({
        version: 2,
        workspaces: [{ path: wsPath }],
        aux: { defaultMode: 'preview' },
        sessions: {
          'sid-browser': {
            auxMode: 'browser',
            browser: {
              tabs: [
                { url: 'http://127.0.0.1:1/one', title: 'One' },
                { url: 'http://127.0.0.1:1/two', title: 'Two' }
              ]
            }
          },
          'sid-preview': { auxMode: 'preview' },
          'sid-collapsed': { auxMode: null }
        }
      })
    )

    let current = await launchApp(env)
    let page = await current.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)

    const doc = layoutOnDisk(env) as unknown as {
      version: number
      workspaces: { path: string }[]
      sessions: Record<string, { open: boolean; tabs: { kind: string; url?: string }[] }>
    }
    expect(doc.version).toBe(4)
    expect(doc.workspaces.map((w) => w.path)).toEqual([wsPath])
    expect(Object.keys(doc.sessions).sort()).toEqual([
      'sid-browser',
      'sid-collapsed',
      'sid-preview'
    ])
    expect(doc.sessions['sid-browser'].open).toBe(false)
    expect(doc.sessions['sid-browser'].tabs.map((t) => t.kind)).toEqual(['web', 'web'])
    expect(doc.sessions['sid-browser'].tabs.map((t) => t.url)).toEqual([
      'http://127.0.0.1:1/one',
      'http://127.0.0.1:1/two'
    ])
    expect(doc.sessions['sid-preview'].open).toBe(false)
    expect(doc.sessions['sid-collapsed'].open).toBe(false)

    const first = fs.readFileSync(path.join(env.userData, 'layout.json'), 'utf8')
    await current.close().catch(() => {})
    current = await launchApp(env)
    page = await current.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    expect(fs.readFileSync(path.join(env.userData, 'layout.json'), 'utf8')).toBe(first)
    await current.close().catch(() => {})
  })

  test('WB-P04: a dirty layout sanitises per item instead of blanking the panel', async ({
    app,
    env
  }) => {
    await app.close().catch(() => {})
    seedJsonl(env, env.workspaces.a, { id: 'sid-dirty', owned: false })
    const twelve = Array.from({ length: 12 }, (_, i) => ({
      kind: 'web',
      title: `T${i}`,
      url: `http://127.0.0.1:1/${i}`
    }))
    fs.writeFileSync(
      path.join(env.userData, 'layout.json'),
      JSON.stringify({
        version: 4,
        workspaces: [{ path: env.workspaces.a }],
        workbench: { defaultOpen: true },
        sessions: {
          'sid-dirty': {
            open: true,
            tabs: [{ kind: 'web', title: 'no url' }, { kind: 'wat', title: 'x' }, ...twelve]
          }
        }
      })
    )

    const current = await launchApp(env)
    const page = await current.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)

    const tabs = sessionWorkbenchOnDisk(env, 'sid-dirty')?.tabs ?? []
    expect(tabs).toHaveLength(8)
    expect(tabs.every((t) => t.kind === 'web' && !!t.url)).toBe(true)
    expect((layoutOnDisk(env) as unknown as { workspaces: unknown[] }).workspaces).toHaveLength(1)
    await current.close().catch(() => {})
  })

  test('WB-P05: workbenchWidth initialises from the larger of the two retired widths, which stay on disk because settings.json cannot delete a key', async ({
    app,
    env
  }) => {
    await app.close().catch(() => {})
    const settingsFile = path.join(env.userData, 'settings.json')
    const existing = fs.existsSync(settingsFile)
      ? JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
      : {}
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ ...existing, filePaneWidth: 500, browserPaneWidth: 620 }, null, 2)
    )

    const current = await launchApp(env)
    const page = await current.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')

    const width = (await workbenchPanel(page).boundingBox())!.width
    expect(Math.abs(width - 620)).toBeLessThan(6)
    const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    expect(onDisk.filePaneWidth).toBe(500)
    expect(onDisk.browserPaneWidth).toBe(620)
    await current.close().catch(() => {})
  })

  test('WB-K07: a collapsed panel shows no count and no unread dot on the titlebar', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await startSessionIn(page, 'ws-a')
    await toggleWorkbench(app, page)
    await expect.poll(() => layoutState(page)).toBe('T1')

    const before = await wbTabs(page).count()

    await runIn(page, centerTerm(page), '/open http://127.0.0.1:1/one')
    await runIn(page, centerTerm(page), '/open http://127.0.0.1:1/two')
    await runIn(page, centerTerm(page), '/write wb-k07-written.txt')
    await expect
      .poll(() => fs.existsSync(path.join(env.workspaces.a, 'wb-k07-written.txt')), {
        timeout: 30_000
      })
      .toBe(true)

    expect(await layoutState(page)).toBe('T1')
    await expect(workbenchIcon(page)).not.toHaveClass(/unread/)
    await expect(workbenchIcon(page).locator('.cnt')).toHaveCount(0)

    await expect.poll(() => wbTabs(page).count()).toBe(before + 2)
    await expect(wbUnreadTabs(page)).toHaveCount(2)

    await toggleWorkbench(app, page)
    await expect.poll(() => layoutState(page)).toBe('T2')
    await expect(wbUnreadTabs(page)).toHaveCount(2)
  })

  test.describe('under the shipped default, with no workbench block in layout.json', () => {
    function unseedWorkbenchDefaultWhileAppDown(env: E2EEnv): void {
      const file = path.join(env.userData, 'layout.json')
      const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
      delete doc.workbench
      fs.writeFileSync(file, JSON.stringify(doc, null, 2))
    }

    const rowTitled = (page: Page, title: string): ReturnType<Page['locator']> =>
      page.locator('.ws-tab').filter({ has: page.locator('.ws-tab-title', { hasText: title }) })

    test('WB-L11: under the shipped default a new session starts with the panel collapsed', async ({
      app,
      env
    }) => {
      await app.close().catch(() => {})
      unseedWorkbenchDefaultWhileAppDown(env)
      const next = await relaunch(app, env)
      try {
        await startSessionIn(next.page, 'ws-a')
        await expect.poll(() => layoutState(next.page)).toBe('T1')
        await expect(workbenchIcon(next.page)).toHaveAttribute('aria-disabled', 'false')
        await expect(workbenchIcon(next.page)).not.toHaveClass(/\bon\b/)
        const [call] = await waitForCalls(env, 1)
        await expect
          .poll(() => sessionWorkbenchOnDisk(env, call.sessionId)?.open, { timeout: 20_000 })
          .toBe(false)
        expect(workbenchDefaultOnDisk(env)).toBe(false)
      } finally {
        await next.app.close().catch(() => {})
      }
    })

    test('WB-P06: an expanded panel is remembered per session across a restart and a resume', async ({
      app,
      env
    }) => {
      test.setTimeout(300_000)
      await app.close().catch(() => {})
      unseedWorkbenchDefaultWhileAppDown(env)

      let idA = ''
      const first = await relaunch(app, env)
      try {
        setNextSessionTitle(env, 'Session A')
        await startSessionIn(first.page, 'ws-a')
        const [callA] = await waitForCalls(env, 1)
        idA = callA.sessionId
        await expect.poll(() => layoutState(first.page)).toBe('T1')
        await toggleWorkbench(first.app, first.page)
        await expect.poll(() => layoutState(first.page)).toBe('T2')
        await expect
          .poll(() => sessionWorkbenchOnDisk(env, idA)?.open, { timeout: 20_000 })
          .toBe(true)

        setNextSessionTitle(env, 'Session B')
        await startSessionIn(first.page, 'ws-a')
        await expect.poll(() => layoutState(first.page)).toBe('T1')
        expect(sessionWorkbenchOnDisk(env, idA)?.open).toBe(true)
      } finally {
        await first.app.close().catch(() => {})
      }

      const second = await relaunch(first.app, env)
      try {
        const page = second.page
        const rowA = rowTitled(page, 'Session A')
        await expect(rowA).toHaveCount(1, { timeout: 30_000 })
        await expect(rowA).toHaveClass(/\bcold\b/, { timeout: 30_000 })
        await rowA.click()
        await waitForCalls(env, 3)
        await waitPanelAttached(page)
        await expect(rowA).not.toHaveClass(/\bcold\b/, { timeout: 60_000 })
        await expect.poll(() => layoutState(page), { timeout: 30_000 }).toBe('T2')
        await expect(workbenchPanel(page)).toBeVisible()
      } finally {
        await second.app.close().catch(() => {})
      }
    })
  })

  test('WB-L12: collapsing a heavy panel paints in the click’s frame; the rest follows', async ({
    app,
    env,
    page
  }) => {
    test.setTimeout(120_000)
    const fx = setupChangeFixture(env.workspaces.a)
    fx.bigChange()
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    if (!(await workbenchPanel(page).isVisible())) await workbenchIcon(page).click()
    await expect.poll(() => layoutState(page)).toBe('T2')
    await expect(page.locator('.wb-panel .cv-blk')).toHaveCount(6, { timeout: 60_000 })
    await expect(page.locator('.wb-panel .cv-blk:not([data-ready="1"])')).toHaveCount(0, {
      timeout: 60_000
    })
    await page.locator('.wb-panel .cv-stream').evaluate(async (el) => {
      for (let y = 0; y < el.scrollHeight; y += 600) {
        el.scrollTop = y
        await new Promise((r) => setTimeout(r, 30))
      }
      el.scrollTop = 0
    })
    await page.waitForTimeout(1000)

    const collapse = (): Promise<{
      before: { w: number; h: number }
      after: { w: number; h: number; col: number }
      layoutMs: number
      log: string[]
    }> =>
      page.evaluate(async () => {
        const col = document.querySelector('.wb-col') as HTMLElement
        const panel = document.querySelector('.wb-panel') as HTMLElement
        const before = { w: panel.offsetWidth, h: panel.offsetHeight }
        const log: string[] = []
        let batch = 0
        const mo = new MutationObserver((recs) => {
          batch++
          for (const rec of recs) {
            const el = rec.target as HTMLElement
            if (el === col && rec.attributeName === 'class' && el.classList.contains('off')) {
              log.push(`${batch} col-off`)
            }
            if (el === panel && rec.attributeName === 'data-surface' && !el.dataset.surface) {
              log.push(`${batch} panel-off`)
            }
          }
        })
        mo.observe(document.body, { subtree: true, attributes: true })
        const icon = document.querySelector('.aux-ico[aria-label="Workbench"]') as HTMLElement
        icon.click()
        for (let i = 0; i < 5; i++) await Promise.resolve()
        const after = { w: panel.offsetWidth, h: panel.offsetHeight, col: col.offsetWidth }
        const t0 = performance.now()
        void document.body.getBoundingClientRect()
        const layoutMs = performance.now() - t0
        await new Promise((r) => setTimeout(r, 300))
        mo.disconnect()
        return { before, after, layoutMs, log }
      })
    const r = await collapse()
    expect(r.after.col).toBe(0)
    expect(r.after).toMatchObject(r.before)
    const batchOf = (m: string): number => {
      const line = r.log.find((l) => l.endsWith(m))
      expect(line, `no "${m}" in ${JSON.stringify(r.log)}`).toBeDefined()
      return Number(line!.split(' ')[0])
    }
    expect(batchOf('panel-off')).toBeGreaterThan(batchOf('col-off'))
    expect(r.layoutMs, `click-frame layout took ${r.layoutMs}ms`).toBeLessThan(
      CLICK_FRAME_LAYOUT_BUDGET_MS
    )
    await expect.poll(() => layoutState(page)).toBe('T1')

    await workbenchIcon(page).click()
    await expect.poll(() => layoutState(page)).toBe('T2')
    await expect(page.locator('.wb-panel .cv-blk:not([data-ready="1"])')).toHaveCount(0, {
      timeout: 60_000
    })
    await toggleFull(app, page)
    await expect.poll(() => layoutState(page)).toBe('T3')
    await page.waitForTimeout(500)
    const r3 = await collapse()
    expect(r3.after.col).toBe(0)
    expect(r3.after).toMatchObject(r3.before)
    await expect.poll(() => layoutState(page)).toBe('T1')
  })
})
