import { test, expect } from './helpers/app'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { clickAppMenuItem, startSessionIn } from './helpers/p1'
import { layoutState, workbenchPanel } from './helpers/workbench'

/**
 * Workbench · the `files` tab's SHELL.
 *
 * The shell is `FilesView`'s own surface — the Changes/Browse switch, the base picker, the
 * filter menu and the reading area's header — as opposed to what the two halves render
 * inside it. The cases here are the ones that hold whichever way Changes and Browse are
 * implemented, which is exactly why they belong in their own file: they must keep failing
 * for the shell's reasons, not for a stream's.
 *
 * Accelerator convention (test/CLAUDE.md): native menu accelerators are unreachable from
 * Playwright's synthetic keys, so each is driven by its menu item id.
 */

/** ⌘⏎ — T2↔T3 (FR-05). */
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

// WB-K05c (FR-54) — the ladder's THIRD rung. The first Esc must take the menu and stop
// there; only the second one steps the layout down. The interesting half is the "stop
// there": a ladder that ran two rungs on one press would look right in a screenshot and be
// wrong for every user who opened a menu by accident in T3.
test('WB-K05c: Esc closes the base menu first, and only the next Esc leaves T3', async ({
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

  // Esc is a panel key, so the panel has to hold the focus — the menu itself takes it on
  // open, which is what makes this the realistic gesture rather than a contrived one.
  await page.keyboard.press('Escape')
  await expect(filesMenu(page)).toHaveCount(0)
  expect(await layoutState(page)).toBe('T3')

  await page.keyboard.press('Escape')
  await expect.poll(() => layoutState(page)).toBe('T2')
  // FR-54: the ladder never closes a tab and never collapses to T1
  expect(await page.locator('.wb-tab').count()).toBe(tabsBefore)
})

// WB-K05d (FR-54, FR-45) — the same rung as WB-K05c, for Browse's SEARCH ROW. The search
// input owns an Esc handler of its own, so a ladder with no rung for it still LOOKED
// right: the row closed. What it also did was fall through and take T3 down with it,
// spending one press on two rungs — the exact failure WB-K05c bars, arriving by another
// door.
test('WB-K05d: Esc closes the Browse search row first, and only the next Esc leaves T3', async ({
  app,
  page
}) => {
  const searchInput = page.locator('.wb-panel .ft-search-input')

  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
  await toggleFull(app, page)
  await expect.poll(() => layoutState(page)).toBe('T3')

  // ⌘⇧F is the product's own way in (WB-B02) and it leaves the focus IN the input, which
  // is what makes Esc a panel key here at all — App routes it by focus.
  await clickAppMenuItem(app, page, 'find-files')
  await expect(searchInput).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(searchInput).toHaveCount(0)
  // the assertion carrying the case: one press, one rung
  expect(await layoutState(page)).toBe('T3')

  await page.keyboard.press('Escape')
  await expect.poll(() => layoutState(page)).toBe('T2')

  // The other half of the rung, and the reason it cannot simply consume the press: with
  // the row open but the focus elsewhere in the panel, the input's own handler never runs,
  // so CLOSING the row is this rung's own job.
  await clickAppMenuItem(app, page, 'find-files')
  await expect(searchInput).toBeFocused()
  await page.locator('.wb-panel .wb-bar .icobtn[aria-label="Reload"]').click()
  await page.keyboard.press('Escape')
  await expect(searchInput).toHaveCount(0)
  expect(await layoutState(page)).toBe('T2')
})

// WB-B02 (FR-45) — ⌘⇧F is one of the three GLOBAL keys FR-20's blanket exempts, so it has
// to work from a collapsed panel and from a tab that is not the pinned one. The second
// press is the half that is easy to get wrong: it closes AND clears, wherever the focus
// sits, and it leaves the panel expanded rather than undoing the expansion the first press
// caused.
test('WB-B02: ⌘⇧F expands to T2, activates Files and focuses search; a second press clears it', async ({
  app,
  page
}) => {
  const findFiles = (): Promise<void> => clickAppMenuItem(app, page, 'find-files')
  const searchInput = page.locator('.wb-panel .ft-search-input')

  // FR-45's last sentence: no active session, no effect. Asserted BEFORE a session exists,
  // which is the only state where "nothing happened" is unambiguous.
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
  // the panel stays expanded — the toggle is the search row's, not the layout's
  expect(await layoutState(page)).toBe('T2')

  // …and the query went with it: reopening starts empty rather than restoring the last one
  await findFiles()
  await expect(searchInput).toHaveValue('')
})

// WB-C05 — the view, the base and the filters belong to the conversation. A trip to
// another session and back finds them exactly where they were left, and the other session
// is untouched: the panel is one instance for every tab, so the cheap implementation (one
// set of state in a component that never unmounts) fails only here.
test('WB-C05: the view, the base choice and the filter chips stay with their session across a switch', async ({
  page
}) => {
  await startSessionIn(page, 'ws-a')
  await startSessionIn(page, 'ws-a')
  const rows = page.locator('.ws-tab')
  await expect(rows).toHaveCount(2, { timeout: 25_000 })
  // a second session in one workspace earns the 'worktree' tip, whose card sits
  // over the row this case clicks; dismiss it the way a person would
  await page
    .locator('.hint-card[data-hint="worktree"]')
    .getByRole('button', { name: 'Got it', exact: true })
    .click()
  const rowB = rows.nth(0)
  const rowA = rows.nth(1)
  const browseBtn = (): Locator => viewSwitch(page).locator('button').nth(1)
  const changesBtn = (): Locator => viewSwitch(page).locator('button').first()

  await rowA.click()
  await expect(workbenchPanel(page)).toBeVisible()

  // …switch A off both defaults, then over to Browse
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

  // B is another session: it starts at the defaults
  await rowB.click()
  await expect(workbenchPanel(page)).toBeVisible()
  await expect(changesBtn()).toHaveAttribute('aria-pressed', 'true')
  await expect(baseBtn(page)).toHaveText(/base/)

  // back on A: Browse, vs HEAD and the docs chip, all as left
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
