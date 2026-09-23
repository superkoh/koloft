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

/**
 * Change two · getting in, typing, and ⌘S.
 * BB-M04…BB-M06, BB-M11, BB-C09…BB-C11, BB-C21 — B-01…B-03, B-07, B-10…B-13, B-15…B-17,
 * B-30).
 *
 * The whole feature's "how we know it is done" line is BB-M05 and it is asserted on DISK, byte for
 * byte, before anything on screen is believed: every screen signal here (the strip's
 * Saved stamp, the tab's dot leaving) is producible by a build that wrote nothing at all.
 */

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

/** Expand the ancestors of a file under `root`, then hand back its row. */
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

/** Open a file straight into edit mode through the row menu's first item (B-03). */
async function editViaMenu(page: Page, root: string, abs: string): Promise<void> {
  const r = await treeRow(page, root, abs)
  await r.click({ button: 'right' })
  await expect(ctxMenu(page)).toBeVisible()
  // FIRST item, not merely present: B-03 moves "Edit" ahead of today's "Open", and a menu
  // that gained the item at the bottom would satisfy a `toContain` while leaving the
  // 4-clicks-to-2 claim untrue.
  expect((await page.locator(EDIT.ctxItem).allTextContents())[0]).toBe('Edit')
  await ctxMenu(page).getByText('Edit', { exact: true }).click()
}

