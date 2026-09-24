import fs from 'fs'
import { test, expect } from './helpers/app'
import type { Locator, Page } from '@playwright/test'
import { startSessionIn } from './helpers/p1'
import { setupChangeFixture } from './helpers/filesFixture'
import { seedEditFixture, type EditFixture } from './helpers/editFixture'
import { WORKBENCH, browseRow, showBrowse, workbenchPanel } from './helpers/workbench'
import {
  EDIT,
  closeDiscardingEdits,
  editArea,
  editReady,
  editText,
  sendSave,
  typeAtEnd
} from './helpers/editPane'

const MINE = 'KOLOFT_E2E_MINE=1'

const stale = (page: Page): Locator => page.locator(EDIT.stale)
const conflict = (page: Page): Locator => page.locator(EDIT.conflict)

function overwriteChangingSizeAndMtime(ed: EditFixture): string {
  const body = ed.configBody.replace('30000', '45000') + 'EXTERNAL_LINE=1\n'
  fs.writeFileSync(ed.config, body)
  return body
}

function expectSaveWroteNothing(ed: EditFixture, theirs: string): void {
  expect(fs.readFileSync(ed.config, 'utf8')).toBe(theirs)
}

async function dirtyEditor(page: Page, root: string, ed: EditFixture): Promise<string> {
  await showBrowse(page)
  await expect(browseRow(page, root)).toBeVisible({ timeout: 30_000 })
  const dir = browseRow(page, `${root}/config`)
  await expect(dir).toBeVisible({ timeout: 30_000 })
  await dir.click()
  const file = browseRow(page, ed.config)
  await expect(file).toBeVisible({ timeout: 20_000 })
  await file.click({ button: 'right' })
  await expect(page.locator(WORKBENCH.rowMenuOnPage)).toBeVisible()
  await page.locator(WORKBENCH.rowMenuOnPage).getByText('Edit', { exact: true }).click()
  await editReady(page, 'koloft-e2e-edit-fixture')
  await typeAtEnd(page, MINE)
  await page.keyboard.press('Enter')
  await expect(page.locator(EDIT.dirty)).toBeVisible()
  return ed.configBody + MINE + '\n'
}

test.describe('File edit · a save onto a file the disk changed under you', () => {
  test('BB-M08: a save onto a changed file writes nothing, shows the difference, and Keep mine (offered only after Show diff) then wins', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

    const mine = await dirtyEditor(page, fx.root, ed)
    const theirs = overwriteChangingSizeAndMtime(ed)

    await sendSave(app)

    await expect(stale(page)).toBeVisible({ timeout: 20_000 })
    await expect(stale(page)).toContainText(EDIT.staleText)
    await expect(stale(page).getByRole('button', { name: 'Show diff' })).toBeVisible()
    await expect(stale(page).getByRole('button', { name: 'Reload' })).toBeVisible()
    expect(await editText(page)).toBe(mine)
    await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)

    expectSaveWroteNothing(ed, theirs)

    await stale(page).getByRole('button', { name: 'Show diff' }).click()
    await expect(conflict(page)).toBeVisible({ timeout: 20_000 })
    await expect(conflict(page)).toContainText('EXTERNAL_LINE=1')
    await expect(conflict(page)).toContainText(MINE)
    await expect(stale(page).getByRole('button', { name: 'Keep mine' })).toHaveCount(0)
    await expect(conflict(page).getByRole('button', { name: 'Keep mine' })).toBeVisible()
    await expect(conflict(page).getByRole('button', { name: 'Reload' })).toBeVisible()

    await conflict(page).getByRole('button', { name: 'Keep mine' }).click()

    await expect.poll(() => fs.readFileSync(ed.config, 'utf8'), { timeout: 20_000 }).toBe(mine)
    await expect(conflict(page)).toHaveCount(0, { timeout: 20_000 })
    await expect(stale(page)).toHaveCount(0)
    await expect(page.locator(EDIT.tabDirty)).toHaveCount(0)
    await expect(page.locator(EDIT.dirty)).toHaveCount(0)
    await closeDiscardingEdits(app)
  })

  test('BB-M09: Reload replaces the textarea value with what is on disk, clears the unsaved mark, and the next save goes through', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

    const mine = await dirtyEditor(page, fx.root, ed)
    const theirs = overwriteChangingSizeAndMtime(ed)

    await sendSave(app)
    await expect(stale(page)).toBeVisible({ timeout: 20_000 })
    expect(await editText(page)).toBe(mine)

    await stale(page).getByRole('button', { name: 'Reload' }).click()

    await expect.poll(() => editText(page), { timeout: 20_000 }).toBe(theirs)
    await expect(stale(page)).toHaveCount(0)
    await expect(page.locator(EDIT.dirty)).toHaveCount(0)
    await expect(page.locator(EDIT.tabDirty)).toHaveCount(0)
    expect(fs.readFileSync(ed.config, 'utf8')).toBe(theirs)

    await typeAtEnd(page, 'KOLOFT_E2E_AFTER_RELOAD=1')
    await page.keyboard.press('Enter')
    await sendSave(app)
    await expect
      .poll(() => fs.readFileSync(ed.config, 'utf8'), { timeout: 20_000 })
      .toBe(theirs + 'KOLOFT_E2E_AFTER_RELOAD=1\n')
    await expect(editArea(page)).toBeVisible()
    await closeDiscardingEdits(app)
  })
})
