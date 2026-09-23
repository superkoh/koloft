import { test, expect } from './helpers/app'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { clickAppMenuItem, startSessionIn } from './helpers/p1'
import { layoutState, workbenchPanel } from './helpers/workbench'

async function toggleFull(app: ElectronApplication, page: Page): Promise<void> {
  await clickAppMenuItem(app, page, 'toggle-focus-mode')
}

const viewSwitch = (page: Page): ReturnType<Page['locator']> =>
  page.locator('.wb-bar .seg[aria-label="Files view"]')
const baseBtn = (page: Page): ReturnType<Page['locator']> =>
  page.locator('.wb-bar .seg button', { hasText: /base|vs HEAD/ })
const filterBtn = (page: Page): ReturnType<Page['locator']> =>
  page.locator('.wb-bar .seg button', { hasText: 'Filter' })
const filesMenu = (page: Page): ReturnType<Page['locator']> => page.locator('.wb-bar .fv-menu')

async function dismissWorktreeHintCardCoveringTheRows(page: Page): Promise<void> {
  await page
    .locator('.hint-card[data-hint="worktree"]')
    .getByRole('button', { name: 'Got it', exact: true })
    .click()
}

test.describe('Workbench files tab shell: view switch, base picker, filter menu and their Esc rungs', () => {
  test('WB-K05c: Esc closes the base menu first, and only the next Esc leaves T3 — never closing a tab or collapsing to T1', async ({
    app,
    page
  }) => {
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await toggleFull(app, page)
    await expect.poll(() => layoutState(page)).toBe('T3')

    const tabsBefore = await page.locator('.wb-tab').count()

    await baseBtn(page).click()
    await expect(filesMenu(page)).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(filesMenu(page)).toHaveCount(0)
    expect(await layoutState(page)).toBe('T3')

    await page.keyboard.press('Escape')
    await expect.poll(() => layoutState(page)).toBe('T2')
    expect(await page.locator('.wb-tab').count()).toBe(tabsBefore)
  })

  test('WB-K05d: Esc closes the Browse search row first — even with the focus elsewhere in the panel — and only the next Esc leaves T3', async ({
    app,
    page
  }) => {
    const searchInput = page.locator('.wb-panel .ft-search-input')

    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await toggleFull(app, page)
    await expect.poll(() => layoutState(page)).toBe('T3')

    await clickAppMenuItem(app, page, 'find-files')
    await expect(searchInput).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(searchInput).toHaveCount(0)
    expect(await layoutState(page)).toBe('T3')

    await page.keyboard.press('Escape')
    await expect.poll(() => layoutState(page)).toBe('T2')

    await clickAppMenuItem(app, page, 'find-files')
    await expect(searchInput).toBeFocused()
    await page.locator('.wb-panel .wb-bar .icobtn[aria-label="Reload"]').click()
    await page.keyboard.press('Escape')
    await expect(searchInput).toHaveCount(0)
    expect(await layoutState(page)).toBe('T2')
  })

  test('WB-B02: ⌘⇧F does nothing without a session, else expands to T2, activates Files and focuses search; a second press closes and clears it but keeps T2', async ({
    app,
    page
  }) => {
    const findFiles = (): Promise<void> => clickAppMenuItem(app, page, 'find-files')
    const searchInput = page.locator('.wb-panel .ft-search-input')

    await findFiles()
    await expect(workbenchPanel(page)).toHaveCount(0)

    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await clickAppMenuItem(app, page, 'toggle-browser')
    await expect.poll(() => layoutState(page)).toBe('T1')

    await findFiles()
    await expect.poll(() => layoutState(page)).toBe('T2')
    await expect(page.locator('.fv')).toHaveAttribute('data-view', 'browse')
    await expect(searchInput).toBeFocused()

    await searchInput.fill('workbench')
    await expect(searchInput).toHaveValue('workbench')

    await findFiles()
    await expect(searchInput).toHaveCount(0)
    expect(await layoutState(page)).toBe('T2')

    await findFiles()
    await expect(searchInput).toHaveValue('')
  })

  test('WB-B02b: after switching from Browse to Changes with the search row open, one ⌘⇧F lands on Browse with the search box open, not on a stale toggle that closes it', async ({
    app,
    page
  }) => {
    const searchInput = page.locator('.wb-panel .ft-search-input')
    const changesBtn = (): Locator => viewSwitch(page).locator('button').first()

    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

    await clickAppMenuItem(app, page, 'find-files')
    await expect(page.locator('.fv')).toHaveAttribute('data-view', 'browse')
    await expect(searchInput).toBeFocused()

    await changesBtn().click()
    await expect(page.locator('.fv')).toHaveAttribute('data-view', 'changes')
    await expect(searchInput).toHaveCount(0)

    await clickAppMenuItem(app, page, 'find-files')
    await expect(page.locator('.fv')).toHaveAttribute('data-view', 'browse')
    await expect(searchInput).toBeFocused()
  })

  test('WB-C05: the view, the base choice and the filter chips stay with their session across a switch', async ({
    page
  }) => {
    await startSessionIn(page, 'ws-a')
    await startSessionIn(page, 'ws-a')
    const rows = page.locator('.ws-tab')
    await expect(rows).toHaveCount(2, { timeout: 25_000 })
    await dismissWorktreeHintCardCoveringTheRows(page)
    const rowB = rows.nth(0)
    const rowA = rows.nth(1)
    const browseBtn = (): Locator => viewSwitch(page).locator('button').nth(1)
    const changesBtn = (): Locator => viewSwitch(page).locator('button').first()

    await rowA.click()
    await expect(workbenchPanel(page)).toBeVisible()

    await baseBtn(page).click()
    await filesMenu(page).getByRole('menuitemradio', { name: 'vs HEAD' }).click()
    await expect(baseBtn(page)).toHaveText(/vs HEAD/)

    await filterBtn(page).click()
    await page.locator('.fv-filters .ft-chip[data-chip="docs"]').click()
    await expect(page.locator('.fv-filters .ft-chip[data-chip="docs"]')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await page.keyboard.press('Escape')
    await browseBtn().click()
    await expect(browseBtn()).toHaveAttribute('aria-pressed', 'true')

    await rowB.click()
    await expect(workbenchPanel(page)).toBeVisible()
    await expect(changesBtn()).toHaveAttribute('aria-pressed', 'true')
    await expect(baseBtn(page)).toHaveText(/base/)

    await rowA.click()
    await expect(browseBtn()).toHaveAttribute('aria-pressed', 'true')
    await changesBtn().click()
    await expect(baseBtn(page)).toHaveText(/vs HEAD/)
    await filterBtn(page).click()
    await expect(page.locator('.fv-filters .ft-chip[data-chip="docs"]')).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })
})
