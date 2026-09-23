import fs from 'fs'
import { test, expect } from './helpers/app'
import type { Locator, Page } from '@playwright/test'
import { startSessionIn, wsRows } from './helpers/p1'
import { setupChangeFixture } from './helpers/filesFixture'
import { seedEditFixture } from './helpers/editFixture'
import { WORKBENCH, showBrowse, wbTabs, workbenchPanel } from './helpers/workbench'
import {
  EDIT,
  editArea,
  editReady,
  editText,
  closeDiscardingEdits,
  saveMenuEnabled,
  sendSave,
  typeAtEnd
} from './helpers/editPane'

const MARKER = 'KOLOFT_E2E_EDIT_MARKER=1'

function row(page: Page, abs: string, section = 'tree'): Locator {
  return page.locator(`.wb-panel .bv-sec[data-section="${section}"] .ft-node[data-path="${abs}"]`)
}

const ctxMenu = (page: Page): Locator => page.locator(EDIT.ctxMenu)
const tabReload = (page: Page): Locator =>
  page.locator('.wb-bar:not(.fv-artifact-hd) .icobtn[aria-label="Reload"]')
const halfBtn = (page: Page, name: 'Changes' | 'Browse'): Locator =>
  page.locator('.wb-bar .seg[aria-label="Files view"] button', { hasText: name })

async function browseReady(page: Page, root: string): Promise<void> {
  await showBrowse(page)
  await expect(row(page, root)).toBeVisible({ timeout: 30_000 })
  await expect(row(page, `${root}/config`)).toBeVisible({ timeout: 30_000 })
}

async function treeRow(page: Page, root: string, abs: string): Promise<Locator> {
  const segs = abs.slice(root.length + 1).split('/')
  let dir = root
  for (const seg of segs.slice(0, -1)) {
    dir += '/' + seg
    const r = row(page, dir)
    await expect(r).toBeVisible({ timeout: 20_000 })
    if (!(await r.getAttribute('class'))?.split(/\s+/).includes('open')) await r.click()
    await expect(r).toHaveClass(/\bopen\b/, { timeout: 20_000 })
  }
  return row(page, abs)
}

async function editViaMenu(page: Page, root: string, abs: string): Promise<void> {
  const r = await treeRow(page, root, abs)
  await r.click({ button: 'right' })
  await expect(ctxMenu(page)).toBeVisible()
  expect((await page.locator(EDIT.ctxItem).allTextContents())[0]).toBe('Edit')
  await ctxMenu(page).getByText('Edit', { exact: true }).click()
}

