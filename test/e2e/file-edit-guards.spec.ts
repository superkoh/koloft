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
  openFileTab,
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

/**
 * Change two · the ways unsaved work can disappear, and the ✎ that never lights up
 *, BB-M10, BB-M12, BB-C02, BB-C14a…d, BB-C16,
 * BB-C24, BB-C25, BB-N01 — B-04, B-05, B-15, B-24, B-25, B-27, B-31, B-32, N-01).
 *
 * §04's "do not lose anything" list is eight paths now (B-31 was found while implementing, B-32
 * during code review) and the design says the feature cannot ship with any of them open.
 * Seven are driven end to end here: the tab's ✕ (B-24), closing a session in both its shapes
 * and all three of its answers (B-25), quitting Koloft (B-26), the per-kind cap (B-27),
 * removing a workspace (B-31) and the session changing its id under the panel (B-32).
 *
 * B-26 is drivable only because BB-C26 raises the quit ITSELF, mid-test, while the page is
 * still the test's to answer with. Playwright's own `app.close()` is the same quit arriving
 * after the test has ended, where nobody can answer and the worker simply hangs — which is
 * what `closeDiscardingEdits` and the `app` fixture's teardown exist to prevent.
 *
 * The one that is not, and why:
 *  · retargeting a tab in place (B-28) — no contract yet for the `path:line` reference that
 *    triggers it.
 */

const MARKER = 'KOLOFT_E2E_GUARD=1'

function row(page: Page, abs: string, section = 'tree'): Locator {
  return page.locator(`.wb-panel .bv-sec[data-section="${section}"] .ft-node[data-path="${abs}"]`)
}

const modal = (page: Page): Locator => page.locator(EDIT.unsavedModal)
const fileTab = (page: Page): Locator => page.locator(`${WORKBENCH.tab}:not(.pinned)`)

/** Open the config file into edit mode through the row menu and type one line. */
async function dirtyEditor(page: Page, root: string, ed: EditFixture): Promise<string> {
  await showBrowse(page)
  await expect(row(page, root)).toBeVisible({ timeout: 30_000 })
  const dir = row(page, `${root}/config`)
  await expect(dir).toBeVisible({ timeout: 30_000 })
  if (!(await dir.getAttribute('class'))?.split(/\s+/).includes('open')) await dir.click()
  const file = row(page, ed.config)
  await expect(file).toBeVisible({ timeout: 20_000 })
  await file.click({ button: 'right' })
  await expect(page.locator(EDIT.ctxMenu)).toBeVisible()
  await page.locator(EDIT.ctxMenu).getByText('Edit', { exact: true }).click()
  await editReady(page, 'koloft-e2e-edit-fixture')
  await typeAtEnd(page, MARKER)
  await page.keyboard.press('Enter')
  await expect(page.locator(EDIT.dirty)).toBeVisible()
  return ed.configBody + MARKER + '\n'
}

