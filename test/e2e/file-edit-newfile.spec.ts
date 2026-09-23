import fs from 'fs'
import path from 'path'
import { test, expect } from './helpers/app'
import type { Locator, Page } from '@playwright/test'
import { startSessionIn } from './helpers/p1'
import { setupChangeFixture } from './helpers/filesFixture'
import { seedEditFixture } from './helpers/editFixture'
import { WORKBENCH, showBrowse, wbTabs, workbenchPanel } from './helpers/workbench'
import { EDIT, closeDiscardingEdits, editArea, editText, sendSave } from './helpers/editPane'

/**
 * Change two · making a file, BB-M07, BB-C17,
 * BB-C18 — B-06).
 *
 * B-06 is three rules in one gesture and the two refusals are the interesting ones. Both
 * are asserted on DISK: a name box that turns red while the file was created anyway is the
 * failure, and no amount of screen checking finds it.
 */

function row(page: Page, abs: string, section = 'tree'): Locator {
  return page.locator(`.wb-panel .bv-sec[data-section="${section}"] .ft-node[data-path="${abs}"]`)
}

const nameBox = (page: Page): Locator => page.locator(EDIT.newFileInput)

/** B-06's inline refusal. It is the only signal that the create round trip came back, which
 *  is what every disk read below has to be sequenced behind. */
const NEWFILE_ERR = '.ft-newfile-err'

/** Right-click a folder row and pick "New File…". */
async function startNewFile(page: Page, dirAbs: string): Promise<void> {
  await row(page, dirAbs).click({ button: 'right' })
  await expect(page.locator(EDIT.ctxMenu)).toBeVisible()
  await page.locator(EDIT.ctxMenu).getByText('New File…', { exact: true }).click()
  await expect(nameBox(page)).toBeVisible({ timeout: 20_000 })
}

async function browseReady(page: Page, root: string): Promise<void> {
  await showBrowse(page)
  await expect(row(page, root)).toBeVisible({ timeout: 30_000 })
  const dir = row(page, `${root}/config`)
  await expect(dir).toBeVisible({ timeout: 30_000 })
  if (!(await dir.getAttribute('class'))?.split(/\s+/).includes('open')) await dir.click()
  await expect(dir).toHaveClass(/\bopen\b/, { timeout: 20_000 })
}

// BB-M07 (B-06) — a folder's "New File…" makes an empty file and drops you straight into it.
//
// "Straight into it" is the half worth naming: the file existing on disk is only half of
// B-06, and a build that created it and left the user staring at the tree satisfies every
// filesystem assertion. The editor being up, empty, and able to save is the other half.
test('BB-M07: New File… creates the file and opens it in edit mode, ready to save', async ({
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

  // on disk, and empty — `createFile` writes nothing but the file itself
  await expect.poll(() => fs.existsSync(made), { timeout: 20_000 }).toBe(true)
  expect(fs.readFileSync(made, 'utf8')).toBe('')

  // and straight into an editor of its own
  await expect(wbTabs(page)).toHaveCount(tabsBefore + 1, { timeout: 25_000 })
  const madeTab = page.locator(`${WORKBENCH.tab}:not(.pinned)`).first()
  await expect(editArea(page)).toBeVisible({ timeout: 25_000 })
  expect(await editText(page)).toBe('')
  await expect(page.locator(EDIT.tabEdit)).toHaveClass(/\bon\b/)
  await expect(page.locator(EDIT.dirty)).toHaveCount(0)

  // The row is in the tree too, so the listing was refreshed rather than left behind — but
  // the tree has to be ON SCREEN to be seen. B-06 made the new file's own tab active three
  // assertions ago, and an inactive Workbench tab's body is `visibility: hidden`, so every
  // row under the Files tab is hidden for as long as the editor is up. Asserting the editor
  // and the tree row at the same moment is not something any build could satisfy.
  await page.locator(WORKBENCH.tabFiles).click()
  await expect(row(page, made)).toBeVisible({ timeout: 25_000 })

  // …and the fingerprint `createFile` handed back is usable: the very first ⌘S goes
  // through instead of coming back "changed on disk". Back to the editor first — the click
  // above put the Files tab on top, which is what hid it.
  await madeTab.click()
  await expect(editArea(page)).toBeVisible({ timeout: 20_000 })
  await editArea(page).click()
  await page.keyboard.type('KOLOFT_E2E_FRESH=1')
  await sendSave(app)
  await expect
    .poll(() => fs.readFileSync(made, 'utf8'), { timeout: 20_000 })
    .toBe('KOLOFT_E2E_FRESH=1')
  await expect(page.locator(EDIT.stale)).toHaveCount(0)
  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// BB-C17 (B-06) — a name with a path separator or a `..` in it is refused BY NAME, at the
// name box, before anything touches the disk.
//
// The reason is a user-facing one: the box asks for a NAME, so `a/b.txt` gets a sentence
// about names instead of quietly making a file one folder over. The case checks that nothing
// was created anywhere — not the nested file, not the directory that would have had to be
// made for it, and not the sibling a `..` would have escaped to.
test('BB-C17: a name containing / or .. is refused and creates nothing', async ({
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

  // The refusal is the BARRIER, not just an extra assertion. Enter starts an async round
  // trip, so reading the disk straight afterwards proves nothing: a build that created the
  // file a moment later passes every `existsSync` below. Waiting for the message the
  // renderer only paints once the answer is back is what makes those reads meaningful —
  // and the message is matched by its own wording, so the BAD-NAME refusal cannot be
  // satisfied by the taken-name one.
  await expect(page.locator(NEWFILE_ERR)).toHaveText(/Just a file name/, { timeout: 20_000 })
  // still asking — the refusal happens in place, it does not silently close the box
  await expect(nameBox(page)).toBeVisible()
  await expect(editArea(page)).toHaveCount(0)
  expect(fs.existsSync(path.join(ed.configDir, 'a'))).toBe(false)
  expect(fs.existsSync(path.join(ed.configDir, 'a', 'b.txt'))).toBe(false)

  await nameBox(page).fill('../escaped.txt')
  await nameBox(page).press('Enter')
  await expect(page.locator(NEWFILE_ERR)).toHaveText(/Just a file name/, { timeout: 20_000 })
  await expect(nameBox(page)).toBeVisible()
  expect(fs.existsSync(path.join(fx.root, 'escaped.txt'))).toBe(false)

  // …and a good name from the same box still works, so the two refusals above are about
  // the names and not about a box that stopped working
  await nameBox(page).fill('ok.conf')
  await nameBox(page).press('Enter')
  await expect
    .poll(() => fs.existsSync(path.join(ed.configDir, 'ok.conf')), { timeout: 20_000 })
    .toBe(true)
  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// BB-C18 (B-06) — an existing name is refused, and the file it names is untouched.
//
// The content check is the case. "The name is taken" can be reported correctly by an
// implementation that already truncated the file to zero bytes on the way to finding out —
// which is exactly what a plain `open(…, 'w')` would do, and exactly why B-06 asks for the
// create to be the atomic exclusive one.
test('BB-C18: an existing name is refused and the file it names is not touched', async ({
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

  // the barrier, for the reason spelled out in BB-C17: without it the two reads below run
  // before the answer is even back, and a build that truncated the file on its way to
  // discovering the name was taken would still pass them
  await expect(page.locator(NEWFILE_ERR)).toHaveText(/That name is taken/, { timeout: 20_000 })
  await expect(nameBox(page)).toBeVisible()
  await expect(editArea(page)).toHaveCount(0)
  expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)
  expect(fs.statSync(ed.config).mtimeMs).toBe(before)
  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})