test.describe('File edit · getting in, typing, and ⌘S, asserted on disk byte for byte', () => {
  test('BB-M04: the row menu opens a file (Edit is its first item) straight into an editor holding its exact bytes, the strip reports line, column and endings, and Tab leaves the box', async ({
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

    const tabsBefore = await wbTabs(page).count()
    await editViaMenu(page, fx.root, ed.config)

    await expect(wbTabs(page)).toHaveCount(tabsBefore + 1, { timeout: 25_000 })
    await expect(page.locator(EDIT.tabEdit)).toHaveClass(/\bon\b/, { timeout: 20_000 })
    await editReady(page, 'koloft-e2e-edit-fixture')
    expect(await editText(page)).toBe(ed.configBody)

    await expect(page.locator(EDIT.eol)).toHaveText('LF')
    await expect(page.locator(EDIT.pos)).toHaveText(/^Ln \d+, Col \d+$/)
    await expect(page.locator(EDIT.dirty)).toHaveCount(0)

    await editArea(page).click()
    for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown')
    await page.keyboard.press('End')
    await expect(page.locator(EDIT.pos)).toHaveText('Ln 6, Col 1')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('End')
    await expect(page.locator(EDIT.pos)).toHaveText('Ln 5, Col 2')

    const before = await editText(page)
    await editArea(page).click()
    await page.keyboard.press('Tab')
    expect(await editText(page)).toBe(before)
    await expect(editArea(page)).not.toBeFocused()
    await closeDiscardingEdits(app)
  })

  test('BB-M04b: a CRLF file opens for editing and the strip says CRLF', async ({
    app,
    page,
    env
  }) => {
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await browseReady(page, fx.root)

    await editViaMenu(page, fx.root, ed.crlf)
    await editReady(page, 'koloft-e2e-crlf')
    await expect(page.locator(EDIT.eol)).toHaveText('CRLF')
    // PLATFORM§24
    await expect(page.locator(EDIT.readOnly)).toHaveCount(0)
    await closeDiscardingEdits(app)
  })

  test('BB-M05: ⌘S writes the file and the change set follows; a clean ⌘S is a no-op and nothing is written before ⌘S', async ({
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

    await editViaMenu(page, fx.root, ed.config)
    await editReady(page, 'koloft-e2e-edit-fixture')

    const mtimeBefore = fs.statSync(ed.config).mtimeMs
    expect(await saveMenuEnabled(app)).toBe(false)
    await sendSave(app)
    await expect(page.locator(EDIT.dirty)).toHaveCount(0)

    await typeAtEnd(page, MARKER)
    await page.keyboard.press('Enter')
    await expect(page.locator(EDIT.dirty)).toBeVisible()
    expect(fs.statSync(ed.config).mtimeMs).toBe(mtimeBefore)
    await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)
    await expect.poll(() => saveMenuEnabled(app), { timeout: 10_000 }).toBe(true)
    expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)

    await sendSave(app)

    await expect
      .poll(() => fs.readFileSync(ed.config, 'utf8'), { timeout: 20_000 })
      .toBe(ed.configBody + MARKER + '\n')

    await expect(page.locator(EDIT.tabDirty)).toHaveCount(0, { timeout: 20_000 })
    await expect(page.locator(EDIT.dirty)).toHaveCount(0)
    await expect(page.locator(EDIT.status)).toHaveText(/Saved \d{2}:\d{2}:\d{2}/, {
      timeout: 20_000
    })

    await page.locator(WORKBENCH.tabFiles).click()
    await halfBtn(page, 'Changes').click()
    const rel = ed.rel(ed.config)
    const blk = page.locator(`.wb-panel .cv-blk[data-path="${rel}"][data-ready="1"]`)
    await expect(blk).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.wb-panel .cv-row')).toHaveCount(1)
    await expect(blk.locator('.idiff-row.idiff-add .idiff-code', { hasText: MARKER })).toHaveCount(
      1
    )
    await closeDiscardingEdits(app)
  })

  test('BB-M06: the reading area’s ✎ promotes the file to its own tab, and the reading area stays read-only', async ({
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

    const r = await treeRow(page, fx.root, ed.config)
    await r.click()
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('config/app.json', {
      timeout: 25_000
    })
    const tabsBefore = await wbTabs(page).count()
    await expect(page.locator(`.fv-read ${EDIT.pane}`)).toHaveCount(0)

    await page.locator(EDIT.readEdit).click()

    await expect(wbTabs(page)).toHaveCount(tabsBefore + 1, { timeout: 25_000 })
    await editReady(page, 'koloft-e2e-edit-fixture')
    await expect(page.locator(EDIT.tabEdit)).toHaveClass(/\bon\b/)
    await expect(page.locator(`.fv-read ${EDIT.pane}`)).toHaveCount(0)
    await closeDiscardingEdits(app)
  })

  test('BB-M11: leaving the tab and coming back asks nothing and keeps the text, the dirty mark and the caret', async ({
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

    await editViaMenu(page, fx.root, ed.config)
    await editReady(page, 'koloft-e2e-edit-fixture')
    await typeAtEnd(page, MARKER)

    const wanted = ed.configBody + MARKER
    const caret = await editArea(page).evaluate((el) => (el as HTMLTextAreaElement).selectionStart)
    expect(caret).toBe(wanted.length)

    const fileTab = page.locator(`${WORKBENCH.tab}:not(.pinned)`).first()
    await page.locator(WORKBENCH.tabFiles).click()
    await expect(page.locator(WORKBENCH.tabFiles)).toHaveClass(/\bon\b/)
    await expect(page.locator('.modal')).toHaveCount(0)
    await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)

    await fileTab.click()
    await expect(editArea(page)).toBeVisible({ timeout: 20_000 })
    expect(await editText(page)).toBe(wanted)
    expect(await editArea(page).evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(
      caret
    )
    await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)
    expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)
    await closeDiscardingEdits(app)
  })

  test('BB-C09/BB-C10: reload and find are disabled while editing, and come back on the way out', async ({
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

    const findEnabled = (): Promise<boolean | null> =>
      app.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById('find-in-page')
        return item ? item.enabled : null
      })

    await editViaMenu(page, fx.root, ed.config)
    await editReady(page, 'koloft-e2e-edit-fixture')

    await expect(tabReload(page)).toBeDisabled()
    await expect.poll(findEnabled, { timeout: 10_000 }).toBe(false)

    await page.locator(EDIT.tabEdit).click()
    await expect(editArea(page)).toHaveCount(0, { timeout: 20_000 })
    await expect(tabReload(page)).toBeEnabled()
    await expect.poll(findEnabled, { timeout: 10_000 }).toBe(true)
    await closeDiscardingEdits(app)
  })

  test('BB-M11b: a file written while the user is on another session is taken on return, or flagged if the buffer is dirty', async ({
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

    await editViaMenu(page, fx.root, ed.config)
    await editReady(page, 'koloft-e2e-edit-fixture')

    await startSessionIn(page, 'ws-b')
    await expect(page.locator(EDIT.pane)).toHaveCount(0, { timeout: 20_000 })
    const rewritten = ed.configBody.replace('koloft-e2e-edit-fixture', 'koloft-e2e-rewritten-away')
    fs.writeFileSync(ed.config, rewritten)

    await wsRows(page, 'ws-a').first().click()
    await expect(editArea(page)).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => editText(page), { timeout: 20_000 }).toBe(rewritten)
    await expect(page.locator(EDIT.stale)).toHaveCount(0)

    await typeAtEnd(page, MARKER)
    await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)
    await wsRows(page, 'ws-b').first().click()
    await expect(page.locator(EDIT.pane)).toHaveCount(0, { timeout: 20_000 })
    const again = rewritten.replace('rewritten-away', 'rewritten-twice')
    fs.writeFileSync(ed.config, again)

    await wsRows(page, 'ws-a').first().click()
    await expect(editArea(page)).toBeVisible({ timeout: 20_000 })
    await expect(page.locator(EDIT.stale)).toContainText(EDIT.staleText, { timeout: 20_000 })
    expect(await editText(page)).toBe(rewritten + MARKER)
    await closeDiscardingEdits(app)
  })
})