// BB-M10 (B-24) — the ✕ on a tab with unsaved work asks first, and all three answers do
// what they say.
//
// Every answer is checked against the FILE as well as the strip, because the two disagree
// in exactly the way that matters: "Discard" is correct only if it also wrote nothing, and
// "Save & close" is correct only if it also wrote. A build that closed the tab either way
// passes every screen assertion.
test('BB-M10: closing a tab with unsaved work asks, and Cancel / Discard / Save & close each do their word', async ({
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

  // --- the question itself
  await fileTab(page).first().locator(WORKBENCH.tabCloseIn).click()
  await expect(modal(page)).toBeVisible({ timeout: 20_000 })
  // named the way the user knows the file — relative to the workspace. The negative half
  // is the one with teeth: an absolute path also contains `config/app.json`, so without it
  // a dialog reading `/private/var/folders/…/ws-a/config/app.json` passes.
  await expect(modal(page)).toContainText('config/app.json')
  await expect(modal(page)).not.toContainText(fx.root)
  const buttons = modal(page).locator('button')
  expect(await buttons.allTextContents()).toEqual(['Cancel', 'Discard', 'Save & close'])
  // §03 figure 3: the everyday answer holds the focus. This is a DELIBERATE departure from
  // CloseSessionDialog (whose default is Cancel), so it is asserted rather than assumed.
  await expect(modal(page).getByRole('button', { name: 'Save & close' })).toBeFocused()

  // --- Esc is still Cancel
  await page.keyboard.press('Escape')
  await expect(modal(page)).toHaveCount(0, { timeout: 10_000 })
  await expect(fileTab(page)).toHaveCount(1)
  await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)

  // --- Cancel keeps everything, typing included
  await fileTab(page).first().locator(WORKBENCH.tabCloseIn).click()
  await modal(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(modal(page)).toHaveCount(0, { timeout: 10_000 })
  await expect(fileTab(page)).toHaveCount(1)
  expect(await editText(page)).toBe(mine)
  expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)

  // --- Discard closes and writes nothing
  await fileTab(page).first().locator(WORKBENCH.tabCloseIn).click()
  await modal(page).getByRole('button', { name: 'Discard' }).click()
  await expect(fileTab(page)).toHaveCount(0, { timeout: 20_000 })
  expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)

  // --- Save & close closes AND writes
  const again = await dirtyEditor(page, fx.root, ed)
  await fileTab(page).first().locator(WORKBENCH.tabCloseIn).click()
  await modal(page).getByRole('button', { name: 'Save & close' }).click()
  await expect(fileTab(page)).toHaveCount(0, { timeout: 20_000 })
  await expect.poll(() => fs.readFileSync(ed.config, 'utf8'), { timeout: 20_000 }).toBe(again)
  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// BB-M12 (B-27) — the ninth file tab still closes one, but never the one holding unsaved
// work.
//
// The dirty tab is opened FIRST and then never touched again, which makes it the
// least-recently-used tab — i.e. exactly the victim the cap would pick by default. Without
// that ordering the case passes on a build with no skip rule at all.
//
// It also must not become a QUESTION: this path is one Claude can walk on its own, and the
// standing rule is that an agent's action never takes the current tab. So the absence of a
// modal is asserted, not just the survival of the tab.
test('BB-M12: the tab cap skips the tab with unsaved work and evicts the next one instead', async ({
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

  // seven more, filling the per-kind cap of eight
  for (const abs of fx.paths.changeable.slice(0, 7)) {
    await openFileTab(page, env, abs)
  }
  await expect(fileTab(page)).toHaveCount(8, { timeout: 30_000 })
  expect(await wbTabTitles(page)).toContain('app.json')

  const before = await wbTabs(page).count()
  await openFileTab(page, env, fx.paths.bulk[0])

  // the strip did not grow, so something really was closed…
  await expect(wbTabs(page)).toHaveCount(before, { timeout: 25_000 })
  const titles = await wbTabTitles(page)
  // …and it was the SECOND-oldest, not the dirty one
  expect(titles).toContain('app.json')
  expect(titles).toContain('part-1.ts')
  expect(titles).not.toContain('change-1.ts')
  await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)
  // nobody was asked anything
  await expect(page.locator('.modal')).toHaveCount(0)
  // …and the unsaved line is still in the buffer, not merely a dot on a tab
  await page.locator(WORKBENCH.tab, { hasText: 'app.json' }).click()
  await expect.poll(() => editText(page), { timeout: 20_000 }).toContain(MARKER)
  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// BB-N01 (N-01, B-04) — a file over the editing limit is readable and not editable, and the
// button says why.
//
// The size is what is under test, so the fixture sits between the two limits on purpose:
// 600 KB is over the 512 KB editing cap and well under the 2 MB reading cap. A file over
// both would leave the disabled ✎ ambiguous — it could be disabled because nothing was read
// at all — which is why the reading area is asserted to be showing the file first.
test('BB-N01: a 600 KB file reads fine and its ✎ is disabled with the size as the reason', async ({
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
  await expect(row(page, fx.root)).toBeVisible({ timeout: 30_000 })
  await row(page, `${fx.root}/config`).click()
  await row(page, ed.big).click({ timeout: 30_000 })

  // it really is on screen — that is what makes the disabled button below a SIZE verdict
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('config/big.txt', {
    timeout: 30_000
  })

  const edit = page.locator(EDIT.readEdit)
  await expect(edit).toBeVisible({ timeout: 20_000 })
  await expect(edit).toBeDisabled()
  // B-04 — hovering says why, and "why" names the limit rather than shrugging
  await expect(edit).toHaveAttribute('title', /512/)
  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// BB-C02 (B-05) — a file outside every workspace reads AND edits.
//
// It used to be the other half of this case: a roots-based fence refused the write, and the
// ✎ greyed out to say so before the save could. removed that fence with the assumption
// under it (that a session stays in the folder it started in — it can move to another
// checkout mid-conversation), so the decision is now the user's: Koloft writes where they
// point it. ⌗ Scratchpad is still the honest fixture — a real root the panel shows on
// purpose, outside every workspace, resolving under /private/tmp on macOS.
test('BB-C02: a file outside every workspace reads, and its ✎ works', async ({
  app,
  page,
  env
}) => {
  test.slow()
  const fx = setupChangeFixture(env.workspaces.a)
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

  const call = (await waitForCalls(env, 1))[0]
  // ⌗ Scratchpad lists what is on DISK, so seeding is enough — no session write needed
  const scratch = seedScratchpad(env, call.cwd, call.sessionId)

  await showBrowse(page)
  await expect(row(page, fx.root)).toBeVisible({ timeout: 30_000 })
  await row(page, scratch.md, 'scratchpad').click({ timeout: 30_000 })
  await expect(page.locator(WORKBENCH.readingTitle)).toContainText('notes.md', { timeout: 30_000 })

  const edit = page.locator(EDIT.readEdit)
  await expect(edit).toBeVisible({ timeout: 20_000 })
  await expect(edit).toBeEnabled({ timeout: 20_000 })

  // …and a file inside the workspace behaves the same way, as it always did
  await row(page, `${fx.root}/README.koloft.md`).click({ timeout: 30_000 })
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.koloft.md', {
    timeout: 30_000
  })
  await expect(page.locator(EDIT.readEdit)).toBeEnabled({ timeout: 20_000 })
  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// the reader has no fence either. It used to refuse a file that sat outside every
// workspace and that no session had touched; the decision (risk stated and accepted) is
// that what the person can see, Koloft can read. Pinned, because it is the kind of thing a
// later change could quietly narrow again without anyone deciding to.
test('a file outside every workspace is read, not refused', async ({ page, env }) => {
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

// BB-C16 (B-15) — the boundary the design calls out by name: a CLEAN buffer plus a changed
// file is NOT a conflict. It reloads the way the panel always has, silently.
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
  await expect(row(page, fx.root)).toBeVisible({ timeout: 30_000 })
  await row(page, `${fx.root}/config`).click()
  await row(page, ed.config).click({ button: 'right', timeout: 30_000 })
  await page.locator(EDIT.ctxMenu).getByText('Edit', { exact: true }).click()
  await editReady(page, 'koloft-e2e-edit-fixture')
  await expect(page.locator(EDIT.dirty)).toHaveCount(0)

  const theirs = ed.configBody + 'WRITTEN_WHILE_CLEAN=1\n'
  fs.writeFileSync(ed.config, theirs)

  await expect.poll(() => editText(page), { timeout: 30_000 }).toBe(theirs)
  await expect(page.locator(EDIT.stale)).toHaveCount(0)
  await expect(page.locator(EDIT.dirty)).toHaveCount(0)

  // …and a save from there lands, i.e. the fingerprint moved with the reload
  await typeAtEnd(page, 'KOLOFT_E2E_AFTER_AUTORELOAD=1')
  await page.keyboard.press('Enter')
  await sendSave(app)
  await expect
    .poll(() => fs.readFileSync(ed.config, 'utf8'), { timeout: 20_000 })
    .toBe(theirs + 'KOLOFT_E2E_AFTER_AUTORELOAD=1\n')
  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// BB-C14a (B-25) — a session that is running AND holding unsaved work asks ONE question,
// not two in a row.
//
// The count of `.modal` is the assertion carrying this case. Two dialogs stacked would
// satisfy every text check here — the second sits behind the first and its buttons still
// read correctly — and the user would answer the same close twice, which is exactly what
// B-25 forbids.
//
// The focus check is the other half, and it points the OPPOSITE way from BB-M10's: this
// row of buttons still ends a running process, so the default stays on Cancel even though
// the plain unsaved dialog next door defaults to Save & close.
test('BB-C14a: a running session with unsaved work asks once, and names the file in that one question', async ({
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

  // genuinely mid-turn (`/busy` holds the turn open ~30 s), and typing it also parks the
  // focus in the TUI — ⌘W reaches the SESSION close path only while the panel does NOT hold
  // the focus, so this is a precondition rather than a convenience
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

  // --- Save & close closes only once every buffer really reached the disk. Made to fail for
  // the one reason that matters: somebody else moved the file underneath.
  //
  // A refused save takes the QUESTION down and brings the offending tab forward with a toast
  // saying why — a refusal is not a "try again here" state, and the difference and the two
  // ways out of it live on the file's own tab. So the dialog going away is correct and is
  // not the thing under test. What must NOT happen is the CLOSE: the buffer is still the
  // only copy of that work, and the session holding it has to survive.
  //
  // The process probe is what separates those two. "Dismissed" and "dismissed and closed"
  // look identical on screen — the dialog is gone either way and the row stays either way
  // (D3 keeps it, cold) — so only the pid can tell them apart.
  fs.writeFileSync(ed.config, ed.configBody + 'EXTERNAL_LINE=1\n')
  await dlg.getByRole('button', { name: 'Save & close' }).click()
  await expect(dlg).toHaveCount(0, { timeout: 20_000 })
  await expect(page.locator('.toast')).toBeVisible({ timeout: 20_000 })
  // …the typing is still the buffer's only copy, on disk and on the tab…
  expect(fs.readFileSync(ed.config, 'utf8')).not.toBe(mine)
  await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)
  // …and the session was not killed on the way out
  expect(processAlive(session.pid)).toBe(true)

  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// BB-C14b (B-25) — the other side of the same branch: an idle session closes without a word
// normally, so unsaved files are the ONLY thing left to ask about, and the question is the
// plain figure-3 one rather than D3's.
//
// Its whole value is telling the two dialogs apart. A build that always raised the
// running-session dialog passes BB-C14a and asks a user with an idle session to answer a
// question about interrupting a turn that is not happening.
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
  // move the focus out of the panel without starting a turn, so ⌘W is the session's
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

  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// BB-C14c (B-25) — the success half of the same button. BB-C14a only proves that a REFUSED
// save keeps the dialog up; on its own that is satisfied by a button that never closes
// anything at all.
//
// Both halves of "Save & close" are asserted, and they fail independently: the bytes on
// disk (a build that closed without writing) and the session really ending (a build that
// wrote and then left the session running, which is the same work lost one step later).
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

  // the file first — this is the claim the whole button exists for
  await expect.poll(() => fs.readFileSync(ed.config, 'utf8'), { timeout: 25_000 }).toBe(mine)
  // …and then the close really happened. The row survives (D3: the pty dies, the row goes
  // cold and stays resumable), so "closed" is read off the process, not off the row leaving.
  await expect(dlg).toHaveCount(0, { timeout: 20_000 })
  await expect.poll(() => processAlive(session.pid), { timeout: 30_000 }).toBe(false)
  await expect(wsRow).toHaveClass(/\bcold\b/, { timeout: 30_000 })
  // nothing is left holding unsaved work
  await expect(page.locator(EDIT.tabDirty)).toHaveCount(0)

  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// BB-C14d (B-25) — the middle button. Same close, with the typing deliberately thrown away.
//
// The disk assertion is the one with teeth and it is a NEGATIVE: "Discard" is only correct
// if it also wrote nothing, and a build that quietly saved on the way out passes every
// screen check while doing the opposite of what the button says.
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
  // the file is exactly as it was committed — the typing went nowhere, which is what the
  // button promised
  expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)

  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// BB-C24 (B-31) — the seventh loss path, found while implementing: removing a workspace
// closes every session under it, and the buffers would go with them.
//
// The reachable shape in e2e is the MERGED one. A dirty buffer needs a live session and a
// live session makes the count non-zero, so `confirm-running` is the branch a test can get
// to; the sessions-idle variant (the plain unsaved question) has no e2e route and is noted
// in the cases file rather than faked here.
//
// Cancel is what the case turns on. The removal is irreversible and it is the one answer
// that has to leave every single thing standing — the pin, the session and the typing.
test('BB-C24: removing a workspace with unsaved work says so, and Cancel leaves everything standing', async ({
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
  // the sentence the ordinary removal does not have — and the count, since a removal spans
  // every session under the workspace and the names would not fit
  await expect(dlg).toContainText('1 file has unsaved changes in these sessions and will be lost.')
  expect(await dlg.locator('.modal-foot button').allTextContents()).toEqual([
    'Cancel',
    'Discard & remove',
    'Save & remove'
  ])
  // same default as B-25 and for the same reason: this button row also kills processes
  await expect(dlg.getByRole('button', { name: 'Cancel' })).toBeFocused()

  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await expect(dlg).toHaveCount(0, { timeout: 10_000 })

  // everything is still there: the pin, the typing, and the file untouched on disk
  await expect(page.locator('.ws-head .ws-name', { hasText: 'ws-a' })).toHaveCount(1)
  await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)
  expect(await editText(page)).toBe(mine)
  expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)

  // B-26: the quit guard would put the unsaved question up and hold the teardown open
  // for good; this is the approval the renderer sends after Discard.
  await closeDiscardingEdits(app)
})

// BB-C25 (B-32) — the session swaps its id under the panel and the buffer must come along.
//
// `/clear` is the cheapest of the three id swaps to drive (the others are an in-TUI
// `/resume` and a cold session being recycled) and the fixture claude reproduces it entry
// for entry from the contract ledger, docs/claude-code-contract.md §1 and §2: SessionEnd
// with reason `clear` while the PROCESS STAYS ALIVE, then a brand-new uuid whose jsonl is
// written immediately (§2's stated exception to CC's lazy transcript), then SessionStart
// with source `clear` on the same tab.
//
// The new id is waited for on disk rather than on screen: the layout registration is where
// the tab set arrives under the new id, and it is the same oracle BB-C40 uses for the
// browser half of this exact swap. Waiting on anything in the panel would be waiting on the
// thing under test.
//
// The assertion carrying this case is `editText` — B-32's failure mode is that the buffer
// registry is keyed by session id, so the OLD key goes away with the old id and the text
// vanishes with no warning at all. A tab that survived and a dot that survived can both be
// true while the textarea has silently reverted to the file on disk, so the tab count and
// the dirty dot are checked as company, never as the proof.
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

  await runIn(page, centerTerm(page), '/clear')

  let newId = ''
  await expect
    .poll(
      () => {
        const ids = Object.keys(layoutOnDisk(env).sessions ?? {})
        newId = ids.find((i) => i !== call.sessionId) ?? ''
        return newId
      },
      { timeout: 60_000 }
    )
    .not.toBe('')

  // the tab is still on the strip…
  await expect(fileTab(page)).toHaveCount(1, { timeout: 20_000 })
  // …and it is the ACTIVE one, re-selected by path across the id swap rather than the strip
  // falling back to the pinned Files tab — the dirty mark on the active tab says both halves
  // at once
  await expect(page.locator('.wb-tab.on .dirty')).toHaveCount(1, { timeout: 20_000 })
  await expect(page.locator(WORKBENCH.tabFiles)).not.toHaveClass(/\bon\b/)
  // …and it is still an EDITOR holding exactly what was typed, which is the whole case
  await expect(page.locator(EDIT.area)).toBeVisible({ timeout: 20_000 })
  expect(await editText(page)).toBe(mine)
  await expect(page.locator(EDIT.dirty)).toBeVisible()

  // and the buffer is still reachable by the save path, not merely displayed.
  //
  // The click is required, not tidiness: ⌘S is dispatched BY FOCUS (`App.tsx`, B-16), and
  // `/clear` above was typed into the TUI, which still holds it. A ⌘S there belongs to
  // Claude, not to the panel — so a user saving their file goes back to it first, and this
  // is that step.
  await page.locator(EDIT.area).click()
  await sendSave(app)
  await expect.poll(() => fs.readFileSync(ed.config, 'utf8'), { timeout: 20_000 }).toBe(mine)
  await expect(page.locator(EDIT.dirty)).toHaveCount(0, { timeout: 20_000 })

  await closeDiscardingEdits(app)
})

// BB-C25b (B-32, the ⇧⌘R twin of BB-C25) — the third id swap, and the one that changes the
// PTY rather than the Claude session: ⇧⌘R kills the claude process and puts a fresh one in
// the same conversation-tab slot.
//
// It needs its own case because it breaks differently. BB-C25's `/clear` keeps the pty and
// swaps the Claude session id; here the Claude session id is the thing that stays (the new
// process runs `--resume <same id>`) while the PTY id underneath changes. R1 keys the
// panel — and with it `editRegistry`'s buffers — on the conversation tab, whose id IS the
// pty id, so a restart that forgets to carry those buffers onto the new key loses them
// exactly the way B-32 lost them, from the other direction. A build can pass BB-C25 and
// fail this one.
//
// `editText` is the assertion carrying the case, for BB-C25's reason: a tab that survived
// and a dot that survived can both be true while the textarea has quietly reverted to the
// file on disk. The ⌘W prompt is the third witness and the one the USER meets — a buffer
// the registry has lost is a buffer nothing will ask about, so the app would close the tab
// silently and the work would be gone with no question asked.
//
// The barrier is the second launch in the call log (restart-session.spec's oracle): the row
// never goes cold and no id changes on disk, so the launch log is the only place the
// restart's completion is observable from outside.
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
  expect(calls[1].argv[i + 1]).toBe(first.sessionId) // same session, new process

  // the tab is still on the strip, still active, still marked dirty…
  await expect(fileTab(page)).toHaveCount(1, { timeout: 20_000 })
  await expect(page.locator('.wb-tab.on .dirty')).toHaveCount(1, { timeout: 20_000 })
  // …and it is still an EDITOR holding exactly what was typed, which is the whole case
  await expect(page.locator(EDIT.area)).toBeVisible({ timeout: 20_000 })
  expect(await editText(page)).toBe(mine)
  await expect(page.locator(EDIT.dirty)).toBeVisible()

  // …and the guard still knows about it: ⌘W asks rather than closing, and Cancel keeps
  // both the tab and the text. Nothing was written to disk on the way through.
  await sendShortcut(app, 'shortcut:close-tab')
  await expect(modal(page)).toBeVisible({ timeout: 20_000 })
  await modal(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(modal(page)).toHaveCount(0, { timeout: 10_000 })
  await expect(fileTab(page)).toHaveCount(1)
  expect(await editText(page)).toBe(mine)
  expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)

  await closeDiscardingEdits(app)
})

// BB-C26 (B-26) — quitting Koloft with unsaved work asks first, and Cancel really does keep
// the app open.
//
// The design calls this the most expensive of the three guards, because main's `before-quit`
// is synchronous and the question is not: quitting runs through that handler more than once
// — block and ask, then let the second quit past once the answer is in.
//
// It is drivable here only because the quit is raised from OUTSIDE the fixture teardown.
// `app.quit()` through `app.evaluate` is the same call ⌘Q makes, so the guard is exercised
// end to end while the test still owns the page and can answer the question. Nothing in this
// test may be reordered after the final Discard: the app is gone from that point on.
test('BB-C26: quitting with unsaved work asks, Cancel keeps the app open, Discard lets it go', async ({
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

  // --- ⌘Q, the first time
  await app.evaluate(({ app: electronApp }) => electronApp.quit())
  await expect(modal(page)).toBeVisible({ timeout: 20_000 })
  await expect(modal(page)).toContainText('config/app.json')

  // --- Cancel. The app has to still be RUNNING, which the dialog closing does not show on
  // its own: main blocked the quit and is now waiting, and a build that let the quit through
  // anyway would take the window down a moment later with the dialog already gone. Asking
  // the renderer to evaluate something is the check that only a live app can pass.
  await modal(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(modal(page)).toHaveCount(0, { timeout: 10_000 })
  expect(await page.evaluate(() => 6 * 7)).toBe(42)
  await expect(page.locator(EDIT.tabDirty)).toHaveCount(1)

  // --- and asking again really asks again: the guard went back to rest rather than
  // remembering the first answer
  const exited = app.waitForEvent('close', { timeout: 60_000 })
  await app.evaluate(({ app: electronApp }) => electronApp.quit())
  await expect(modal(page)).toBeVisible({ timeout: 20_000 })
  await modal(page).getByRole('button', { name: 'Discard' }).click()

  await exited
  // the typing was thrown away, not written — read after the app is gone, so nothing could
  // still be in flight
  expect(fs.readFileSync(ed.config, 'utf8')).toBe(ed.configBody)
  // no `closeDiscardingEdits` here: the app is already down, and this case's whole point is
  // that it went down through the guard rather than around it
})
