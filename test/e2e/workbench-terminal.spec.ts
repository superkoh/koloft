import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import type { ElectronApplication, Page } from '@playwright/test'
import type { E2EEnv } from './helpers/env'
import {
  centerTerm,
  clickAppMenuItem,
  focusOwner,
  gitInit,
  killSession,
  layoutOnDisk,
  openMenu,
  openSessionTerminal,
  openWorktreeSession,
  panelShellPid,
  panelTerm,
  processAlive,
  readCalls,
  runIn,
  seedGlobalTerm,
  seedJsonl,
  sendShortcut,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import {
  WORKBENCH,
  artifactBody,
  openFileTab,
  persistedTabsOnDisk,
  waitPanelAttached,
  wbActiveTab,
  wbTabTitles,
  wbTabs,
  workbenchPanel
} from './helpers/workbench'

const FILES_LABEL = 'Files'

const SHELL_TITLE = 'zsh'

function termBodies(page: Page): ReturnType<Page['locator']> {
  return page.locator(`${WORKBENCH.panel} .wb-term`)
}

function focusInShell(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return !!el && el.tagName === 'TEXTAREA' && el.closest('.wb-term') !== null
  })
}

async function newTabKey(page: Page): Promise<void> {
  await page.keyboard.press('Meta+t')
}

async function closeTabKey(app: ElectronApplication): Promise<void> {
  await sendShortcut(app, 'shortcut:close-tab')
}

// PLATFORM§2
function withShimsAheadOfSystemOpen(env: E2EEnv, cmd: string): string {
  return `export PATH="${env.shimDir}:${env.fakeBin}:$PATH"; hash -r; ${cmd}`
}

const leaveTimeToSwitchSessionBeforeOpenLands = 'sleep 3; '
const ESC_KEY_CODE = 27

async function sessionWithShell(app: ElectronApplication, page: Page, ws: string): Promise<void> {
  await startSessionIn(page, ws)
  await openSessionTerminal(app, page)
}

