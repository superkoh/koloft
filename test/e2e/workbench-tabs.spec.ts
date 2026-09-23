import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  centerTerm,
  clickAppMenuItem,
  openSessionTerminal,
  panelTerm,
  runIn,
  seedJsonl,
  sendShortcut,
  startSessionIn,
  waitBooted,
  waitForCalls
} from './helpers/p1'
import { addressField, guestByUrl, newWebTab, typeInAddressBar } from './helpers/browser'
import { startEchoServer } from './helpers/fixtureServer'
import {
  answerFileDialog,
  cancelFileDialog,
  pendingFileDialogAnswers,
  appRegion,
  persistedTabsOnDisk,
  WORKBENCH,
  seedWorkbench,
  seedWorkbenchDefault,
  layoutState,
  wbActiveTab,
  wbTabByTitle,
  wbTabTitles,
  wbTabs,
  wbUnreadTabs,
  workbenchPanel
} from './helpers/workbench'

async function focusPanel(page: Page): Promise<void> {
  await workbenchPanel(page).click({ position: { x: 5, y: 5 } })
}

async function closeTab(app: ElectronApplication): Promise<void> {
  await sendShortcut(app, 'shortcut:close-tab')
}

async function newTab(page: Page): Promise<void> {
  await page.keyboard.press('Meta+t')
}

async function agentOpen(page: Page, target: string): Promise<void> {
  await runIn(page, centerTerm(page), `/open ${target}`)
}

const leaveTimeToCollapseBeforeOpenLands = 'sleep 3; '

