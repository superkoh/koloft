import path from 'path'
import { test, expect } from './helpers/app'
import {
  centerTerm,
  gitInit,
  processAlive,
  runIn,
  sendShortcut,
  snap,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { WORKBENCH, openInBrowse, showBrowse, workbenchPanel } from './helpers/workbench'

test.describe('Keyboard shortcuts · native accelerators are driven as shortcut:* IPC', () => {
  test('T-KEY-03: ⌘⇧F toggles the file search row; collapsing clears the filter', async ({
    app,
    page
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const panel = workbenchPanel(page)
    await showBrowse(page)
    await expect(panel.locator('.icobtn[aria-label="Search files"]')).toBeVisible({
      timeout: 20_000
    })
    const tree = panel.locator('.bv-body')
    await expect(tree.locator('.ft-node', { hasText: 'README.md' })).toBeVisible({
      timeout: 20_000
    })

    await sendShortcut(app, 'shortcut:find-files')
    const searchRow = panel.locator('.ft-search.open')
    await expect(searchRow).toBeVisible()
    const input = panel.locator('.ft-search-input')
    await expect(input).toBeFocused()

    await input.fill('app')
    const results = panel.locator('.ft-results')
    await expect(results).toBeVisible()
    await expect(results.locator('.ft-result .ft-name', { hasText: 'app.ts' })).toBeVisible()
    await expect(results.locator('.ft-result', { hasText: 'README.md' })).toHaveCount(0)
    await snap(page, 'T-KEY-03')

    await sendShortcut(app, 'shortcut:find-files')
    await expect(panel.locator('.ft-search.open')).toHaveCount(0)
    await expect(panel.locator('.ft-results')).toHaveCount(0)
    await expect(tree.locator('.ft-node', { hasText: 'README.md' })).toBeVisible()

    await sendShortcut(app, 'shortcut:find-files')
    await expect(panel.locator('.ft-search.open')).toBeVisible()
    await expect(input).toHaveValue('')
  })

  test('T-KEY-04: ⌘F opens the preview find bar, counts matches typed through real key events without freezing the renderer, Esc closes it', async ({
    app,
    page,
    env
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await openInBrowse(page, path.join(env.workspaces.a, 'README.md'))
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.md', { timeout: 15_000 })

    await sendShortcut(app, 'shortcut:find')
    const bar = page.locator('.find-bar')
    await expect(bar).toBeVisible()
    await expect(bar.locator('.find-input')).toBeFocused()

    // PLATFORM§25
    await page.keyboard.type('koloft-e2e-alpha')
    await expect(bar.locator('.find-count')).toHaveText('1/1')
    await snap(page, 'T-KEY-04')

    await page.keyboard.press('Escape')
    await expect(page.locator('.find-bar')).toHaveCount(0)
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.md')
  })

  test('T-KEY-05: ⌘W on a working session confirms first — Esc/⏎ both cancel, only Close kills it, and the row stays cold', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    gitInit(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    const [session] = await waitForCalls(env, 1)
    const row = wsRows(page, 'ws-a').first()

    await runIn(page, centerTerm(page), '/busy')
    await expect(row).toHaveClass(/\bst-working\b/, { timeout: 30_000 })

    const dialog = page.locator('.modal', { hasText: 'Close running session?' })
    const raise = async (): Promise<void> => {
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(dialog).toBeVisible({ timeout: 15_000 })
    }

    await centerTerm(page).click()
    await raise()
    await snap(page, 'T-KEY-05')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(processAlive(session.pid)).toBe(true)
    await expect(row).not.toHaveClass(/\bcold\b/)

    await row.click()
    await raise()
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveCount(0)
    await page.waitForTimeout(2000)
    expect(processAlive(session.pid)).toBe(true)
    await expect(row).not.toHaveClass(/\bcold\b/)

    await raise()
    // CC§1
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => processAlive(session.pid), { timeout: 30_000 }).toBe(false)
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 40_000 })
    await expect(wsRows(page, 'ws-a')).toHaveCount(1)
  })

  test('T-KEY-06: ⌘W on a waiting session closes it silently and leaves a cold row', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(240_000)
    gitInit(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    const [session] = await waitForCalls(env, 1)
    const row = wsRows(page, 'ws-a').first()
    await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 40_000 })

    await row.click()
    await sendShortcut(app, 'shortcut:close-tab')
    await expect.poll(() => processAlive(session.pid), { timeout: 30_000 }).toBe(false)
    await expect(page.locator('.modal-backdrop')).toHaveCount(0)
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 40_000 })
    await expect(wsRows(page, 'ws-a')).toHaveCount(1)
    await snap(page, 'T-KEY-06')
  })
})
