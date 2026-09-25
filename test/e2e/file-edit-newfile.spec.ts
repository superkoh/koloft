import fs from 'fs'
import path from 'path'
import { test, expect } from './helpers/app'
import type { Locator, Page } from '@playwright/test'
import { startSessionIn } from './helpers/p1'
import { setupChangeFixture } from './helpers/filesFixture'
import { seedEditFixture } from './helpers/editFixture'
import {
  WORKBENCH,
  browseRow,
  rowMenu,
  showBrowse,
  wbTabs,
  workbenchPanel
} from './helpers/workbench'
import { EDIT, closeDiscardingEdits, editArea, editText, sendSave } from './helpers/editPane'

const nameBox = (page: Page): Locator => page.locator(EDIT.newFileInput)

const NEWFILE_ERR = '.ft-newfile-err'

async function waitCreateRefused(page: Page, wording: RegExp): Promise<void> {
  await expect(page.locator(NEWFILE_ERR)).toHaveText(wording, { timeout: 20_000 })
}

async function startNewFile(page: Page, dirAbs: string): Promise<void> {
  await browseRow(page, dirAbs).click({ button: 'right' })
  await expect(rowMenu(page)).toBeVisible()
  await rowMenu(page).getByText('New File…', { exact: true }).click()
  await expect(nameBox(page)).toBeVisible({ timeout: 20_000 })
}

async function browseReady(page: Page, root: string): Promise<void> {
  await showBrowse(page)
  await expect(browseRow(page, root)).toBeVisible({ timeout: 30_000 })
  const dir = browseRow(page, `${root}/config`)
  await expect(dir).toBeVisible({ timeout: 30_000 })
  if (!(await dir.getAttribute('class'))?.split(/\s+/).includes('open')) await dir.click()
  await expect(dir).toHaveClass(/\bopen\b/, { timeout: 20_000 })
}

test.describe('File edit · New File…, with refusals asserted on disk', () => {
  test('BB-M07: New File… creates an empty file and opens it in edit mode, whose first save goes through', async ({
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

    const made = path.join(ed.configDir, 'fresh.conf')
    expect(fs.existsSync(made)).toBe(false)
    const tabsBefore = await wbTabs(page).count()

    await startNewFile(page, ed.configDir)
    await nameBox(page).fill('fresh.conf')
    await nameBox(page).press('Enter')

    await expect.poll(() => fs.existsSync(made), { timeout: 20_000 }).toBe(true)
    expect(fs.readFileSync(made, 'utf8')).toBe('')

    await expect(wbTabs(page)).toHaveCount(tabsBefore + 1, { timeout: 25_000 })
    const madeTab = page.locator(`${WORKBENCH.tab}:not(.pinned)`).first()
    await expect(editArea(page)).toBeVisible({ timeout: 25_000 })
    expect(await editText(page)).toBe('')
    await expect(page.locator(EDIT.tabEdit)).toHaveClass(/\bon\b/)
    await expect(page.locator(EDIT.dirty)).toHaveCount(0)

    await page.locator(WORKBENCH.tabFiles).click()
    await expect(browseRow(page, made)).toBeVisible({ timeout: 25_000 })

    await madeTab.click()
    await expect(editArea(page)).toBeVisible({ timeout: 20_000 })
    await editArea(page).click()
    await page.keyboard.type('KOLOFT_E2E_FRESH=1')
    await sendSave(app)
    await expect
      .poll(() => fs.readFileSync(made, 'utf8'), { timeout: 20_000 })
      .toBe('KOLOFT_E2E_FRESH=1')
    await expect(page.locator(EDIT.stale)).toHaveCount(0)
    await closeDiscardingEdits(app)
  })

  test('BB-C17: a name containing / or .. is refused by name, in place, and creates nothing anywhere', async ({
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

    await startNewFile(page, ed.configDir)
    await nameBox(page).fill('a/b.txt')
    await nameBox(page).press('Enter')

    await waitCreateRefused(page, /Just a file name/)
    await expect(nameBox(page)).toBeVisible()
    await expect(editArea(page)).toHaveCount(0)
    expect(fs.existsSync(path.join(ed.configDir, 'a'))).toBe(false)
    expect(fs.existsSync(path.join(ed.configDir, 'a', 'b.txt'))).toBe(false)

    await nameBox(page).fill('../escaped.txt')
    await nameBox(page).press('Enter')
    await waitCreateRefused(page, /Just a file name/)
    await expect(nameBox(page)).toBeVisible()
    expect(fs.existsSync(path.join(fx.root, 'escaped.txt'))).toBe(false)

    await nameBox(page).fill('ok.conf')
    await nameBox(page).press('Enter')
    await expect
      .poll(() => fs.existsSync(path.join(ed.configDir, 'ok.conf')), { timeout: 20_000 })
      .toBe(true)
    await closeDiscardingEdits(app)
  })

  test('BB-C18: an existing name is refused and the file it names is not touched (not even truncated)', async ({
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

    const before = fs.statSync(ed.config).mtimeMs
    await startNewFile(page, ed.configDir)
    await nameBox(page).fill('app.json')
    await nameBox(page).press('Enter')

    await waitCreateRefused(page, /That name is taken/)
    await expect(nameBox(page)).toBeVisible()
    await expect(editArea(page)).toHaveCount(0)
    expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)
    expect(fs.statSync(ed.config).mtimeMs).toBe(before)
    await closeDiscardingEdits(app)
  })
})
