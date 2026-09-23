import fs from 'fs'
import { test, expect } from './helpers/app'
import type { Locator, Page } from '@playwright/test'
import { startSessionIn } from './helpers/p1'
import { setupChangeFixture } from './helpers/filesFixture'
import { seedEditFixture, type EditFixture } from './helpers/editFixture'
import { showBrowse, workbenchPanel } from './helpers/workbench'
import {
  EDIT,
  closeDiscardingEdits,
  editArea,
  editReady,
  editText,
  sendSave,
  typeAtEnd
} from './helpers/editPane'

/**
 * Change two · "the disk moved under you",
 * BB-M08 / BB-M09 — B-20, B-21, and the state machine in §05).
 *
 * The other writer is the TEST here, not Claude, and that is deliberate: a real session
 * writing the same file lands whenever it lands, while `fs.writeFileSync` puts the second
 * version on disk at an exact moment and lets the case say what must and must not have
 * happened after it.
 *
 * One warning for whoever changes these. The watcher polls every 500 ms, so the strip can
 * appear from EITHER source — the watcher noticing while the buffer is dirty (§05's second
 * entrance) or the save's own fingerprint check. So "the strip is on screen" cannot carry
 * B-20 on its own. The assertion that does is the one immediately after ⌘S: the file on
 * disk is still, byte for byte, the OTHER writer's version. A build that wrote anyway fails
 * only there.
 */

const MINE = 'KOLOFT_E2E_MINE=1'

function row(page: Page, abs: string, section = 'tree'): Locator {
  return page.locator(`.wb-panel .bv-sec[data-section="${section}"] .ft-node[data-path="${abs}"]`)
}

const stale = (page: Page): Locator => page.locator(EDIT.stale)
const conflict = (page: Page): Locator => page.locator(EDIT.conflict)

/** The other writer's version. Different in BOTH length and modification time, so neither
 *  half of the fingerprint can carry the detection alone (§05: the fingerprint is mtime +
 *  size, and an equal-length overwrite is the case that argument turns on). */
function overwriteFromOutside(ed: EditFixture): string {
  const body = ed.configBody.replace('30000', '45000') + 'EXTERNAL_LINE=1\n'
  fs.writeFileSync(ed.config, body)
  return body
}

/** Reach Browse, open the config file into edit mode through the row menu, type one line. */
async function dirtyEditor(page: Page, root: string, ed: EditFixture): Promise<string> {
  await showBrowse(page)
  await expect(row(page, root)).toBeVisible({ timeout: 30_000 })
  const dir = row(page, `${root}/config`)
  await expect(dir).toBeVisible({ timeout: 30_000 })
  await dir.click()
  const file = row(page, ed.config)
  await expect(file).toBeVisible({ timeout: 20_000 })
  await file.click({ button: 'right' })
  await expect(page.locator(EDIT.ctxMenu)).toBeVisible()
  await page.locator(EDIT.ctxMenu).getByText('Edit', { exact: true }).click()
  await editReady(page, 'koloft-e2e-edit-fixture')
  await typeAtEnd(page, MINE)
  await page.keyboard.press('Enter')
  await expect(page.locator(EDIT.dirty)).toBeVisible()
  return ed.configBody + MINE + '\n'
}

// BB-M08 (B-20, B-21) — ⌘S onto a file somebody else has rewritten writes NOTHING, offers
// the difference, and only then lets the user overrule it.
//
// "Show diff" carries B-21 as well: the strip's answer already brought the disk's current
// text back with it, so the difference can be drawn without a second read that could land
// on a third version.
test('BB-M08: a save onto a changed file writes nothing, shows the difference, and Keep mine then wins', async ({
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
  const theirs = overwriteFromOutside(ed)

  await sendSave(app)

  await expect(stale(page)).toBeVisible({ timeout: 20_000 })
  await expect(stale(page)).toContainText(EDIT.staleText)
  await expect(stale(page).getByRole('button', { name: 'Show diff' })).toBeVisible()
  await expect(stale(page).getByRole('button', { name: 'Reload' })).toBeVisible()
  // the work is still there and still marked
  expect(await editText(page)).toBe(mine)
  await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)

  // THE assertion this case exists for: not one byte was written. Everything above is a
  // consequence a build failing this could still paint correctly — and everything above is
  // also what buys the round trips that keep this off a write still in flight, since
  // `sendSave` only posts the message.
  expect(fs.readFileSync(ed.config, 'utf8')).toBe(theirs)

  await stale(page).getByRole('button', { name: 'Show diff' }).click()
  await expect(conflict(page)).toBeVisible({ timeout: 20_000 })
  // both sides are really in it — the line only the other writer added, and the line only
  // this editor added. Either one alone would pass against a view showing a single version.
  await expect(conflict(page)).toContainText('EXTERNAL_LINE=1')
  await expect(conflict(page)).toContainText(MINE)
  // §03 figure 2: the override lives HERE, not on the strip, so that nobody can take it
  // without having seen the difference first
  await expect(stale(page).getByRole('button', { name: 'Keep mine' })).toHaveCount(0)
  await expect(conflict(page).getByRole('button', { name: 'Keep mine' })).toBeVisible()
  await expect(conflict(page).getByRole('button', { name: 'Reload' })).toBeVisible()

  await conflict(page).getByRole('button', { name: 'Keep mine' }).click()

  await expect.poll(() => fs.readFileSync(ed.config, 'utf8'), { timeout: 20_000 }).toBe(mine)
  await expect(conflict(page)).toHaveCount(0, { timeout: 20_000 })
  await expect(stale(page)).toHaveCount(0)
  await expect(page.locator(EDIT.tabDirty)).toHaveCount(0)
  await expect(page.locator(EDIT.dirty)).toHaveCount(0)
  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// BB-M09 (B-20, §05's "re-read" arrow) — the other branch out of the same state: take their
// version instead, and the buffer goes clean.
//
// Asserted on the TEXTAREA's own value rather than on anything rendered around it: N-02
// makes the box uncontrolled, so a build that updated its React state and never touched the
// DOM node would show the new text nowhere and pass every other check.
test('BB-M09: Reload replaces the buffer with what is on disk and clears the unsaved mark', async ({
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
  const theirs = overwriteFromOutside(ed)

  await sendSave(app)
  await expect(stale(page)).toBeVisible({ timeout: 20_000 })
  expect(await editText(page)).toBe(mine)

  await stale(page).getByRole('button', { name: 'Reload' }).click()

  await expect.poll(() => editText(page), { timeout: 20_000 }).toBe(theirs)
  await expect(stale(page)).toHaveCount(0)
  await expect(page.locator(EDIT.dirty)).toHaveCount(0)
  await expect(page.locator(EDIT.tabDirty)).toHaveCount(0)
  // and the file itself was never rewritten on the way through
  expect(fs.readFileSync(ed.config, 'utf8')).toBe(theirs)

  // …and the editor is usable again afterwards: a save from the reloaded buffer now goes
  // through, which is what proves the fingerprint was refreshed rather than left stale
  await typeAtEnd(page, 'KOLOFT_E2E_AFTER_RELOAD=1')
  await page.keyboard.press('Enter')
  await sendSave(app)
  await expect
    .poll(() => fs.readFileSync(ed.config, 'utf8'), { timeout: 20_000 })
    .toBe(theirs + 'KOLOFT_E2E_AFTER_RELOAD=1\n')
  await expect(editArea(page)).toBeVisible()
  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})