// BB-M04 (B-01, B-03, B-07, B-10) — the way in, and what the editor reports about itself.
//
// The body is compared to the file's exact bytes rather than searched for a substring:
// "not doing any tidying up" (B-07) is a claim about what is NOT there — a trimmed trailing
// newline or a re-indented line passes every `toContainText`.
test('BB-M04: the row menu opens a file straight into an editor holding its exact bytes, and the strip reports line, column and endings', async ({
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

  // a tab of its own (B-02's rule for the reading area, and B-03's for the menu), already
  // in edit mode — the ✎ is on without anyone having pressed it
  await expect(wbTabs(page)).toHaveCount(tabsBefore + 1, { timeout: 25_000 })
  await expect(page.locator(EDIT.tabEdit)).toHaveClass(/\bon\b/, { timeout: 20_000 })
  await editReady(page, 'koloft-e2e-edit-fixture')
  expect(await editText(page)).toBe(ed.configBody)

  // --- B-10, the strip. `LF` is a real reading of this file and not a constant: BB-M04b
  // below opens the CRLF fixture through the same path and reads `CRLF` off the same field.
  await expect(page.locator(EDIT.eol)).toHaveText('LF')
  await expect(page.locator(EDIT.pos)).toHaveText(/^Ln \d+, Col \d+$/)
  await expect(page.locator(EDIT.dirty)).toHaveCount(0)

  // the position tracks REAL keystrokes: click into the body, walk to the last line (the
  // file's final byte is a newline, so that line is line 6 and it is empty), and the strip
  // has to follow. A static label passes the format assertion above and fails this one.
  await editArea(page).click()
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('End')
  await expect(page.locator(EDIT.pos)).toHaveText('Ln 6, Col 1')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('End')
  await expect(page.locator(EDIT.pos)).toHaveText('Ln 5, Col 2')

  // --- B-11: Tab moves the focus out, it does not insert a character
  const before = await editText(page)
  await editArea(page).click()
  await page.keyboard.press('Tab')
  expect(await editText(page)).toBe(before)
  await expect(editArea(page)).not.toBeFocused()
  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// BB-M04b (B-10) — the endings field on a file that really is CRLF. Its own test because it
// needs its own file: reading `CRLF` off the same element that read `LF` above is what makes
// the field a measurement rather than a label.
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
  // the textarea flattens every CRLF to LF on the way in (measured — §05), so the editor's
  // own text must NOT be compared to the file's bytes here; that round trip is the unit
  // layer's (BB-C06). What this case pins is only that the reading happened and was named.
  await expect(page.locator(EDIT.readOnly)).toHaveCount(0)
  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// BB-M05 (B-15, B-17, B-18) — the sentence the whole feature is measured by: change a line,
// press ⌘S, and the file on disk IS the new content while Changes shows the new line.
//
// Three independent oracles, in the order that makes each one mean something:
//  1. the bytes on disk, compared whole — the only one a build that wrote nothing fails;
//  2. the change set, which must now hold exactly this one file — the refresh B-17 asks
//     for, and a barrier that the git side really re-ran rather than kept a stale list;
//  3. the added row inside that file's own diff block.
test('BB-M05: ⌘S writes the file and the change set follows', async ({ app, page, env }) => {
  test.slow()
  const fx = setupChangeFixture(env.workspaces.a)
  const ed = seedEditFixture(env.workspaces.a)
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
  await browseReady(page, fx.root)

  await editViaMenu(page, fx.root, ed.config)
  await editReady(page, 'koloft-e2e-edit-fixture')

  // B-15's other half first: ⌘S on a CLEAN buffer must not touch the file. Measured by the
  // modification time, which is the one observable a no-op rewrite of identical bytes would
  // still move — and a moved mtime is exactly what would then poison the next save's
  // fingerprint check.
  const mtimeBefore = fs.statSync(ed.config).mtimeMs
  expect(await saveMenuEnabled(app)).toBe(false)
  await sendSave(app)
  await expect(page.locator(EDIT.dirty)).toHaveCount(0)

  // --- type one line at the end. The typing sits BETWEEN the no-op ⌘S and its assertion on
  // purpose: `sendSave` only posts the message, so checking the clock straight afterwards
  // would race a write that is still on its way.
  await typeAtEnd(page, MARKER)
  await page.keyboard.press('Enter')
  await expect(page.locator(EDIT.dirty)).toBeVisible()
  expect(fs.statSync(ed.config).mtimeMs).toBe(mtimeBefore)
  await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)
  // B-16: the File menu's own Save follows the dirty flag (the IPC route below bypasses it)
  await expect.poll(() => saveMenuEnabled(app), { timeout: 10_000 }).toBe(true)
  // nothing is on disk yet — decision 7: there is no autosave
  expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)

  await sendSave(app)

  // 1. the bytes, whole. Everything the user did not touch is still byte-identical, which
  // is B-18's "the trailing newline does not move" in the only form that can fail.
  await expect
    .poll(() => fs.readFileSync(ed.config, 'utf8'), { timeout: 20_000 })
    .toBe(ed.configBody + MARKER + '\n')

  // the screen agrees: the marks are gone and the strip says when
  await expect(page.locator(EDIT.tabDirty)).toHaveCount(0, { timeout: 20_000 })
  await expect(page.locator(EDIT.dirty)).toHaveCount(0)
  await expect(page.locator(EDIT.status)).toHaveText(/Saved \d{2}:\d{2}:\d{2}/, { timeout: 20_000 })

  // 2 + 3. B-17's refresh: the change set holds exactly this file, and its diff carries the
  // line that was typed. `data-ready` is the block's own "I have finished drawing" flag, so
  // waiting on it keeps the row assertion off a block still printing `Loading…`.
  await page.locator(WORKBENCH.tabFiles).click()
  await halfBtn(page, 'Changes').click()
  const rel = ed.rel(ed.config)
  const blk = page.locator(`.wb-panel .cv-blk[data-path="${rel}"][data-ready="1"]`)
  await expect(blk).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.wb-panel .cv-row')).toHaveCount(1)
  await expect(blk.locator('.idiff-row.idiff-add .idiff-code', { hasText: MARKER })).toHaveCount(1)
  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// BB-M06 (B-02) — Browse's reading area never becomes editable in place; its ✎ promotes the
// file to a tab of its own and edits it there.
//
// The reading area is asserted to be UNCHANGED afterwards, which is the half a build that
// simply swapped the reading body for a textarea would fail while looking correct.
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
  // the reading area holds no editor of its own before the click, and none after
  await expect(page.locator(`.fv-read ${EDIT.pane}`)).toHaveCount(0)

  await page.locator(EDIT.readEdit).click()

  await expect(wbTabs(page)).toHaveCount(tabsBefore + 1, { timeout: 25_000 })
  await editReady(page, 'koloft-e2e-edit-fixture')
  await expect(page.locator(EDIT.tabEdit)).toHaveClass(/\bon\b/)
  await expect(page.locator(`.fv-read ${EDIT.pane}`)).toHaveCount(0)
  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// BB-M11 (B-30) — switching away is not closing. Nothing is asked, nothing is lost.
//
// The caret is part of the claim ("the content and the caret are both still there"), and it is the half that separates a
// truly resident textarea from one re-mounted with the same text: a remount lands the caret
// at 0 while every content assertion still passes.
test('BB-M11: leaving the tab and coming back keeps the text, the dirty mark and the caret', async ({
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
  // no question was asked on the way out
  await expect(page.locator('.modal')).toHaveCount(0)
  // …and the tab kept its mark while it was not on screen
  await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)

  await fileTab.click()
  await expect(editArea(page)).toBeVisible({ timeout: 20_000 })
  expect(await editText(page)).toBe(wanted)
  expect(await editArea(page).evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(
    caret
  )
  await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)
  // and still nothing on disk
  expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)
  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// BB-C09 / BB-C10 (B-12, B-13, B-29) — the two controls that mean "throw my typing away
// without asking", switched off for as long as the editor is open.
//
// ⌘F is asserted through the MENU ITEM's enabled flag rather than by pressing the key: the
// accelerator is native and unreachable from Playwright (test/CLAUDE.md), and the item's
// flag is the same state the key would consult.
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

  // leaving edit mode gives both back — otherwise the case passes on a build that disabled
  // them for the life of the tab
  await page.locator(EDIT.tabEdit).click()
  await expect(editArea(page)).toHaveCount(0, { timeout: 20_000 })
  await expect(tabReload(page)).toBeEnabled()
  await expect.poll(findEnabled, { timeout: 10_000 }).toBe(true)
  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// BB-M11b (B-15/B-20 across a session switch) — leaving the session unmounts the editor
// and its watch, so a write that lands while the user is away reaches nobody; coming back
// has to find the file as it is. The `editText` assertion after the first return is the
// one that fails only in the broken state — the strip, the tab and the dirty dot are all
// green over stale text. The second half is the same catch-up with unsaved typing in the
// way: nothing is overwritten, the conflict strip comes up instead.
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

  // a second session takes the screen; only its own panes stay mounted
  await startSessionIn(page, 'ws-b')
  await expect(page.locator(EDIT.pane)).toHaveCount(0, { timeout: 20_000 })
  const rewritten = ed.configBody.replace('koloft-e2e-edit-fixture', 'koloft-e2e-rewritten-away')
  fs.writeFileSync(ed.config, rewritten)

  // back on A: the clean buffer follows the file, and no strip is raised over it
  await wsRows(page, 'ws-a').first().click()
  await expect(editArea(page)).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => editText(page), { timeout: 20_000 }).toBe(rewritten)
  await expect(page.locator(EDIT.stale)).toHaveCount(0)

  // now with typing in the way: the disk moves again while the user is away
  await typeAtEnd(page, MARKER)
  await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)
  await wsRows(page, 'ws-b').first().click()
  await expect(page.locator(EDIT.pane)).toHaveCount(0, { timeout: 20_000 })
  const again = rewritten.replace('rewritten-away', 'rewritten-twice')
  fs.writeFileSync(ed.config, again)

  await wsRows(page, 'ws-a').first().click()
  await expect(editArea(page)).toBeVisible({ timeout: 20_000 })
  await expect(page.locator(EDIT.stale)).toContainText(EDIT.staleText, { timeout: 20_000 })
  // and the typing is still there
  expect(await editText(page)).toBe(rewritten + MARKER)
  await closeDiscardingEdits(app)
})
