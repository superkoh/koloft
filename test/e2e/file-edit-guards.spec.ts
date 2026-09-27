import fs from 'fs'
import { test, expect } from './helpers/app'
import type { Locator, Page } from '@playwright/test'
import {
  centerTerm,
  layoutOnDisk,
  openMenu,
  processAlive,
  runIn,
  sendShortcut,
  startSessionIn,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { setupChangeFixture } from './helpers/filesFixture'
import { seedEditFixture, type EditFixture } from './helpers/editFixture'
import {
  WORKBENCH,
  browseRow,
  openFileTab,
  rowMenu,
  seedScratchpad,
  showBrowse,
  wbTabTitles,
  wbTabs,
  workbenchPanel
} from './helpers/workbench'
import {
  EDIT,
  closeDiscardingEdits,
  editReady,
  editText,
  sendSave,
  typeAtEnd
} from './helpers/editPane'

const MARKER = 'KOLOFT_E2E_GUARD=1'

const modal = (page: Page): Locator => page.locator(EDIT.unsavedModal)
const fileTab = (page: Page): Locator => page.locator(`${WORKBENCH.tab}:not(.pinned)`)

async function dirtyEditor(page: Page, root: string, ed: EditFixture): Promise<string> {
  await showBrowse(page)
  await expect(browseRow(page, root)).toBeVisible({ timeout: 30_000 })
  const dir = browseRow(page, `${root}/config`)
  await expect(dir).toBeVisible({ timeout: 30_000 })
  if (!(await dir.getAttribute('class'))?.split(/\s+/).includes('open')) await dir.click()
  const file = browseRow(page, ed.config)
  await expect(file).toBeVisible({ timeout: 20_000 })
  await file.click({ button: 'right' })
  await expect(rowMenu(page)).toBeVisible()
  await rowMenu(page).getByText('Edit', { exact: true }).click()
  await editReady(page, 'koloft-e2e-edit-fixture')
  await typeAtEnd(page, MARKER)
  await page.keyboard.press('Enter')
  await expect(page.locator(EDIT.dirty)).toBeVisible()
  return ed.configBody + MARKER + '\n'
}

test.describe('File edit · unsaved work is never lost, and the ✎ that stays off', () => {
  test('BB-M10: closing a tab with unsaved work asks (Save & close holds focus), and Cancel / Discard / Save & close each do their word on disk', async ({
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

    await fileTab(page).first().locator(WORKBENCH.tabCloseIn).click()
    await expect(modal(page)).toBeVisible({ timeout: 20_000 })
    await expect(modal(page)).toContainText('config/app.json')
    await expect(modal(page)).not.toContainText(fx.root)
    const buttons = modal(page).locator('button')
    expect(await buttons.allTextContents()).toEqual(['Cancel', 'Discard', 'Save & close'])
    await expect(modal(page).getByRole('button', { name: 'Save & close' })).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(modal(page)).toHaveCount(0, { timeout: 10_000 })
    await expect(fileTab(page)).toHaveCount(1)
    await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)

    await fileTab(page).first().locator(WORKBENCH.tabCloseIn).click()
    await modal(page).getByRole('button', { name: 'Cancel' }).click()
    await expect(modal(page)).toHaveCount(0, { timeout: 10_000 })
    await expect(fileTab(page)).toHaveCount(1)
    expect(await editText(page)).toBe(mine)
    expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)

    await fileTab(page).first().locator(WORKBENCH.tabCloseIn).click()
    await modal(page).getByRole('button', { name: 'Discard' }).click()
    await expect(fileTab(page)).toHaveCount(0, { timeout: 20_000 })
    expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)

    const again = await dirtyEditor(page, fx.root, ed)
    await fileTab(page).first().locator(WORKBENCH.tabCloseIn).click()
    await modal(page).getByRole('button', { name: 'Save & close' }).click()
    await expect(fileTab(page)).toHaveCount(0, { timeout: 20_000 })
    await expect.poll(() => fs.readFileSync(ed.config, 'utf8'), { timeout: 20_000 }).toBe(again)
    await closeDiscardingEdits(app)
  })

  test('BB-M12: the tab cap skips the least-recent tab when it holds unsaved work, evicts the next one instead, and asks nothing', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    test.setTimeout(240_000)
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

    await dirtyEditor(page, fx.root, ed)
    await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)

    for (const abs of fx.paths.changeable.slice(0, 7)) {
      await openFileTab(page, env, abs)
    }
    await expect(fileTab(page)).toHaveCount(8, { timeout: 30_000 })
    expect(await wbTabTitles(page)).toContain('app.json')

    const before = await wbTabs(page).count()
    await openFileTab(page, env, fx.paths.bulk[0])

    await expect(wbTabs(page)).toHaveCount(before, { timeout: 25_000 })
    const titles = await wbTabTitles(page)
    expect(titles).toContain('app.json')
    expect(titles).toContain('part-1.ts')
    expect(titles).not.toContain('change-1.ts')
    await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)
    await expect(page.locator('.modal')).toHaveCount(0)
    await page.locator(WORKBENCH.tab, { hasText: 'app.json' }).click()
    await expect.poll(() => editText(page), { timeout: 20_000 }).toContain(MARKER)
    await closeDiscardingEdits(app)
  })

  test('BB-N01: a 600 KB file (over the 512 KB edit cap, under the 2 MB read cap) reads fine and its ✎ is disabled with the size as the reason', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    expect(fs.statSync(ed.big).size).toBeGreaterThan(512 * 1024)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

    await showBrowse(page)
    await expect(browseRow(page, fx.root)).toBeVisible({ timeout: 30_000 })
    await browseRow(page, `${fx.root}/config`).click()
    await browseRow(page, ed.big).click({ timeout: 30_000 })

    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('config/big.txt', {
      timeout: 30_000
    })

    const edit = page.locator(EDIT.readEdit)
    await expect(edit).toBeVisible({ timeout: 20_000 })
    await expect(edit).toBeDisabled()
    await expect(edit).toHaveAttribute('title', /512/)
    await closeDiscardingEdits(app)
  })

  test('BB-C02: a file outside every workspace reads, and its ✎ works — no roots fence, since a session can move to another checkout mid-conversation', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

    const call = (await waitForCalls(env, 1))[0]
    const scratch = seedScratchpad(env, call.cwd, call.sessionId)

    await showBrowse(page)
    await expect(browseRow(page, fx.root)).toBeVisible({ timeout: 30_000 })
    await browseRow(page, scratch.md, 'scratchpad').click({ timeout: 30_000 })
    await expect(page.locator(WORKBENCH.readingTitle)).toContainText('notes.md', {
      timeout: 30_000
    })

    const edit = page.locator(EDIT.readEdit)
    await expect(edit).toBeVisible({ timeout: 20_000 })
    await expect(edit).toBeEnabled({ timeout: 20_000 })

    await browseRow(page, `${fx.root}/README.koloft.md`).click({ timeout: 30_000 })
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.koloft.md', {
      timeout: 30_000
    })
    await expect(page.locator(EDIT.readEdit)).toBeEnabled({ timeout: 20_000 })
    await closeDiscardingEdits(app)
  })

  test('a file outside every workspace is read, not refused — what the person can see, Koloft can read', async ({
    page,
    env
  }) => {
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    const stray = `${env.home}/stray-secret.txt`
    fs.writeFileSync(stray, 'koloft-e2e-stray\n')
    const outcome = await page.evaluate(
      (p) =>
        window.api.preview.readText(p).then(
          (text: string) => text,
          (e: Error) => String(e.message)
        ),
      stray
    )
    expect(outcome).toBe('koloft-e2e-stray\n')
  })

  test('BB-C16: a clean editor follows the file when it changes on disk, with no conflict strip', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

    await showBrowse(page)
    await expect(browseRow(page, fx.root)).toBeVisible({ timeout: 30_000 })
    await browseRow(page, `${fx.root}/config`).click()
    await browseRow(page, ed.config).click({ button: 'right', timeout: 30_000 })
    await rowMenu(page).getByText('Edit', { exact: true }).click()
    await editReady(page, 'koloft-e2e-edit-fixture')
    await expect(page.locator(EDIT.dirty)).toHaveCount(0)

    const theirs = ed.configBody + 'WRITTEN_WHILE_CLEAN=1\n'
    fs.writeFileSync(ed.config, theirs)

    await expect.poll(() => editText(page), { timeout: 30_000 }).toBe(theirs)
    await expect(page.locator(EDIT.stale)).toHaveCount(0)
    await expect(page.locator(EDIT.dirty)).toHaveCount(0)

    await typeAtEnd(page, 'KOLOFT_E2E_AFTER_AUTORELOAD=1')
    await page.keyboard.press('Enter')
    await sendSave(app)
    await expect
      .poll(() => fs.readFileSync(ed.config, 'utf8'), { timeout: 20_000 })
      .toBe(theirs + 'KOLOFT_E2E_AFTER_AUTORELOAD=1\n')
    await closeDiscardingEdits(app)
  })

  test('BB-C14a: a running session with unsaved work asks once (Cancel holds focus), names the file, and a refused save keeps the session alive', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    test.setTimeout(300_000)
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

    const [session] = await waitForCalls(env, 1)
    const mine = await dirtyEditor(page, fx.root, ed)

    await runIn(page, centerTerm(page), '/busy')
    await expect(wsRows(page, 'ws-a').first()).toHaveClass(/\bst-working\b/, { timeout: 30_000 })

    await sendShortcut(app, 'shortcut:close-tab')

    const dlg = page.locator(EDIT.sessionModal)
    await expect(dlg).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.modal')).toHaveCount(1)
    await expect(page.locator(EDIT.unsavedModal)).toHaveCount(0)
    await expect(dlg.locator('.modal-header')).toHaveText(EDIT.sessionModalTitle)
    expect(await dlg.locator('button').allTextContents()).toEqual([
      'Cancel',
      'Discard & close',
      'Save & close'
    ])
    await expect(dlg.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await expect(dlg).toContainText(
      'It also has unsaved changes in config/app.json, which closing will lose.'
    )

    fs.writeFileSync(ed.config, ed.configBody + 'EXTERNAL_LINE=1\n')
    await dlg.getByRole('button', { name: 'Save & close' }).click()
    await expect(dlg).toHaveCount(0, { timeout: 20_000 })
    await expect(page.locator('.toast')).toBeVisible({ timeout: 20_000 })
    expect(fs.readFileSync(ed.config, 'utf8')).not.toBe(mine)
    await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)
    expect(processAlive(session.pid)).toBe(true)

    await closeDiscardingEdits(app)
  })

  test('BB-C14b: an idle session with unsaved work asks the plain unsaved question', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

    await dirtyEditor(page, fx.root, ed)
    await centerTerm(page).click()
    await sendShortcut(app, 'shortcut:close-tab')

    await expect(modal(page)).toBeVisible({ timeout: 20_000 })
    await expect(page.locator(EDIT.sessionModal)).toHaveCount(0)
    expect(await modal(page).locator('button').allTextContents()).toEqual([
      'Cancel',
      'Discard',
      'Save & close'
    ])
    await modal(page).getByRole('button', { name: 'Cancel' }).click()
    await expect(modal(page)).toHaveCount(0, { timeout: 10_000 })
    expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)

    await closeDiscardingEdits(app)
  })

  test('BB-C14c: Save & close on a running session writes the file and then really closes the session', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    test.setTimeout(300_000)
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

    const [session] = await waitForCalls(env, 1)
    const mine = await dirtyEditor(page, fx.root, ed)

    await runIn(page, centerTerm(page), '/busy')
    const wsRow = wsRows(page, 'ws-a').first()
    await expect(wsRow).toHaveClass(/\bst-working\b/, { timeout: 30_000 })

    await sendShortcut(app, 'shortcut:close-tab')
    const dlg = page.locator(EDIT.sessionModal)
    await expect(dlg).toBeVisible({ timeout: 20_000 })

    await dlg.getByRole('button', { name: 'Save & close' }).click()

    await expect.poll(() => fs.readFileSync(ed.config, 'utf8'), { timeout: 25_000 }).toBe(mine)
    await expect(dlg).toHaveCount(0, { timeout: 20_000 })
    await expect.poll(() => processAlive(session.pid), { timeout: 30_000 }).toBe(false)
    await expect(wsRow).toHaveClass(/\bcold\b/, { timeout: 30_000 })
    await expect(page.locator(EDIT.tabDirty)).toHaveCount(0)

    await closeDiscardingEdits(app)
  })

  test('BB-C14d: Discard & close closes the session and writes nothing', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    test.setTimeout(300_000)
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

    const [session] = await waitForCalls(env, 1)
    await dirtyEditor(page, fx.root, ed)

    await runIn(page, centerTerm(page), '/busy')
    const wsRow = wsRows(page, 'ws-a').first()
    await expect(wsRow).toHaveClass(/\bst-working\b/, { timeout: 30_000 })

    await sendShortcut(app, 'shortcut:close-tab')
    const dlg = page.locator(EDIT.sessionModal)
    await expect(dlg).toBeVisible({ timeout: 20_000 })

    await dlg.getByRole('button', { name: 'Discard & close' }).click()

    await expect(dlg).toHaveCount(0, { timeout: 20_000 })
    await expect.poll(() => processAlive(session.pid), { timeout: 30_000 }).toBe(false)
    await expect(wsRow).toHaveClass(/\bcold\b/, { timeout: 30_000 })
    expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)

    await closeDiscardingEdits(app)
  })

  test('in the unsaved-changes dialog and the close-session dialog, ← and → move focus along the button row, so Enter can reach Discard, Close or Save from the keyboard', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    test.setTimeout(300_000)
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    const [session] = await waitForCalls(env, 1)

    await dirtyEditor(page, fx.root, ed)
    await fileTab(page).first().locator(WORKBENCH.tabCloseIn).click()
    await expect(modal(page)).toBeVisible({ timeout: 20_000 })
    await expect(modal(page).getByRole('button', { name: 'Save & close' })).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(modal(page).getByRole('button', { name: 'Discard' })).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(modal(page).getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(modal(page).getByRole('button', { name: 'Discard' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(modal(page)).toHaveCount(0, { timeout: 10_000 })
    await expect(fileTab(page)).toHaveCount(0, { timeout: 20_000 })
    expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)

    await dirtyEditor(page, fx.root, ed)
    await runIn(page, centerTerm(page), '/busy')
    const wsRow = wsRows(page, 'ws-a').first()
    await expect(wsRow).toHaveClass(/\bst-working\b/, { timeout: 30_000 })
    await sendShortcut(app, 'shortcut:close-tab')
    const dlg = page.locator(EDIT.sessionModal)
    await expect(dlg).toBeVisible({ timeout: 20_000 })
    await expect(dlg.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(dlg.getByRole('button', { name: 'Discard & close' })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(dlg.getByRole('button', { name: 'Save & close' })).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(dlg.getByRole('button', { name: 'Discard & close' })).toBeFocused()
    await page.keyboard.press('Enter')

    await expect(dlg).toHaveCount(0, { timeout: 20_000 })
    await expect.poll(() => processAlive(session.pid), { timeout: 30_000 }).toBe(false)
    await expect(wsRow).toHaveClass(/\bcold\b/, { timeout: 30_000 })
    expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)
    await closeDiscardingEdits(app)
  })

  test('BB-C24: removing a workspace with running sessions and unsaved work says so (Cancel holds focus), and Cancel leaves everything standing', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    test.setTimeout(300_000)
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

    const mine = await dirtyEditor(page, fx.root, ed)

    await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
    await page.locator('.menu .mi.danger', { hasText: 'Remove workspace' }).click()

    const dlg = page.locator('.modal', { hasText: 'Remove workspace' })
    await expect(dlg).toBeVisible({ timeout: 20_000 })
    await expect(dlg).toContainText(
      '1 file has unsaved changes in these sessions and will be lost.'
    )
    expect(await dlg.locator('.modal-foot button').allTextContents()).toEqual([
      'Cancel',
      'Discard & remove',
      'Save & remove'
    ])
    await expect(dlg.getByRole('button', { name: 'Cancel' })).toBeFocused()

    await dlg.getByRole('button', { name: 'Cancel' }).click()
    await expect(dlg).toHaveCount(0, { timeout: 10_000 })

    await expect(page.locator('.ws-head .ws-name', { hasText: 'ws-a' })).toHaveCount(1)
    await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)
    expect(await editText(page)).toBe(mine)
    expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)

    await closeDiscardingEdits(app)
  })

  test('BB-C25: a /clear id swap keeps the unsaved buffer, its dirty mark and its ability to save', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    test.setTimeout(300_000)
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    const [call] = await waitForCalls(env, 1)

    const mine = await dirtyEditor(page, fx.root, ed)

    // CC§1 CC§2
    await runIn(page, centerTerm(page), '/clear')

    let newId = ''
    await expect
      .poll(
        () => {
          const ids = Object.keys(layoutOnDisk(env).panels ?? {})
          newId = ids.find((i) => i !== call.sessionId) ?? ''
          return newId
        },
        { timeout: 60_000 }
      )
      .not.toBe('')

    await expect(fileTab(page)).toHaveCount(1, { timeout: 20_000 })
    await expect(page.locator('.wb-tab.on .dirty')).toHaveCount(1, { timeout: 20_000 })
    await expect(page.locator(WORKBENCH.tabFiles)).not.toHaveClass(/\bon\b/)
    await expect(page.locator(EDIT.area)).toBeVisible({ timeout: 20_000 })
    expect(await editText(page)).toBe(mine)
    await expect(page.locator(EDIT.dirty)).toBeVisible()

    await page.locator(EDIT.area).click()
    await sendSave(app)
    await expect.poll(() => fs.readFileSync(ed.config, 'utf8'), { timeout: 20_000 }).toBe(mine)
    await expect(page.locator(EDIT.dirty)).toHaveCount(0, { timeout: 20_000 })

    await closeDiscardingEdits(app)
  })

  test('BB-C25b: a ⇧⌘R restart keeps the unsaved buffer, its dirty mark and its unsaved prompt', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    test.setTimeout(300_000)
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    const [first] = await waitForCalls(env, 1)

    const mine = await dirtyEditor(page, fx.root, ed)

    await sendShortcut(app, 'shortcut:restart-session')
    const calls = await waitForCalls(env, 2)
    const i = calls[1].argv.indexOf('--resume')
    expect(calls[1].argv[i + 1]).toBe(first.sessionId)

    await expect(fileTab(page)).toHaveCount(1, { timeout: 20_000 })
    await expect(page.locator('.wb-tab.on .dirty')).toHaveCount(1, { timeout: 20_000 })
    await expect(page.locator(EDIT.area)).toBeVisible({ timeout: 20_000 })
    expect(await editText(page)).toBe(mine)
    await expect(page.locator(EDIT.dirty)).toBeVisible()

    await sendShortcut(app, 'shortcut:close-tab')
    await expect(modal(page)).toBeVisible({ timeout: 20_000 })
    await modal(page).getByRole('button', { name: 'Cancel' }).click()
    await expect(modal(page)).toHaveCount(0, { timeout: 10_000 })
    await expect(fileTab(page)).toHaveCount(1)
    expect(await editText(page)).toBe(mine)
    expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)

    await closeDiscardingEdits(app)
  })

  test('BB-C26: quitting with unsaved work asks, Cancel keeps the app open, asking again asks again, Discard lets it go', async ({
    app,
    page,
    env
  }) => {
    test.slow()
    test.setTimeout(300_000)
    const fx = setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

    await dirtyEditor(page, fx.root, ed)

    // PLATFORM§5
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await expect(modal(page)).toBeVisible({ timeout: 20_000 })
    await expect(modal(page)).toContainText('config/app.json')

    await modal(page).getByRole('button', { name: 'Cancel' }).click()
    await expect(modal(page)).toHaveCount(0, { timeout: 10_000 })
    expect(await page.evaluate(() => 6 * 7)).toBe(42)
    await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)

    const exited = app.waitForEvent('close', { timeout: 60_000 })
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await expect(modal(page)).toBeVisible({ timeout: 20_000 })
    await modal(page).getByRole('button', { name: 'Discard' }).click()

    await exited
    expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)
  })
})