test.describe('Workbench terminal tabs: a shell is a tab owned by a conversation tab — it needs a live session, dies with it, never survives a restart, and rides through /clear, /resume and ⇧⌘R', () => {
  test.describe('opening a terminal tab', () => {
    test('T-WT-01: ⌃` opens a terminal tab in the session’s own directory, focused; ⌘T opens a second', async ({
      app,
      page,
      env
    }) => {
      test.setTimeout(240_000)
      await startSessionIn(page, 'ws-a')

      await clickAppMenuItem(app, page, 'toggle-browser')
      await expect(workbenchPanel(page)).toBeHidden()

      await openSessionTerminal(app, page)

      await expect(workbenchPanel(page)).toBeVisible()
      await expect(termBodies(page)).toHaveCount(1)
      await expect(page.locator(`${WORKBENCH.panel}[data-kind="terminal"]`)).toHaveCount(1)
      expect(await wbTabTitles(page)).toEqual([FILES_LABEL, SHELL_TITLE])
      await expect(wbActiveTab(page)).toHaveText(SHELL_TITLE)
      expect(await focusInShell(page)).toBe(true)

      await runIn(page, panelTerm(page), `[ "$PWD" = '${env.workspaces.a}' ] && echo WT01_CWD_OK`)
      await expect(panelTerm(page)).toContainText('WT01_CWD_OK', { timeout: 25_000 })
      await expect(page.locator(WORKBENCH.artifactTitle)).toContainText(
        path.basename(env.workspaces.a)
      )

      await panelTerm(page).click()
      await newTabKey(page)
      await expect(termBodies(page)).toHaveCount(2, { timeout: 40_000 })
      expect(await wbTabTitles(page)).toEqual([FILES_LABEL, SHELL_TITLE, SHELL_TITLE])
    })

    test('T-WT-02: a worktree session’s terminal starts in the worktree, not the repo root', async ({
      env
    }) => {
      test.setTimeout(240_000)
      gitInit(env.workspaces.a)

      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await page.waitForLoadState('domcontentloaded')
        await waitBooted(page)

        const dlg = await openWorktreeSession(page, 'ws-a')
        await dlg.getByRole('textbox').click()
        await page.keyboard.type('wt197')
        await page.keyboard.press('Enter')
        await expect(dlg).toHaveCount(0)
        const [call] = await waitForCalls(env, 1)
        const wtDir = fs.realpathSync(path.join(env.workspaces.a, '.claude', 'worktrees', 'wt197'))
        expect(call.effectiveCwd).toBe(wtDir)
        expect(call.cwd).toBe(env.workspaces.a)
        await expect(page.locator('.ws-tab.st-pending')).toHaveCount(0, { timeout: 60_000 })

        await openSessionTerminal(app, page)

        await runIn(page, panelTerm(page), `[ "$PWD" = '${wtDir}' ] && echo WT02_CWD_OK`)
        await expect(panelTerm(page)).toContainText('WT02_CWD_OK', { timeout: 25_000 })
      } finally {
        await app.close().catch(() => {})
      }
    })
  })

  test.describe('closing a terminal tab', () => {
    test('T-WT-03: ⌘W in a shell kills only that shell and lands on the neighbour, then Files — and of two ⌘Ws with no click between, the second rides only the product’s own focus hand-back to the panel', async ({
      app,
      page,
      env
    }) => {
      test.setTimeout(300_000)
      await startSessionIn(page, 'ws-a')
      const [session] = await waitForCalls(env, 1)
      const row = wsRows(page, 'ws-a').first()

      await runIn(page, centerTerm(page), '/open http://127.0.0.1:1/neighbour')
      await expect(wbTabs(page)).toHaveCount(2, { timeout: 30_000 })
      await openSessionTerminal(app, page)
      const pid = await panelShellPid(page, 'WT03')
      expect(processAlive(pid)).toBe(true)

      await panelTerm(page).click()
      await closeTabKey(app)

      await expect.poll(() => processAlive(pid), { timeout: 30_000 }).toBe(false)
      await expect(termBodies(page)).toHaveCount(0, { timeout: 20_000 })
      await page.waitForTimeout(1500)
      await expect(page.locator('.modal')).toHaveCount(0)
      expect(processAlive(session.pid)).toBe(true)
      await expect(row).not.toHaveClass(/\bcold\b/)
      await expect(centerTerm(page)).toBeVisible()
      await expect(wbActiveTab(page)).toHaveText(/neighbour/)

      await openSessionTerminal(app, page)
      await page
        .locator(`${WORKBENCH.panel} .wb-tab`, { hasText: /neighbour/ })
        .locator(WORKBENCH.tabCloseIn)
        .click()
      await expect(wbTabs(page)).toHaveCount(2, { timeout: 20_000 })
      await panelTerm(page).click()
      await closeTabKey(app)
      await expect(wbTabs(page)).toHaveCount(1, { timeout: 20_000 })
      await expect(wbActiveTab(page)).toHaveClass(/pinned/)

      await openSessionTerminal(app, page)
      await openSessionTerminal(app, page)
      await expect(termBodies(page)).toHaveCount(2, { timeout: 20_000 })
      await panelTerm(page).click()

      await closeTabKey(app)
      await expect(termBodies(page)).toHaveCount(1, { timeout: 20_000 })
      expect(await focusOwner(page)).toBe('panel')

      await closeTabKey(app)
      await expect(termBodies(page)).toHaveCount(0, { timeout: 20_000 })
      await expect(page.locator('.modal')).toHaveCount(0)
      expect(processAlive(session.pid)).toBe(true)
      await expect(row).not.toHaveClass(/\bcold\b/)
    })

    test('T-WT-04: `exit` in a shell removes its terminal tab and leaves the session alone', async ({
      app,
      page,
      env
    }) => {
      test.setTimeout(240_000)
      await sessionWithShell(app, page, 'ws-a')
      const [session] = await waitForCalls(env, 1)
      await expect(termBodies(page)).toHaveCount(1)

      await runIn(page, panelTerm(page), 'exit')

      await expect(termBodies(page)).toHaveCount(0, { timeout: 30_000 })
      expect(await wbTabTitles(page)).toEqual([FILES_LABEL])
      expect(processAlive(session.pid)).toBe(true)
      await expect(centerTerm(page)).toBeVisible()
    })

    test('T-WT-04b: `exit` promotes a restored file tab with its body and the caret, not just its title', async ({
      env
    }) => {
      test.setTimeout(420_000)
      const doc = path.join(env.workspaces.a, 'wt04b.md')
      fs.writeFileSync(doc, '# WT04B\n\nbody of the restored tab\n')

      const app1 = await launchApp(env)
      try {
        const page1 = await app1.firstWindow()
        await page1.waitForLoadState('domcontentloaded')
        await expect(page1.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
        await startSessionIn(page1, 'ws-a')
        const [call] = await waitForCalls(env, 1)
        await openFileTab(page1, env, doc)
        await expect
          .poll(() => persistedTabsOnDisk(env, call.sessionId).length, { timeout: 30_000 })
          .toBe(1)
      } finally {
        await app1.close().catch(() => {})
      }

      const app2 = await launchApp(env)
      try {
        const page2 = await app2.firstWindow()
        await page2.waitForLoadState('domcontentloaded')
        const row = wsRows(page2, 'ws-a').first()
        await expect(row).toHaveClass(/\bcold\b/, { timeout: 60_000 })
        await row.click()
        await waitPanelAttached(page2)
        await expect(wbTabs(page2)).toHaveCount(2, { timeout: 30_000 })
        await expect(wbActiveTab(page2)).toHaveClass(/pinned/)
        await expect(artifactBody(page2)).toHaveCount(0)

        await openSessionTerminal(app2, page2)
        await panelTerm(page2).click()
        await runIn(page2, panelTerm(page2), 'exit')
        await expect(termBodies(page2)).toHaveCount(0, { timeout: 30_000 })

        await expect(wbActiveTab(page2)).toHaveText(/wt04b/i, { timeout: 20_000 })
        await expect(artifactBody(page2)).toHaveCount(1, { timeout: 20_000 })
        expect(await focusOwner(page2)).toBe('panel')
        await sendShortcut(app2, 'shortcut:close-tab')
        await expect(wbTabs(page2)).toHaveCount(1, { timeout: 20_000 })
        await expect(page2.locator('.modal')).toHaveCount(0)
        await expect(row).not.toHaveClass(/\bcold\b/)
      } finally {
        await app2.close().catch(() => {})
      }
    })
  })

  test.describe('what a shell is, and is not: never an agent surface, and Esc is its own', () => {
    test('T-WT-05: an interactive claude in a terminal tab is refused, and `-p` still runs', async ({
      app,
      page,
      env
    }) => {
      test.setTimeout(240_000)
      await sessionWithShell(app, page, 'ws-a')
      await waitForCalls(env, 1)

      await runIn(page, panelTerm(page), 'claude')
      await expect(panelTerm(page)).toContainText('Koloft terminal', { timeout: 25_000 })
      await expect(panelTerm(page)).toContainText('not an agent surface')
      expect(readCalls(env)).toHaveLength(1)

      await runIn(page, panelTerm(page), 'echo WT05_$((6 * 7))')
      await expect(panelTerm(page)).toContainText('WT05_42', { timeout: 20_000 })
      await runIn(page, panelTerm(page), 'claude -p "x"')
      const calls = await waitForCalls(env, 2)
      expect(calls[1].argv).toContain('-p')
    })

    test('T-WT-06: Esc pressed in a shell reaches the shell, not the panel’s Esc ladder', async ({
      app,
      page
    }) => {
      test.setTimeout(240_000)
      await sessionWithShell(app, page, 'ws-a')

      await runIn(page, panelTerm(page), `echo WT06_READY; read -sk1 k; printf 'GOT_%d\\n' "'$k"`)
      await expect(panelTerm(page)).toContainText('WT06_READY', { timeout: 25_000 })
      await panelTerm(page).click()
      await page.keyboard.press('Escape')

      await expect(panelTerm(page)).toContainText(`GOT_${ESC_KEY_CODE}`, { timeout: 25_000 })
      await expect(workbenchPanel(page)).toBeVisible()
      await expect(termBodies(page)).toHaveCount(1)
    })
  })

  test.describe('the New Terminal Tab gate: one gate for ⌃`, the menu item and the strip’s ＋', () => {
    test('T-WT-07: New Terminal Tab is greyed with no session, while pending and when cold, live in between', async ({
      app,
      page,
      env
    }) => {
      test.setTimeout(300_000)
      const itemEnabled = (): Promise<boolean | undefined> =>
        app.evaluate(
          ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('new-terminal-tab')?.enabled
        )

      await expect(page.locator('.w-empty')).toBeVisible({ timeout: 20_000 })
      await expect.poll(itemEnabled).toBe(false)

      fs.writeFileSync(env.claudeDelayFile, '4000')
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'New session' }).click()
      await expect(page.locator('.ws-tab.st-pending')).toHaveCount(1, { timeout: 30_000 })
      expect(await itemEnabled()).toBe(false)

      fs.rmSync(env.claudeDelayFile, { force: true })
      await expect(page.locator('.ws-tab.st-pending')).toHaveCount(0, { timeout: 60_000 })
      const [session] = await waitForCalls(env, 1)
      await expect.poll(itemEnabled, { timeout: 30_000 }).toBe(true)
      await clickAppMenuItem(app, page, 'new-terminal-tab')
      await expect(termBodies(page)).toHaveCount(1, { timeout: 40_000 })
      await expect(panelTerm(page)).toBeVisible({ timeout: 40_000 })

      killSession(session.pid, env)
      await expect(wsRows(page, 'ws-a').first()).toHaveClass(/\bcold\b/, { timeout: 40_000 })
      await expect.poll(itemEnabled, { timeout: 20_000 }).toBe(false)
    })
  })

  test.describe('each shell belongs to its own conversation tab', () => {
    test('T-WT-08: a shell keeps its output across a switch to another session and back', async ({
      app,
      page
    }) => {
      test.setTimeout(300_000)
      await sessionWithShell(app, page, 'ws-a')
      await runIn(page, panelTerm(page), 'echo WT08_KEEPS_5511')
      await expect(panelTerm(page)).toContainText('WT08_KEEPS_5511', { timeout: 25_000 })
      const pid = await panelShellPid(page, 'WT08PID')

      await startSessionIn(page, 'ws-b')
      await expect(panelTerm(page)).toHaveCount(0, { timeout: 20_000 })
      expect(processAlive(pid)).toBe(true)

      await wsRows(page, 'ws-a').first().click()

      await expect(panelTerm(page)).toHaveCount(1, { timeout: 20_000 })
      await expect(panelTerm(page)).toContainText('WT08_KEEPS_5511', { timeout: 25_000 })
      await expect.poll(() => focusOwner(page)).toBe('tui')
      await runIn(page, panelTerm(page), 'echo WT08_STILL_$$')
      await expect(panelTerm(page)).toContainText(`WT08_STILL_${pid}`, { timeout: 25_000 })
    })

    test('T-WT-09: `open` from a shell lands in ITS OWN session’s Files, after a switch away', async ({
      app,
      page,
      env
    }) => {
      test.setTimeout(300_000)
      await sessionWithShell(app, page, 'ws-a')

      await runIn(
        page,
        panelTerm(page),
        withShimsAheadOfSystemOpen(
          env,
          `cd '${env.workspaces.a}'; ${leaveTimeToSwitchSessionBeforeOpenLands}open README.md`
        )
      )
      await startSessionIn(page, 'ws-b')

      await expect(wsRows(page, 'ws-a').first()).toHaveClass(/\bactive\b/, { timeout: 45_000 })
      await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.md', {
        timeout: 30_000
      })
      await expect(page.locator(WORKBENCH.readingBody)).toContainText('koloft-e2e-alpha')
      expect(fs.existsSync(env.openCalls)).toBe(false)
    })

    test('T-WT-10: claude dying kills the session’s shells and drops their tabs', async ({
      app,
      page,
      env
    }) => {
      test.setTimeout(300_000)
      await sessionWithShell(app, page, 'ws-a')
      const [session] = await waitForCalls(env, 1)
      const pid = await panelShellPid(page, 'WT10')
      expect(processAlive(pid)).toBe(true)

      // CC§1
      killSession(session.pid, env)
      await expect(wsRows(page, 'ws-a').first()).toHaveClass(/\bcold\b/, { timeout: 40_000 })

      await expect.poll(() => processAlive(pid), { timeout: 40_000 }).toBe(false)
      await expect(termBodies(page)).toHaveCount(0, { timeout: 20_000 })
    })
  })

  test.describe('nothing survives a reload or a restart', () => {
    test('T-WT-11: a reload kills the shell and restores no terminal tab', async ({
      app,
      page
    }) => {
      test.setTimeout(240_000)
      await sessionWithShell(app, page, 'ws-a')
      const pid = await panelShellPid(page, 'WT11')
      expect(processAlive(pid)).toBe(true)

      await page.reload()
      await waitBooted(page)

      await expect.poll(() => processAlive(pid), { timeout: 40_000 }).toBe(false)
      await expect(workbenchPanel(page)).toBeVisible({ timeout: 40_000 })
      await expect(termBodies(page)).toHaveCount(0)
      await expect(
        page.locator(`${WORKBENCH.panel} .wb-tab`, { hasText: SHELL_TITLE })
      ).toHaveCount(0)
    })

    test('T-WT-12: a restart brings back no terminal tab, and the old globalTerminal key is dropped', async ({
      env
    }) => {
      test.setTimeout(300_000)
      seedGlobalTerm(env, {
        visible: true,
        tabs: [{ title: 'zsh', cwd: env.workspaces.a }]
      })
      expect(layoutOnDisk(env).globalTerminal).toBeTruthy()

      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await page.waitForLoadState('domcontentloaded')
        await waitBooted(page)
        await expect(page.locator('.wb-term')).toHaveCount(0)
        await expect(panelTerm(page)).toHaveCount(0)

        await startSessionIn(page, 'ws-a')
        const [session] = await waitForCalls(env, 1)
        await expect(termBodies(page)).toHaveCount(0)

        await runIn(page, centerTerm(page), '/open http://127.0.0.1:1/wt12')
        await expect(wbTabs(page)).toHaveCount(2, { timeout: 30_000 })
        await expect
          .poll(() => persistedTabsOnDisk(env, session.sessionId).length, { timeout: 30_000 })
          .toBe(1)

        expect(layoutOnDisk(env).globalTerminal).toBeUndefined()
      } finally {
        await app.close().catch(() => {})
      }
    })
  })

  test.describe('the cap of eight shells per conversation tab', () => {
    test('T-WT-13: the ninth terminal is refused with a notice and the eight already open survive', async ({
      app,
      page
    }) => {
      test.setTimeout(420_000)
      await startSessionIn(page, 'ws-a')

      for (let i = 0; i < 8; i++) await openSessionTerminal(app, page)
      await expect(termBodies(page)).toHaveCount(8)

      await sendShortcut(app, 'shortcut:new-terminal-tab')

      await expect(page.locator('.toast')).toContainText(
        'Terminal limit reached: at most 8 per session',
        {
          timeout: 20_000
        }
      )
      await expect(termBodies(page)).toHaveCount(8)
      await expect(wbTabs(page)).toHaveCount(9)
    })
  })

  test.describe('the panel follows the conversation tab, so the shell never moves', () => {
    test('T-WT-14: /clear leaves the shell running, with its tab and its output', async ({
      app,
      page,
      env
    }) => {
      test.setTimeout(300_000)
      await sessionWithShell(app, page, 'ws-a')
      const [call] = await waitForCalls(env, 1)
      await runIn(page, panelTerm(page), 'echo WT14_MARK_6060')
      await expect(panelTerm(page)).toContainText('WT14_MARK_6060', { timeout: 25_000 })
      const pid = await panelShellPid(page, 'WT14')

      await runIn(page, centerTerm(page), '/clear')
      await expect
        .poll(
          () =>
            Object.keys(layoutOnDisk(env).panels as Record<string, unknown>).filter(
              (i) => i !== call.sessionId
            ).length,
          { timeout: 60_000 }
        )
        .toBeGreaterThan(0)

      expect(processAlive(pid)).toBe(true)
      await expect(termBodies(page)).toHaveCount(1)
      await expect(panelTerm(page)).toContainText('WT14_MARK_6060')
    })

    test('T-WT-15: an in-TUI /resume leaves the shell running in the same tab', async ({
      app,
      page,
      env
    }) => {
      test.setTimeout(300_000)
      const targetId = seedJsonl(env, env.workspaces.a, { summary: 'WT15 resume target' })
      await sessionWithShell(app, page, 'ws-a')
      await waitForCalls(env, 1)
      const pid = await panelShellPid(page, 'WT15')

      await runIn(page, centerTerm(page), `/resume ${targetId}`)
      await expect(centerTerm(page)).toContainText(`resumed session ${targetId}`, {
        timeout: 30_000
      })

      expect(processAlive(pid)).toBe(true)
      await expect(termBodies(page)).toHaveCount(1)
      await runIn(page, panelTerm(page), 'echo WT15_ALIVE_$$')
      await expect(panelTerm(page)).toContainText(`WT15_ALIVE_${pid}`, { timeout: 25_000 })
    })

    test('T-WT-16: ⇧⌘R restarts claude and leaves the tab’s shell running', async ({
      app,
      page,
      env
    }) => {
      test.setTimeout(300_000)
      await sessionWithShell(app, page, 'ws-a')
      const [first] = await waitForCalls(env, 1)
      const pid = await panelShellPid(page, 'WT16')
      await runIn(page, panelTerm(page), 'echo WT16_BEFORE_RESTART')
      await expect(panelTerm(page)).toContainText('WT16_BEFORE_RESTART', { timeout: 25_000 })

      await sendShortcut(app, 'shortcut:restart-session')
      const calls = await waitForCalls(env, 2)
      const i = calls[1].argv.indexOf('--resume')
      expect(calls[1].argv[i + 1]).toBe(first.sessionId)

      expect(processAlive(pid)).toBe(true)
      await expect(termBodies(page)).toHaveCount(1)
      await expect(panelTerm(page)).toContainText('WT16_BEFORE_RESTART', { timeout: 25_000 })
      await runIn(page, panelTerm(page), 'echo WT16_ALIVE_$$')
      await expect(panelTerm(page)).toContainText(`WT16_ALIVE_${pid}`, { timeout: 25_000 })
    })
  })

  test.describe('a gutter drag resizes the shell once, where the pointer is let go', () => {
    test('T-WT-17: dragging the gutter hands the shell’s pty no in-between sizes, only the one where the pointer is let go, even when the hand pauses mid-drag — a debounce was turned down because a real hand pauses longer than any sensible wait, and every in-between resize reprints the prompt into the scrollback for good', async ({
      app,
      page,
      env
    }) => {
      test.setTimeout(240_000)
      const handPauseLongerThanAnySensibleDebounceMs = 1_500
      const sizesFile = path.join(env.home, 'wt17-pty-sizes.txt')
      const ptySizes = (): string[] =>
        fs.existsSync(sizesFile)
          ? fs.readFileSync(sizesFile, 'utf8').split('\n').filter(Boolean)
          : []
      const cols = (size: string): number => Number(size.split(' ')[1])

      await sessionWithShell(app, page, 'ws-a')
      await runIn(
        page,
        panelTerm(page),
        `stty size > '${sizesFile}'; TRAPWINCH() { stty size >> '${sizesFile}'; }; echo WT17_ARMED`
      )
      await expect(panelTerm(page)).toContainText('WT17_ARMED', { timeout: 25_000 })
      await expect.poll(() => ptySizes().length).toBeGreaterThanOrEqual(1)

      const gutter = page.locator('.center-row .gutter-v').last()
      const box = (await gutter.boundingBox())!
      const y = box.y + box.height / 2
      const before = ptySizes()
      await page.mouse.move(box.x + box.width / 2, y)
      await page.mouse.down()
      await page.mouse.move(box.x - 100, y, { steps: 10 })
      await page.waitForTimeout(handPauseLongerThanAnySensibleDebounceMs)
      await page.mouse.move(box.x - 200, y, { steps: 10 })
      await page.waitForTimeout(handPauseLongerThanAnySensibleDebounceMs)
      expect(ptySizes()).toHaveLength(before.length)
      await page.mouse.up()

      await expect.poll(ptySizes, { timeout: 10_000 }).toHaveLength(before.length + 1)
      await page.waitForTimeout(handPauseLongerThanAnySensibleDebounceMs)
      const after = ptySizes()
      expect(after).toHaveLength(before.length + 1)
      expect(cols(after[after.length - 1])).toBeGreaterThan(cols(before[before.length - 1]))
    })
  })
})
