import fs from 'fs'
import { test, expect, launchApp } from './helpers/app'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import type { E2EEnv } from './helpers/env'
import { startSessionIn, waitBooted } from './helpers/p1'
import { setupChangeFixture } from './helpers/filesFixture'
import { seedEditFixture } from './helpers/editFixture'
import { WORKBENCH, browseRow, showBrowse, workbenchPanel } from './helpers/workbench'
import { EDIT, closeDiscardingEdits } from './helpers/editPane'

test.describe('Show ignored files: off hides every ignored entry; on shows everything and marks the ignored ones, directories included', () => {
  const chip = (page: Page): Locator => page.locator(`.wb-panel ${EDIT.showIgnored}`)
  const searchToggle = (page: Page): Locator =>
    page.locator('.wb-bar .icobtn[aria-label="Search files"]')
  const searchInput = (page: Page): Locator => page.locator('.wb-panel .ft-search-input')
  const ctxMenu = (page: Page): Locator => page.locator(WORKBENCH.rowMenuOnPage)
  const searchRanAndFoundNothing = (page: Page): Locator => page.locator('.wb-panel .bv-nomatch')

  async function browseReady(page: Page, root: string): Promise<void> {
    await showBrowse(page)
    await expect(browseRow(page, root)).toBeVisible({ timeout: 30_000 })
    await expect(browseRow(page, `${root}/config`)).toBeVisible({ timeout: 30_000 })
  }

  async function relaunchOnSameHome(
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

  test('BB-M01 (A-01, A-02, A-03, A-05): the Show-ignored switch reveals every ignored entry, directories included and marked, and both on and off survive a restart', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await browseReady(page, fx.root)

    await expect(chip(page)).toHaveText('Show ignored files')
    await expect(chip(page)).not.toHaveClass(/\bon\b/)
    await expect(browseRow(page, ed.env)).toHaveCount(0)
    await expect(browseRow(page, ed.venvDir)).toHaveCount(0)

    await chip(page).click()
    await expect(chip(page)).toHaveClass(/\bon\b/)
    await expect(browseRow(page, ed.env)).toBeVisible({ timeout: 20_000 })
    await expect(browseRow(page, ed.env)).toHaveClass(/\bignored\b/)
    await expect(browseRow(page, ed.env)).toHaveAttribute('title', EDIT.ignoredTitle)

    for (const dir of [ed.venvDir, fx.paths.ignoredDir]) {
      await expect(browseRow(page, dir)).toBeVisible({ timeout: 20_000 })
      await expect(browseRow(page, dir)).toHaveClass(/\bignored\b/)
      await expect(browseRow(page, dir)).toHaveAttribute('title', EDIT.ignoredTitle)
    }
    await expect(browseRow(page, fx.paths.heavyDir)).toBeVisible({ timeout: 20_000 })
    await expect(browseRow(page, fx.paths.heavyDir)).toHaveClass(/\bignored\b/)
    await expect(browseRow(page, fx.paths.heavyDir)).toHaveAttribute(
      'title',
      EDIT.hiddenByDefaultTitle
    )
    await expect(browseRow(page, ed.venvFile)).toHaveCount(0)
    await browseRow(page, ed.venvDir).click()
    await expect(browseRow(page, ed.venvFile)).toBeVisible({ timeout: 20_000 })
    await expect(browseRow(page, ed.venvFile)).toHaveClass(/\bignored\b/)
    await browseRow(page, ed.venvDir).click()
    await expect(browseRow(page, `${fx.root}/docs`)).toBeVisible()

    const restarted = await relaunchOnSameHome(app, env)
    await startSessionIn(restarted.page, 'ws-a')
    await expect(workbenchPanel(restarted.page)).toBeVisible({ timeout: 25_000 })
    await browseReady(restarted.page, fx.root)
    await expect(chip(restarted.page)).toHaveClass(/\bon\b/, { timeout: 20_000 })
    await expect(browseRow(restarted.page, ed.env)).toBeVisible({ timeout: 25_000 })

    await chip(restarted.page).click()
    await expect(browseRow(restarted.page, ed.env)).toHaveCount(0, { timeout: 20_000 })
    await expect(browseRow(restarted.page, ed.venvDir)).toHaveCount(0)
    await expect(browseRow(restarted.page, fx.paths.heavyDir)).toHaveCount(0)

    const again = await relaunchOnSameHome(restarted.app, env)
    await startSessionIn(again.page, 'ws-a')
    await expect(workbenchPanel(again.page)).toBeVisible({ timeout: 25_000 })
    await browseReady(again.page, fx.root)
    await expect(chip(again.page)).not.toHaveClass(/\bon\b/, { timeout: 20_000 })
    await expect(browseRow(again.page, ed.env)).toHaveCount(0)

    await closeDiscardingEdits(again.app)
  })

  test('BB-M02 (A-04): find-by-name follows the same switch, reaching inside ignored directories only when it is on', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await browseReady(page, fx.root)

    const hit = (abs: string): Locator => page.locator(`.wb-panel .ft-result[data-path="${abs}"]`)

    await searchToggle(page).click()
    await expect(searchInput(page)).toBeFocused()

    await searchInput(page).fill('app.json')
    await expect(hit(ed.config)).toBeVisible({ timeout: 25_000 })
    await searchInput(page).fill('.env')
    await expect(searchRanAndFoundNothing(page)).toBeVisible({ timeout: 25_000 })
    await expect(hit(ed.env)).toHaveCount(0)
    await searchInput(page).fill('token.txt')
    await expect(searchRanAndFoundNothing(page)).toBeVisible({ timeout: 25_000 })
    await expect(hit(fx.paths.ignoredFile)).toHaveCount(0)
    await searchInput(page).fill('index.js')
    await expect(searchRanAndFoundNothing(page)).toBeVisible({ timeout: 25_000 })
    await expect(hit(fx.paths.heavyFile)).toHaveCount(0)

    await searchToggle(page).click()
    await chip(page).click()
    await expect(chip(page)).toHaveClass(/\bon\b/)
    await searchToggle(page).click()

    await searchInput(page).fill('.env')
    await expect(hit(ed.env)).toBeVisible({ timeout: 25_000 })
    await expect(hit(ed.env)).toHaveClass(/\bignored\b/)

    for (const [query, present] of [
      ['x.txt', ed.venvFile],
      ['token.txt', fx.paths.ignoredFile],
      ['index.js', fx.paths.heavyFile]
    ] as const) {
      await searchInput(page).fill(query)
      await expect(hit(present)).toBeVisible({ timeout: 25_000 })
      await expect(hit(present)).toHaveClass(/\bignored\b/)
    }

    await searchInput(page).fill('.venv')
    await expect(hit(ed.venvFile)).toBeVisible({ timeout: 25_000 })
    await expect(hit(ed.venvDir)).toHaveCount(0)
    await closeDiscardingEdits(app)
  })

  test('BB-M03 (A-06): a file row can be handed to the system default app, recorded at the leaveForOS choke point', async ({
    app,
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await browseReady(page, fx.root)

    expect(fs.existsSync(env.externalOpens)).toBe(false)

    await browseRow(page, `${fx.root}/config`).click()
    await expect(browseRow(page, `${fx.root}/config/app.json`)).toBeVisible({ timeout: 20_000 })
    await browseRow(page, `${fx.root}/config/app.json`).click({ button: 'right' })
    await expect(ctxMenu(page)).toBeVisible()
    expect(await page.locator(WORKBENCH.rowMenuItemOnPage).allTextContents()).toContain(
      'Open with default app'
    )
    await ctxMenu(page).getByText('Open with default app', { exact: true }).click()

    await expect
      .poll(
        () => (fs.existsSync(env.externalOpens) ? fs.readFileSync(env.externalOpens, 'utf8') : ''),
        {
          timeout: 20_000
        }
      )
      .toContain(ed.config)
    await closeDiscardingEdits(app)
  })
})