test.describe('Workbench tab lifecycle: an open forks by target (a web url lands a background tab, a file lands none) and by source (agent, or the user’s own shell)', () => {
  test('WB-T02: an agent web open lands a background, unread, unloaded tab', async ({ page }) => {
    await startSessionIn(page, 'ws-a')
    await expect(wbTabs(page)).toHaveCount(1)

    await agentOpen(page, 'http://127.0.0.1:1/alpha')
    await agentOpen(page, 'http://127.0.0.1:1/beta')

    await expect(wbTabs(page)).toHaveCount(3)
    await expect(wbUnreadTabs(page)).toHaveCount(2)
    await expect(wbActiveTab(page)).toHaveClass(/pinned/)
    const titles = await wbTabTitles(page)
    expect(titles.slice(1)).toEqual(['127.0.0.1:1/alpha', '127.0.0.1:1/beta'])
  })

  test('WB-T03: an agent re-open only re-lights the mark', async ({ page }) => {
    await startSessionIn(page, 'ws-a')
    await agentOpen(page, 'http://127.0.0.1:1/alpha')
    await expect(wbTabs(page)).toHaveCount(2)

    await wbTabs(page).nth(1).click()
    await expect(wbUnreadTabs(page)).toHaveCount(0)
    await wbTabs(page).nth(0).click()

    await agentOpen(page, 'http://127.0.0.1:1/alpha')

    await expect(wbTabs(page)).toHaveCount(2)
    await expect(wbUnreadTabs(page)).toHaveCount(1)
    await expect(wbActiveTab(page)).toHaveClass(/pinned/)
  })

  test('WB-T04/T05: expanding never batch-clears; only activation clears one mark', async ({
    app,
    page
  }) => {
    await startSessionIn(page, 'ws-a')
    await clickAppMenuItem(app, page, 'toggle-browser')
    await agentOpen(page, 'http://127.0.0.1:1/alpha')
    await agentOpen(page, 'http://127.0.0.1:1/beta')

    await clickAppMenuItem(app, page, 'toggle-browser')
    await expect(workbenchPanel(page)).toBeVisible()
    await expect(wbUnreadTabs(page)).toHaveCount(2)

    await wbTabs(page).nth(1).click()
    await expect(wbUnreadTabs(page)).toHaveCount(1)
  })

  test('WB-T22/T21: an agent file open makes no tab and no signal, and a user open of the same file still lands, read in Browse', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await startSessionIn(page, 'ws-a')
    await openSessionTerminal(app, page)
    const before = await wbTabs(page).count()
    await clickAppMenuItem(app, page, 'toggle-browser')
    await expect(workbenchPanel(page)).toBeHidden()

    const rel = 'agent-note.md'
    const abs = path.join(env.workspaces.a, rel)
    await runIn(page, centerTerm(page), `/write ${rel}`)
    await expect.poll(() => fs.existsSync(abs), { timeout: 30_000 }).toBe(true)
    await agentOpen(page, abs)

    await expect(wbTabs(page)).toHaveCount(before)
    await expect(workbenchPanel(page)).toBeHidden()

    await clickAppMenuItem(app, page, 'toggle-browser')
    await expect(workbenchPanel(page)).toBeVisible()
    await runIn(page, panelTerm(page), `${leaveTimeToCollapseBeforeOpenLands}open ${abs}`)
    await clickAppMenuItem(app, page, 'toggle-browser')
    await expect(workbenchPanel(page)).toBeHidden()
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 30_000 })
    await expect(wbActiveTab(page)).toHaveClass(/pinned/)
    await expect(wbTabs(page)).toHaveCount(before)
    await expect(page.locator('.wb-panel .fv')).toHaveAttribute('data-view', 'browse')
    await expect(page.locator('.wb-panel .fv-artifact-hd .wb-title')).toContainText(rel)
  })

  test('WB-T20: a user web open from a shell loads in the foreground and expands the panel', async ({
    app,
    page
  }) => {
    test.setTimeout(180_000)
    await startSessionIn(page, 'ws-a')
    await openSessionTerminal(app, page)
    await runIn(
      page,
      panelTerm(page),
      `${leaveTimeToCollapseBeforeOpenLands}open http://127.0.0.1:1/gamma`
    )
    await clickAppMenuItem(app, page, 'toggle-browser')
    await expect(workbenchPanel(page)).toBeHidden()

    await expect(workbenchPanel(page)).toBeVisible({ timeout: 30_000 })
    await expect(wbTabs(page)).toHaveCount(3)
    await expect(wbActiveTab(page)).not.toHaveClass(/pinned/)
    await expect(wbUnreadTabs(page)).toHaveCount(0)
  })

  test('WB-T01/T07: files is unclosable and ⌘W walks right, then left', async ({ app, page }) => {
    await startSessionIn(page, 'ws-a')
    await agentOpen(page, 'http://127.0.0.1:1/a')
    await agentOpen(page, 'http://127.0.0.1:1/b')
    await agentOpen(page, 'http://127.0.0.1:1/c')
    await expect(wbTabs(page)).toHaveCount(4)

    await expect(wbTabs(page).nth(0)).toHaveClass(/pinned/)
    await expect(wbTabs(page).nth(0).locator('.x')).toHaveCount(0)

    await wbTabs(page).nth(0).click()
    await focusPanel(page)
    await closeTab(app)
    await expect(wbTabs(page)).toHaveCount(4)
    await expect(workbenchPanel(page)).toBeVisible()

    await wbTabs(page).nth(2).click()
    await focusPanel(page)
    await closeTab(app)
    await expect(wbTabs(page)).toHaveCount(3)
    await expect(wbActiveTab(page)).toHaveText(/c/)

    await focusPanel(page)
    await closeTab(app)
    await expect(wbTabs(page)).toHaveCount(2)
    await expect(wbActiveTab(page)).toHaveText(/a/)
  })

  test('WB-K01: with the panel unfocused ⌘W is still the session’s, not the panel’s', async ({
    app,
    page
  }) => {
    await startSessionIn(page, 'ws-a')
    await agentOpen(page, 'http://127.0.0.1:1/a')
    await expect(wbTabs(page)).toHaveCount(2)
    await expect(centerTerm(page)).toBeVisible()

    await centerTerm(page).click()
    await closeTab(app)

    await expect(page.locator('.w-empty')).toBeVisible({ timeout: 20_000 })
  })

  test('WB-K01b: with the panel focused the same ⌘W closes a tab and spares the session', async ({
    app,
    page
  }) => {
    await startSessionIn(page, 'ws-a')
    await agentOpen(page, 'http://127.0.0.1:1/a')
    await expect(wbTabs(page)).toHaveCount(2)

    await wbTabs(page).nth(1).click()
    await focusPanel(page)
    await closeTab(app)

    await expect(wbTabs(page)).toHaveCount(1)
    await expect(centerTerm(page)).toBeVisible()
  })

  test('WB-K02: ⌘T creates same-kind, and an .html pick routes to a web tab', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await startSessionIn(page, 'ws-a')
    const tsFile = path.join(env.workspaces.a, 'k02.ts')
    const htmlFile = path.join(env.workspaces.a, 'k02.html')
    fs.writeFileSync(tsFile, 'export const a = 1\n')
    fs.writeFileSync(htmlFile, '<!doctype html><title>K02</title><p>hi\n')

    await focusPanel(page)
    await newTab(page)
    const menu = page.locator('.wb-newmenu')
    await expect(menu).toBeVisible()
    await expect(menu.locator('.mi')).toHaveCount(3)
    await expect(menu).toContainText('New web tab')
    await expect(menu).toContainText('Open file…')
    await expect(menu).toContainText(/terminal/i)
    await page.keyboard.press('Escape')

    answerFileDialog(env, tsFile)
    await focusPanel(page)
    await newTab(page)
    await menu.locator('.mi', { hasText: 'Open file…' }).click()
    await expect(wbTabs(page)).toHaveCount(2)
    await expect(wbActiveTab(page)).toHaveText(/k02\.ts/)
    await expect.poll(() => pendingFileDialogAnswers(env)).toEqual([])

    cancelFileDialog(env)
    await focusPanel(page)
    await newTab(page)
    await expect(wbTabs(page)).toHaveCount(2)

    answerFileDialog(env, htmlFile)
    await focusPanel(page)
    await newTab(page)
    await expect(wbTabs(page)).toHaveCount(3)
    await expect(page.locator('.wb-panel')).toHaveAttribute('data-kind', 'web')
  })

  test('WB-T09 / WB-P01: dragging reorders the strip and the new order is what persists', async ({
    page
  }) => {
    await startSessionIn(page, 'ws-a')
    await agentOpen(page, 'http://127.0.0.1:1/a')
    await agentOpen(page, 'http://127.0.0.1:1/b')
    await expect(wbTabs(page)).toHaveCount(3)
    expect((await wbTabTitles(page)).slice(1)).toEqual(['127.0.0.1:1/a', '127.0.0.1:1/b'])

    const from = wbTabs(page).nth(2)
    const to = wbTabs(page).nth(1)
    await from.dragTo(to)

    await expect
      .poll(async () => (await wbTabTitles(page)).slice(1))
      .toEqual(['127.0.0.1:1/b', '127.0.0.1:1/a'])
    await expect(wbTabs(page).nth(0)).toHaveClass(/pinned/)
  })

  test.describe('the panel belongs to the conversation tab, not to the Claude session id', () => {
    async function webTabOn(page: Page, url: string): Promise<void> {
      await newWebTab(page)
      await expect(addressField(page)).toBeVisible({ timeout: 20_000 })
      await typeInAddressBar(page, url)
    }

    test('T-GT-11: an in-TUI /resume leaves the panel untouched and writes the next save under the target id', async ({
      env
    }) => {
      test.setTimeout(300_000)
      const targetId = seedJsonl(env, env.workspaces.a, { summary: 'Resume target session' })
      seedWorkbench(env, targetId, {
        open: false,
        tabs: [{ kind: 'web', title: 'target-page', url: 'http://127.0.0.1:1/target-page' }]
      })

      const srv = await startEchoServer()
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await page.waitForLoadState('domcontentloaded')
        await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
        await startSessionIn(page, 'ws-a')
        const [origin] = await waitForCalls(env, 1)

        await webTabOn(page, srv.url('/origin'))
        await guestByUrl(app, '/origin')
        await expect.poll(() => srv.count('/origin'), { timeout: 20_000 }).toBe(1)
        const titlesBefore = await wbTabTitles(page)
        await expect
          .poll(() => persistedTabsOnDisk(env, origin.sessionId).map((t) => t.url), {
            timeout: 30_000
          })
          .toEqual([srv.url('/origin')])

        await runIn(page, centerTerm(page), `/resume ${targetId}`)
        await expect(centerTerm(page)).toContainText(`resumed session ${targetId}`, {
          timeout: 30_000
        })

        await expect(workbenchPanel(page)).toBeVisible()
        await page.waitForTimeout(5000)
        expect(await wbTabTitles(page)).toEqual(titlesBefore)
        expect(srv.count('/origin')).toBe(1)
        await expect(wbTabByTitle(page, /target-page/)).toHaveCount(0)

        await webTabOn(page, srv.url('/after'))
        await expect
          .poll(() => persistedTabsOnDisk(env, targetId).map((t) => t.url), { timeout: 30_000 })
          .toEqual([srv.url('/origin'), srv.url('/after')])
        expect(persistedTabsOnDisk(env, origin.sessionId).map((t) => t.url)).toEqual([
          srv.url('/origin')
        ])
      } finally {
        await app.close().catch(() => {})
        await srv.close()
      }
    })

    test('WB-T23: ⇧⌘R leaves the panel’s open state, tabs and live guest untouched', async ({
      app,
      page,
      env
    }) => {
      test.setTimeout(300_000)
      const srv = await startEchoServer()
      try {
        await startSessionIn(page, 'ws-a')
        const [first] = await waitForCalls(env, 1)
        await webTabOn(page, srv.url('/restart'))
        await guestByUrl(app, '/restart')
        await expect.poll(() => srv.count('/restart'), { timeout: 20_000 }).toBe(1)
        const titlesBefore = await wbTabTitles(page)

        await clickAppMenuItem(app, page, 'toggle-browser')
        await expect(workbenchPanel(page)).toBeHidden()
        await sendShortcut(app, 'shortcut:restart-session')
        const calls = await waitForCalls(env, 2)
        expect(calls[1].argv[calls[1].argv.indexOf('--resume') + 1]).toBe(first.sessionId)

        await page.waitForTimeout(5000)
        await expect(workbenchPanel(page)).toBeHidden()
        await clickAppMenuItem(app, page, 'toggle-browser')
        await expect(workbenchPanel(page)).toBeVisible()
        expect(await wbTabTitles(page)).toEqual(titlesBefore)
        expect(srv.count('/restart')).toBe(1)
      } finally {
        await srv.close()
      }
    })
  })

  test('WB-T24: no tab sits inside a window drag region, and the ✕ never starts a tab drag', async ({
    page
  }) => {
    test.setTimeout(120_000)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await newWebTab(page)
    await expect(wbTabs(page)).toHaveCount(2, { timeout: 20_000 })

    expect(await appRegion(page, WORKBENCH.tabStrip)).not.toBe('drag')
    const shape = await page.evaluate((sel) => {
      const handle = document.querySelector(sel.dragHandle)!
      const x = document.querySelector(`${sel.tab}:not(.pinned) ${sel.tabCloseIn}`)!
      return {
        handleLast: [...document.querySelectorAll(sel.tab)].every((t) =>
          Boolean(t.compareDocumentPosition(handle) & Node.DOCUMENT_POSITION_FOLLOWING)
        ),
        dragCancelled: !x.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true })
        )
      }
    }, WORKBENCH)
    expect(shape.handleLast).toBe(true)
    expect(shape.dragCancelled).toBe(true)
  })
})

