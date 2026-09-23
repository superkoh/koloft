import fs from 'fs'
import path from 'path'
import type { Locator } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import {
  auxIcon,
  FAKE_SESSION_TITLE,
  gitInit,
  layoutOnDisk,
  openSessionTerminal,
  panelTerm,
  processAlive,
  readCalls,
  runIn,
  sendShortcut,
  snap,
  startSessionIn,
  waitForCalls,
  wsRows
} from './helpers/p1'
import {
  openInBrowse,
  sessionWorkbenchOnDisk,
  waitPanelAttached,
  WORKBENCH,
  workbenchPanel
} from './helpers/workbench'
import type { E2EEnv } from './helpers/env'

function shellOpenPinnedAheadOfSystemOpen(env: E2EEnv, cwd: string, target: string): string {
  // PLATFORM§2
  return `export PATH="${env.shimDir}:${env.fakeBin}:$PATH"; hash -r; cd '${cwd}'; open ${target}`
}

function styleOf(loc: Locator, prop: string): Promise<string> {
  return loc.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop) as Promise<string>
}

const pressEvenThoughAriaDisabled = { force: true }

const leaveTimeToCollapseBeforeOpenLands = 'sleep 3; '

test.describe('Workbench titlebar toggle, and the panel seam with the retired aux column', () => {
  test('T-AUX-01: the Workbench icon owns the panel — a greyed but real button that swallows a press without a session, lit with one', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const workbench = auxIcon(page, 'Workbench')

    await expect(page.locator('.w-empty')).toBeVisible({ timeout: 20_000 })
    await expect(workbench).toHaveAttribute('aria-disabled', 'true')
    expect(await styleOf(workbench, 'opacity')).toBe('0.35')
    await workbench.click(pressEvenThoughAriaDisabled)
    await page.waitForTimeout(1000)
    await expect(workbenchPanel(page)).toBeHidden()

    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible()
    await openInBrowse(page, path.join(env.workspaces.a, 'NOTES.md'))
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md')
    await expect(workbench).toHaveClass(/\bon\b/)

    await snap(page, 'T-AUX-01')

    await workbench.click()
    await expect(workbenchPanel(page)).toBeHidden()
    await expect(workbench).not.toHaveClass(/\bon\b/)
  })

  test('T-AUX-02: a collapsed panel is remembered per session across a restart, and a user open from a shell still expands it', async ({
    env
  }) => {
    test.setTimeout(300_000)
    gitInit(env.workspaces.a)

    const app1 = await launchApp(env)
    const page1 = await app1.firstWindow()
    await page1.waitForLoadState('domcontentloaded')
    let idA = ''
    try {
      await expect(page1.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
      await startSessionIn(page1, 'ws-a')
      const [callA] = await waitForCalls(env, 1)
      idA = callA.sessionId
      await openInBrowse(page1, path.join(env.workspaces.a, 'NOTES.md'))
      await expect(page1.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md')
      await auxIcon(page1, 'Workbench').click()
      await expect(workbenchPanel(page1)).toBeHidden()

      await expect
        .poll(() => sessionWorkbenchOnDisk(env, idA)?.open, { timeout: 20_000 })
        .toBe(false)
      await snap(page1, 'T-AUX-02')
    } finally {
      await app1.close().catch(() => {})
    }

    const app2 = await launchApp(env)
    try {
      const page2 = await app2.firstWindow()
      await page2.waitForLoadState('domcontentloaded')
      const rowA = wsRows(page2, 'ws-a').first()
      await expect(rowA).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await rowA.click()
      await waitForCalls(env, 2)
      await waitPanelAttached(page2)
      await expect(rowA).not.toHaveClass(/\bcold\b/, { timeout: 60_000 })
      await expect(workbenchPanel(page2)).toBeHidden({ timeout: 30_000 })
      await expect(auxIcon(page2, 'Workbench')).not.toHaveClass(/\bon\b/)

      await openSessionTerminal(app2, page2)
      await runIn(
        page2,
        panelTerm(page2),
        `${leaveTimeToCollapseBeforeOpenLands}${shellOpenPinnedAheadOfSystemOpen(env, env.workspaces.a, 'NOTES.md')}`
      )
      await auxIcon(page2, 'Workbench').click()
      await expect(workbenchPanel(page2)).toBeHidden()
      await expect(workbenchPanel(page2)).toBeVisible({ timeout: 30_000 })
      await expect(page2.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md', {
        timeout: 30_000
      })
    } finally {
      await app2.close().catch(() => {})
    }
  })

  test('T-AUX-07: ⇧⌘R restarts the selected running session, leaves the unselected one alone, and does nothing without one', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    gitInit(env.workspaces.a)

    await expect(page.locator('.w-empty')).toBeVisible({ timeout: 20_000 })
    await page.waitForFunction(
      () =>
        (window as unknown as { __koloftShortcutsReady?: boolean }).__koloftShortcutsReady === true,
      undefined,
      { timeout: 20_000 }
    )
    await sendShortcut(app, 'shortcut:restart-session')
    await page.waitForTimeout(3000)
    expect(readCalls(env)).toEqual([])

    await startSessionIn(page, 'ws-a')
    await startSessionIn(page, 'ws-b')
    const calls = await waitForCalls(env, 2)
    const [sessA, sessB] = calls
    await wsRows(page, 'ws-a').first().click()
    await expect(page.locator('.ws-tab.active')).toHaveCount(1)

    await sendShortcut(app, 'shortcut:restart-session')
    const after = await waitForCalls(env, 3)
    const i = after[2].argv.indexOf('--resume')
    expect(after[2].argv[i + 1]).toBe(sessA.sessionId)
    expect(processAlive(sessB.pid)).toBe(true)
    await expect(page.locator('.ws-tab', { hasText: FAKE_SESSION_TITLE })).toHaveCount(2)
  })

  test('T-MIG-08: a v2 layout with the retired terminal mode, its strip and the island block upgrades to v4 — workspaces and entry kept, strip and island dropped, panel collapsed but usable', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)

    const app1 = await launchApp(env)
    const page1 = await app1.firstWindow()
    await page1.waitForLoadState('domcontentloaded')
    let idA = ''
    try {
      await expect(page1.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
      await startSessionIn(page1, 'ws-a')
      idA = (await waitForCalls(env, 1))[0].sessionId
      await page1.waitForTimeout(1500)
    } finally {
      await app1.close().catch(() => {})
    }

    const file = `${env.userData}/layout.json`
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      workspaces: { path: string }[]
    }
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          version: 2,
          workspaces: doc.workspaces,
          aux: { defaultMode: 'terminal' },
          globalTerminal: { visible: true, tabs: [{ title: 'zsh', cwd: env.workspaces.a }] },
          sessions: { [idA]: { auxMode: 'terminal', tabs: [{ title: 'zsh' }] } }
        },
        null,
        2
      )
    )

    const app2 = await launchApp(env)
    try {
      const page2 = await app2.firstWindow()
      await page2.waitForLoadState('domcontentloaded')
      const row = wsRows(page2, 'ws-a').first()
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })

      await expect.poll(() => layoutOnDisk(env).version, { timeout: 30_000 }).toBe(4)
      const upgraded = layoutOnDisk(env)
      expect(upgraded).not.toHaveProperty('aux')
      expect(upgraded).not.toHaveProperty('globalTerminal')
      expect(typeof upgraded.workbench?.defaultOpen).toBe('boolean')
      expect(upgraded.workspaces?.map((w) => w.path)).toEqual([env.workspaces.a, env.workspaces.b])
      const entry = sessionWorkbenchOnDisk(env, idA)
      expect(entry).not.toBeNull()
      expect(entry?.open).toBe(false)
      expect(entry?.tabs).toEqual([])

      await row.click()
      await waitForCalls(env, 2)
      await waitPanelAttached(page2)
      await expect(workbenchPanel(page2)).toBeHidden()
      await auxIcon(page2, 'Workbench').click()
      await expect(workbenchPanel(page2)).toBeVisible({ timeout: 30_000 })
      await expect(page2.locator(WORKBENCH.tabFiles)).toHaveCount(1)

      await openInBrowse(page2, path.join(env.workspaces.a, 'NOTES.md'))
      await expect(page2.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md', {
        timeout: 30_000
      })
    } finally {
      await app2.close().catch(() => {})
    }
  })
})
