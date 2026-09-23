import { test, expect } from './helpers/app'
import type { Page } from '@playwright/test'
import { startEchoServer, type FixtureServer } from './helpers/fixtureServer'
import fs from 'fs'
import path from 'path'
import {
  centerTerm,
  clickAppMenuItem,
  focusOwner,
  runIn,
  sendShortcut,
  startSessionIn
} from './helpers/p1'
import { answerFileDialog, wbActiveTab, wbTabs, workbenchPanel } from './helpers/workbench'

const A_LATE_LOAD_WOULD_STILL_HAVE_ARRIVED_BY_MS = 10_000

test.describe('Workbench web tab chrome, and the panel shortcut arbitration against guests and the TUI', () => {
  let server: FixtureServer

  test.beforeAll(async () => {
    server = await startEchoServer()
  })

  test.afterAll(async () => {
    await server?.close()
  })

  async function focusPanel(page: Page): Promise<void> {
    await workbenchPanel(page).click({ position: { x: 5, y: 5 } })
  }

  async function agentOpen(page: Page, target: string): Promise<void> {
    await runIn(page, centerTerm(page), `/open ${target}`)
  }

  async function openFileTabSoThePanelNotAGuestHoldsEsc(
    page: Page,
    absPath: string
  ): Promise<void> {
    await workbenchPanel(page).click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Meta+t')
    await page.locator('.wb-newmenu .mi', { hasText: 'Open file…' }).click()
    await expect(wbActiveTab(page)).toHaveText(
      new RegExp(path.basename(absPath).replace('.', '\\.'))
    )
  }

  test('WB-W05: an agent tab makes no request until opened, and never fetches a favicon', async ({
    page
  }) => {
    test.setTimeout(180_000)
    await startSessionIn(page, 'ws-a')
    const url = server.page('/agent-target', '<!doctype html><title>Agent target</title><p>hi')
    server.reset()

    await agentOpen(page, url)
    await expect(wbTabs(page)).toHaveCount(2)

    await page.waitForTimeout(A_LATE_LOAD_WOULD_STILL_HAVE_ARRIVED_BY_MS)
    expect(server.count()).toBe(0)
    expect(server.faviconHits).toHaveLength(0)

    await wbTabs(page).nth(1).click()
    await expect.poll(() => server.count('/agent-target'), { timeout: 25_000 }).toBeGreaterThan(0)
    expect(server.faviconHits).toHaveLength(0)
    await expect(wbTabs(page).nth(1).locator('img')).toHaveCount(0)
  })

  test('WB-W01: the web kind bar carries the address row, and only for a web tab — switching to files removes it', async ({
    page
  }) => {
    test.setTimeout(180_000)
    await startSessionIn(page, 'ws-a')
    const url = server.page('/w01', '<!doctype html><title>W01</title><p>page')

    await expect(page.locator('.baddr')).toHaveCount(0)

    await agentOpen(page, url)
    await wbTabs(page).nth(1).click()

    await expect(page.locator('.wb-panel')).toHaveAttribute('data-kind', 'web')
    await expect(page.locator('.baddr .url')).toHaveCount(1)
    await expect(page.locator('.baddr .bnav[aria-label="Back"]')).toHaveCount(1)
    await expect(page.locator('.baddr .bnav[aria-label="Forward"]')).toHaveCount(1)
    await expect(page.locator('.baddr .bnav[aria-label="More"]')).toHaveCount(1)

    await wbTabs(page).nth(0).click()
    await expect(page.locator('.wb-panel')).toHaveAttribute('data-kind', 'files')
    await expect(page.locator('.baddr .url')).toHaveCount(0)
  })

  test('WB-W02: ⌘L focuses the address bar on a web tab and does nothing elsewhere', async ({
    app,
    page
  }) => {
    test.setTimeout(180_000)
    await startSessionIn(page, 'ws-a')
    const url = server.page('/w02', '<!doctype html><title>W02</title><p>page')
    await agentOpen(page, url)
    await wbTabs(page).nth(1).click()
    await expect(page.locator('.baddr .url')).toHaveCount(1)

    await focusPanel(page)
    await clickAppMenuItem(app, page, 'browser-focus-address')
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.className ?? ''))
      .toContain('url')

    await wbTabs(page).nth(0).click()
    await focusPanel(page)
    await clickAppMenuItem(app, page, 'browser-focus-address')
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.className ?? ''))
      .not.toContain('url')
  })

  test('WB-K03: ⌘⌥←/→ cycle the strip including the pinned tab, wrapping both ways, and only while the panel is focused', async ({
    page
  }) => {
    test.setTimeout(180_000)
    await startSessionIn(page, 'ws-a')
    await agentOpen(page, server.page('/k03a', '<!doctype html><title>K03A</title>'))
    await agentOpen(page, server.page('/k03b', '<!doctype html><title>K03B</title>'))
    await expect(wbTabs(page)).toHaveCount(3)

    const k03aDerivedOrTitled = /k03a/i
    const k03bDerivedOrTitled = /k03b/i
    await wbTabs(page).nth(0).click()
    await focusPanel(page)

    await page.keyboard.press('Meta+Alt+ArrowRight')
    await expect(wbActiveTab(page)).toHaveText(k03aDerivedOrTitled)
    await page.keyboard.press('Meta+Alt+ArrowRight')
    await expect(wbActiveTab(page)).toHaveText(k03bDerivedOrTitled)
    await page.keyboard.press('Meta+Alt+ArrowRight')
    await expect(wbActiveTab(page)).toHaveClass(/pinned/)
    await page.keyboard.press('Meta+Alt+ArrowLeft')
    await expect(wbActiveTab(page)).toHaveText(k03bDerivedOrTitled)

    await centerTerm(page).click()
    await page.keyboard.press('Meta+Alt+ArrowRight')
    await expect(wbActiveTab(page)).toHaveText(k03bDerivedOrTitled)
  })

  test('WB-K05b: Esc closes the find bar first, then steps T3 down to T2, then sends the caret to the TUI — never T1, never a closed tab', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await startSessionIn(page, 'ws-a')
    const doc = path.join(env.workspaces.a, 'k05b.md')
    fs.writeFileSync(doc, '# K05B\n\nfind me\n')
    answerFileDialog(env, doc)
    await openFileTabSoThePanelNotAGuestHoldsEsc(page, doc)
    const tabsBefore = await wbTabs(page).count()

    await clickAppMenuItem(app, page, 'toggle-focus-mode')
    await expect(page.locator('.wb-panel')).toHaveClass(/full/)
    await focusPanel(page)
    await sendShortcut(app, 'shortcut:find')
    await expect(page.locator('.wb-panel .find-bar')).toHaveCount(1)

    await page.keyboard.press('Escape')
    await expect(page.locator('.wb-panel .find-bar')).toHaveCount(0)
    await expect(page.locator('.wb-panel')).toHaveClass(/full/)

    await page.keyboard.press('Escape')
    await expect(page.locator('.wb-panel')).not.toHaveClass(/full/)
    await expect(workbenchPanel(page)).toBeVisible()

    await page.keyboard.press('Escape')
    await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('tui')
    await expect(workbenchPanel(page)).toBeVisible()
    await expect(wbTabs(page)).toHaveCount(tabsBefore)
  })

  test('WB-K06: Esc in the TUI reaches Claude and leaves the panel’s find bar open', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await startSessionIn(page, 'ws-a')
    const doc = path.join(env.workspaces.a, 'k06.md')
    fs.writeFileSync(doc, '# K06\n\nfind me\n')
    answerFileDialog(env, doc)
    await openFileTabSoThePanelNotAGuestHoldsEsc(page, doc)

    await focusPanel(page)
    await sendShortcut(app, 'shortcut:find')
    await expect(page.locator('.wb-panel .find-bar')).toHaveCount(1)

    await centerTerm(page).click()
    await page.keyboard.press('Escape')

    await expect(page.locator('.wb-panel .find-bar')).toHaveCount(1)
    await expect(page.locator('.wb-panel')).not.toHaveClass(/full/)
  })
})