test.describe('Workbench commands and the panel’s first mount', () => {
  test('a panel command picked while no panel is mounted (View ▸ Close Browser Tab on the welcome screen) does not replay when the panel first mounts', async ({
    env
  }) => {
    test.setTimeout(180_000)
    seedWorkbenchDefault(env, false)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await expect(page.locator('.w-empty')).toBeVisible({ timeout: 20_000 })
      await clickAppMenuItem(app, page, 'browser-close-tab')

      await startSessionIn(page, 'ws-a')
      await expect(page.locator(WORKBENCH.column)).toHaveCount(0)

      await openSessionTerminal(app, page)
      await page.waitForTimeout(1500)
      await expect(page.locator('.wb-panel .wb-term')).toHaveCount(1)
      await expect(wbTabs(page)).toHaveCount(2)
      await expect(wbActiveTab(page)).not.toHaveClass(/pinned/)
    } finally {
      await quitAndClose(app)
    }
  })

  test('the pre-armed find-files command still runs on the first mount of a panel that was never shown', async ({
    env
  }) => {
    test.setTimeout(120_000)
    seedWorkbenchDefault(env, false)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await startSessionIn(page, 'ws-a')
      await expect(page.locator(WORKBENCH.column)).toHaveCount(0)

      await clickAppMenuItem(app, page, 'find-files')
      await expect.poll(() => layoutState(page), { timeout: 20_000 }).toBe('T2')
      await expect(page.locator('.wb-panel .ft-search-input')).toBeFocused()
    } finally {
      await quitAndClose(app)
    }
  })
})
