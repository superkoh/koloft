import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import {
  centerTerm,
  clickAppMenuItem,
  focusOwner,
  runIn,
  settingsOnDisk,
  snap,
  startSessionIn,
  waitBooted
} from './helpers/p1'
import { layoutState, seedWorkbenchDefault, wbUnreadTabs, WORKBENCH } from './helpers/workbench'

const BACKDROP_OUTSET_PX = 4
const QUEUED_HINT_HOLD_BACK_MS = 1900

async function toggleWorkbenchWithoutClicking(app: ElectronApplication, page: Page): Promise<void> {
  await clickAppMenuItem(app, page, 'toggle-browser')
}

async function start(
  env: E2EEnv,
  opts: { hintsSeen?: string[]; hintsOff?: boolean; panelOpen?: boolean } = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  seedSettings(env, {
    onboardingSeen: true,
    hintsSeen: opts.hintsSeen ?? [],
    hintsOff: opts.hintsOff ?? false
  })
  if (opts.panelOpen === false) seedWorkbenchDefault(env, false)
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app, page }
}

function card(page: Page, id?: string): ReturnType<Page['locator']> {
  return page.locator(id ? `.hint-card[data-hint="${id}"]` : '.hint-card')
}

function rowSel(tabId: string): string {
  return `.ws-tab[data-tab-id="${tabId}"]`
}

async function anchorOffset(
  page: Page,
  selector: string
): Promise<{ dx: number; dy: number } | null> {
  const target = await page.locator(selector).first().boundingBox()
  const back = await page.locator('.hint-backdrop').boundingBox()
  if (!target || !back) return null
  return {
    dx: Math.round(back.x + BACKDROP_OUTSET_PX - target.x),
    dy: Math.round(back.y + BACKDROP_OUTSET_PX - target.y)
  }
}

async function expectAnchoredAt(page: Page, selector: string): Promise<void> {
  await expect(card(page)).toBeVisible()
  await expect
    .poll(() => anchorOffset(page, selector), { timeout: 15_000 })
    .toEqual({
      dx: 0,
      dy: 0
    })
}

async function shownTabId(page: Page): Promise<string> {
  const id = await page.locator('.ws-tab.active').first().getAttribute('data-tab-id')
  if (!id) throw new Error('the shown session row carries no data-tab-id')
  return id
}

async function typeIntoHiddenRow(page: Page, tabId: string, line: string): Promise<void> {
  await page.evaluate((a) => window.api.terminal.write(a.id, a.line + '\r'), {
    id: tabId,
    line
  })
}

async function stayAbsentPastPumpGap(page: Page, ms = 4000): Promise<void> {
  await page.waitForTimeout(ms)
  await expect(card(page)).toHaveCount(0)
}

type HeldReads = { heldWorkbenchReads: ((state: unknown) => void)[] }

async function holdWorkbenchReads(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as HeldReads
    g.heldWorkbenchReads = []
    ipcMain.removeHandler('workbench:get')
    ipcMain.handle('workbench:get', () => new Promise((r) => g.heldWorkbenchReads.push(r)))
  })
}

async function heldWorkbenchReadCount(app: ElectronApplication): Promise<number> {
  return await app.evaluate(() => (globalThis as unknown as HeldReads).heldWorkbenchReads.length)
}

async function answerWorkbenchReadsCollapsed(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as HeldReads
    const collapsed = { open: false, tabs: [] }
    ipcMain.removeHandler('workbench:get')
    ipcMain.handle('workbench:get', () => collapsed)
    for (const answer of g.heldWorkbenchReads.splice(0)) answer(collapsed)
  })
}

