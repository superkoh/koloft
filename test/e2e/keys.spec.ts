import path from 'path'
import { test, expect } from './helpers/app'
import {
  centerTerm,
  gitInit,
  processAlive,
  runIn,
  sendShortcut,
  snap,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { WORKBENCH, openInBrowse, showBrowse, workbenchPanel } from './helpers/workbench'

// P1 keyboard matrix. Hard §0 rule: ⌘⇧F / ⌘F are
// native menu accelerators, so the specs send the same `shortcut:*` IPC the menu
// forwards — synthesized keystrokes never reach the app menu.

// T-KEY-03 — ⌘⇧F expands the file search row; collapsing IS ending the search: the query
// (and its filtering) is cleared, never left active invisibly.
//
// RETARGETED by the tree's retirement. The row moved out of the sidebar Files island into
// the pinned `files` tab's Browse half (FR-45), so the case needs a session now — it used
// to run with none, off the island that rooted at the first intact workspace. The
// reachability half of that ("⌘⇧F expands a collapsed panel; no session, no effect") is
// WB-B02's, in workbench-files-shell.spec.ts. What is still this case's own, and is why it
// survives rather than folding into WB-B02, is the FILTERING: the results list replaces
// the tree, lists only matches, and closing brings the whole tree back.
test('T-KEY-03: ⌘⇧F toggles the file search row; collapsing clears the filter', async ({
  app,
  page
}) => {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  const panel = workbenchPanel(page)
  await showBrowse(page)
  await expect(panel.locator('.icobtn[aria-label="Search files"]')).toBeVisible({
    timeout: 20_000
  })
  // scoped to Browse's own body: ChangesView's left-list rows are `.ft-node cv-row` too,
  // and Changes is the half the tab opens on — a bare `.ft-node` would match either
  const tree = panel.locator('.bv-body')
  await expect(tree.locator('.ft-node', { hasText: 'README.md' })).toBeVisible({
    timeout: 20_000
  })

  await sendShortcut(app, 'shortcut:find-files')
  const searchRow = panel.locator('.ft-search.open')
  await expect(searchRow).toBeVisible()
  const input = panel.locator('.ft-search-input')
  await expect(input).toBeFocused()

  // typing filters: the results view replaces the tree, only matches listed
  await input.fill('app')
  const results = panel.locator('.ft-results')
  await expect(results).toBeVisible()
  await expect(results.locator('.ft-result .ft-name', { hasText: 'app.ts' })).toBeVisible()
  await expect(results.locator('.ft-result', { hasText: 'README.md' })).toHaveCount(0)
  await snap(page, 'T-KEY-03')

  // collapse via the same IPC: the row closes AND the filter is gone — the full
  // tree is back, and reopening starts from an empty query
  await sendShortcut(app, 'shortcut:find-files')
  await expect(panel.locator('.ft-search.open')).toHaveCount(0)
  await expect(panel.locator('.ft-results')).toHaveCount(0)
  await expect(tree.locator('.ft-node', { hasText: 'README.md' })).toBeVisible()

  await sendShortcut(app, 'shortcut:find-files')
  await expect(panel.locator('.ft-search.open')).toBeVisible()
  await expect(input).toHaveValue('')
})

// T-KEY-04 — ⌘F smoke: with a searchable preview open, the find bar appears,
// counts a match, and Esc dismisses it. The keyboard.type below is load-bearing:
// real key events once froze the renderer (BUG-P1-01 — React 19 re-set innerHTML on
// every {__html} wrapper identity change, feeding the find observer's re-search loop),
// so this test doubles as the regression gate for that cycle.
test('T-KEY-04: ⌘F opens the preview find bar, counts matches, Esc closes it', async ({
  app,
  page,
  env
}) => {
  // the reading area is per-session, and the session's own root is what Browse shows
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await openInBrowse(page, path.join(env.workspaces.a, 'README.md'))
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.md', { timeout: 15_000 })

  await sendShortcut(app, 'shortcut:find')
  const bar = page.locator('.find-bar')
  await expect(bar).toBeVisible()
  await expect(bar.locator('.find-input')).toBeFocused()

  // the input is asserted focused — type through the keyboard (renderer key events,
  // the same channel a user's keystrokes take once the bar has focus)
  await page.keyboard.type('koloft-e2e-alpha')
  await expect(bar.locator('.find-count')).toHaveText('1/1')
  await snap(page, 'T-KEY-04')

  await page.keyboard.press('Escape')
  await expect(page.locator('.find-bar')).toHaveCount(0)
  // Esc closed only the find bar, not the preview under it
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.md')
})

// T-KEY-05 (the lifecycle contract D3, replacing the former T-KEY-01) — the policy reversal:
// ⌘W outside the aux island now CLOSES a bound running session, but a session
// mid-turn asks first. The dialog's keyboard contract is one-directional — Esc and ⏎
// both mean Cancel, so no reflex can end a turn; only a deliberate Close does. What
// Close leaves behind is a cold row: the kill travels as a signal, and a signalled
// SessionEnd reports 'other', which is outside D1's removal whitelist.
test('T-KEY-05: ⌘W on a working session confirms first — Esc/⏎ cancel, Close kills it cold', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  gitInit(env.workspaces.a)
  await startSessionIn(page, 'ws-a')
  const [session] = await waitForCalls(env, 1)
  const row = wsRows(page, 'ws-a').first()

  // put the session genuinely mid-turn (/busy holds the turn open ~30s)
  await runIn(page, centerTerm(page), '/busy')
  await expect(row).toHaveClass(/\bst-working\b/, { timeout: 30_000 })

  const dialog = page.locator('.modal', { hasText: 'Close running session?' })
  const raise = async (): Promise<void> => {
    await sendShortcut(app, 'shortcut:close-tab')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
  }

  // ① focus in the centre TUI: the confirm comes up, Esc leaves everything running
  await centerTerm(page).click()
  await raise()
  await snap(page, 'T-KEY-05')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(processAlive(session.pid)).toBe(true)
  await expect(row).not.toHaveClass(/\bcold\b/)

  // ② focus in the sidebar (clicking the row parks focus outside every island): same
  // confirm, and ⏎ is Cancel too — the destructive button is never the default
  await row.click()
  await raise()
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await page.waitForTimeout(2000)
  expect(processAlive(session.pid)).toBe(true)
  await expect(row).not.toHaveClass(/\bcold\b/)

  // ③ Close, deliberately: the process dies and the row stays — cold, resumable
  await raise()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => processAlive(session.pid), { timeout: 30_000 }).toBe(false)
  await expect(row).toHaveClass(/\bcold\b/, { timeout: 40_000 })
  await expect(wsRows(page, 'ws-a')).toHaveCount(1)
})

// T-KEY-06 (the lifecycle contract D3, the silent half) — the confirm is scoped to a session
// that would LOSE something: with the turn already finished (waiting) ⌘W closes it
// outright, no dialog. The row still stays, cold: closing is not leaving.
test('T-KEY-06: ⌘W on a waiting session closes it silently and leaves a cold row', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(240_000)
  gitInit(env.workspaces.a)
  await startSessionIn(page, 'ws-a')
  const [session] = await waitForCalls(env, 1)
  const row = wsRows(page, 'ws-a').first()
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 40_000 })

  await row.click()
  await sendShortcut(app, 'shortcut:close-tab')
  await expect.poll(() => processAlive(session.pid), { timeout: 30_000 }).toBe(false)
  // nothing was ever asked — the confirm belongs to working/approval alone
  await expect(page.locator('.modal-backdrop')).toHaveCount(0)
  await expect(row).toHaveClass(/\bcold\b/, { timeout: 40_000 })
  await expect(wsRows(page, 'ws-a')).toHaveCount(1)
  await snap(page, 'T-KEY-06')
})