test.describe('Contextual hints · one card at a time, anchored at its subject, silenced only by Don’t show tips', () => {
  test('T-HN-01: the workbench hint comes up once, takes no focus, and never returns', async ({
    env
  }) => {
    test.setTimeout(240_000)
    let { app, page } = await start(env, { panelOpen: false })
    try {
      await startSessionIn(page, 'ws-a')
      await runIn(page, centerTerm(page), '/write first.md')
      await expect(card(page, 'workbench')).toBeVisible({ timeout: 30_000 })
      await expect(card(page, 'workbench').locator('.h')).toHaveText('Claude changed a file')
      await expect(card(page, 'workbench').locator('.foot .n')).toHaveText('tip 1 of 5')
      await expectAnchoredAt(page, WORKBENCH.titlebarIcon)
      await snap(page, 'T-HN-01')

      expect(await focusOwner(page)).toBe('tui')
      await page.keyboard.type('hint-focus-probe')
      await page.keyboard.press('Enter')
      await expect(centerTerm(page)).toContainText('handled: hint-focus-probe', { timeout: 30_000 })
      await expect(card(page, 'workbench')).toBeVisible()

      await card(page, 'workbench').locator('button.mini', { hasText: 'Got it' }).click()
      await expect(card(page)).toHaveCount(0)
      await expect
        .poll(() => settingsOnDisk(env).hintsSeen, { timeout: 20_000 })
        .toEqual(['workbench'])

      await runIn(page, centerTerm(page), '/write second.md')
      await expect(centerTerm(page)).toContainText('wrote second.md', { timeout: 30_000 })
      await stayAbsentPastPumpGap(page)
    } finally {
      await quitAndClose(app)
    }

    app = await launchApp(env)
    try {
      page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      await runIn(page, centerTerm(page), '/write third.md')
      await expect(centerTerm(page)).toContainText('wrote third.md', { timeout: 30_000 })
      await stayAbsentPastPumpGap(page)
    } finally {
      await quitAndClose(app)
    }
  })

  test('the workbench hint waits while main has not yet said whether the panel is open, so a file written in that first round trip does not use up the card', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const { app, page } = await start(env)
    try {
      await holdWorkbenchReads(app)
      await startSessionIn(page, 'ws-a')
      await expect.poll(() => heldWorkbenchReadCount(app), { timeout: 30_000 }).toBeGreaterThan(0)

      await runIn(page, centerTerm(page), '/write held.md')
      await expect(centerTerm(page)).toContainText('wrote held.md', { timeout: 30_000 })
      await stayAbsentPastPumpGap(page)
      expect(settingsOnDisk(env).hintsSeen).toEqual([])

      await answerWorkbenchReadsCollapsed(app)
      await expect(card(page, 'workbench')).toBeVisible({ timeout: 30_000 })
      await expectAnchoredAt(page, WORKBENCH.titlebarIcon)
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-HN-02: the approval hint fires only for a row that is not on screen', async ({ env }) => {
    test.setTimeout(240_000)
    const { app, page } = await start(env, { hintsSeen: ['worktree'] })
    try {
      await startSessionIn(page, 'ws-a')
      const a = await shownTabId(page)
      await startSessionIn(page, 'ws-a')
      const b = await shownTabId(page)
      expect(b).not.toBe(a)

      await runIn(page, centerTerm(page), '/need-approval')
      await expect(page.locator(rowSel(b))).toHaveClass(/\bst-approval\b/, { timeout: 30_000 })
      await stayAbsentPastPumpGap(page)

      await runIn(page, centerTerm(page), 'back to work')
      await expect(page.locator(rowSel(b))).not.toHaveClass(/\bst-approval\b/, { timeout: 30_000 })
      await page.locator(rowSel(a)).click()
      await expect(page.locator(rowSel(a))).toHaveClass(/\bactive\b/, { timeout: 15_000 })

      await typeIntoHiddenRow(page, b, '/need-approval')
      await expect(card(page, 'approval')).toBeVisible({ timeout: 30_000 })
      await expect(card(page, 'approval').locator('.h')).toHaveText(
        'Amber means a session needs you'
      )
      await expectAnchoredAt(page, rowSel(b))
      await snap(page, 'T-HN-02')
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-HN-03: the agent-web hint follows the page onto the Browser tab', async ({ env }) => {
    test.setTimeout(240_000)
    const { app, page } = await start(env, { hintsSeen: ['workbench'], panelOpen: false })
    try {
      await startSessionIn(page, 'ws-a')
      await runIn(page, centerTerm(page), '/open http://127.0.0.1:1/hinted')
      await expect(centerTerm(page)).toContainText('opened http://127.0.0.1:1/hinted', {
        timeout: 30_000
      })

      await expect(card(page, 'agent-web')).toBeVisible({ timeout: 30_000 })
      await expect(card(page, 'agent-web').locator('.h')).toHaveText('Claude opened this page here')
      await expectAnchoredAt(page, WORKBENCH.titlebarIcon)
      await snap(page, 'T-HN-03')

      await toggleWorkbenchWithoutClicking(app, page)
      await expect.poll(() => layoutState(page), { timeout: 30_000 }).toBe('T2')
      await expect(wbUnreadTabs(page)).toHaveCount(1)
      const landed = await wbUnreadTabs(page).getAttribute('data-wb-tab-id')
      await expectAnchoredAt(page, `.wb-tab[data-wb-tab-id="${landed}"]`)
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-HN-04: the worktree hint fires on a second session in the SAME workspace', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const { app, page } = await start(env)
    try {
      await startSessionIn(page, 'ws-a')

      await startSessionIn(page, 'ws-b')
      await runIn(page, centerTerm(page), '/write shown.md')
      await expect(centerTerm(page)).toContainText('wrote shown.md', { timeout: 30_000 })
      await stayAbsentPastPumpGap(page)

      await startSessionIn(page, 'ws-a')
      await expect(card(page, 'worktree')).toBeVisible({ timeout: 30_000 })
      await expect(card(page, 'worktree').locator('.h')).toHaveText('Two sessions on one folder?')
      await expectAnchoredAt(page, rowSel(await shownTabId(page)))
      await snap(page, 'T-HN-04')
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-HN-05: Don’t show tips silences every hint until Reset tips', async ({ env }) => {
    test.setTimeout(240_000)
    const { app, page } = await start(env)
    try {
      await startSessionIn(page, 'ws-a')
      await startSessionIn(page, 'ws-a')
      await expect(card(page, 'worktree')).toBeVisible({ timeout: 30_000 })
      await card(page, 'worktree').locator('button.ob-link', { hasText: 'show tips' }).click()
      await expect(card(page)).toHaveCount(0)
      await expect.poll(() => settingsOnDisk(env).hintsOff, { timeout: 20_000 }).toBe(true)

      await startSessionIn(page, 'ws-a')
      await stayAbsentPastPumpGap(page)

      await page.locator('.tb-ico[title="Settings"]').click()
      await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 20_000 })
      await page.locator('.set-ni', { hasText: 'Welcome' }).click()
      await page
        .locator('.settings-modal .set-main .set-row button.mini', { hasText: 'Reset tips' })
        .click()
      await expect.poll(() => settingsOnDisk(env).hintsOff, { timeout: 20_000 }).toBe(false)
      expect(settingsOnDisk(env).hintsSeen).toEqual([])
      await page.keyboard.press('Escape')
      await expect(page.locator('.settings-modal')).toHaveCount(0, { timeout: 20_000 })

      await startSessionIn(page, 'ws-a')
      await expect(card(page, 'worktree')).toBeVisible({ timeout: 30_000 })
      await snap(page, 'T-HN-05')
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-HN-06: Esc and an outside click close a hint, and count it as seen', async ({ env }) => {
    test.setTimeout(240_000)
    const { app, page } = await start(env, { panelOpen: false })
    try {
      await startSessionIn(page, 'ws-a')
      await runIn(page, centerTerm(page), '/write one.md')
      await expect(card(page, 'workbench')).toBeVisible({ timeout: 30_000 })
      await page.keyboard.press('Escape')
      await expect(card(page)).toHaveCount(0)
      await expect
        .poll(() => settingsOnDisk(env).hintsSeen, { timeout: 20_000 })
        .toEqual(['workbench'])
      expect(settingsOnDisk(env).hintsOff).toBe(false)

      await startSessionIn(page, 'ws-a')
      await expect(card(page, 'worktree')).toBeVisible({ timeout: 30_000 })
      await centerTerm(page).click()
      await expect(card(page)).toHaveCount(0)
      await expect
        .poll(() => settingsOnDisk(env).hintsSeen, { timeout: 20_000 })
        .toEqual(['workbench', 'worktree'])
      expect(settingsOnDisk(env).hintsOff).toBe(false)
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-HN-07: two triggers at once show one card, and the second waits', async ({ env }) => {
    test.setTimeout(240_000)
    const { app, page } = await start(env, { hintsSeen: ['worktree'] })
    try {
      await startSessionIn(page, 'ws-a')
      const a = await shownTabId(page)
      await startSessionIn(page, 'ws-a')
      const b = await shownTabId(page)

      await toggleWorkbenchWithoutClicking(app, page)
      await expect.poll(() => layoutState(page), { timeout: 30_000 }).toBe('T1')

      await runIn(page, centerTerm(page), '/write both.md')
      await typeIntoHiddenRow(page, a, '/need-approval')

      await expect(page.locator(rowSel(a))).toHaveClass(/\bst-approval\b/, { timeout: 30_000 })
      await expect(centerTerm(page)).toContainText('wrote both.md', { timeout: 30_000 })
      await expect(card(page)).toHaveCount(1, { timeout: 30_000 })
      const first = await card(page).getAttribute('data-hint')
      expect(['workbench', 'approval']).toContain(first)
      const second = first === 'workbench' ? 'approval' : 'workbench'
      await snap(page, 'T-HN-07')

      const dismissed = Date.now()
      await card(page).locator('button.mini', { hasText: 'Got it' }).click()
      await expect(card(page)).toHaveCount(0)
      await expect(card(page, second)).toBeVisible({ timeout: 30_000 })
      expect(Date.now() - dismissed).toBeGreaterThanOrEqual(QUEUED_HINT_HOLD_BACK_MS)
      expect(await shownTabId(page)).toBe(b)
    } finally {
      await quitAndClose(app)
    }
  })
})
