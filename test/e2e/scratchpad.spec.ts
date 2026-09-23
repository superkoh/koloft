import { test, expect } from './helpers/app'
import {
  centerTerm,
  FAKE_SESSION_TITLE,
  gitCommitAll,
  gitInit,
  runIn,
  startSessionIn,
  waitBooted
} from './helpers/p1'
import { openTabs } from './helpers/browser'
import { activeKind, showBrowse, WORKBENCH, workbenchPanel } from './helpers/workbench'
import fs from 'fs'
import path from 'path'

// The "⌗ Scratchpad" node: files a session drops in Claude's per-session scratch dir
// (<base>/<projectSlug>/<sessionId>/scratchpad, outside every workspace root) are reachable
// from the file tree. The node lists the REAL directory, so what lands there by Bash or by a
// subagent — with no tool_use behind it — shows up too. The isolated <base> is the
// KOLOFT_SCRATCHPAD_BASE seam under the test's throwaway $HOME, never the real /tmp/claude-<uid>.
//
// Locators are regex on purpose: Playwright's `hasText` with a STRING is case-INSENSITIVE,
// and the fixture workspace already gets an in-project NOTES.md from the startup turn — a
// string matcher would happily green on the wrong row.
//
// Issue moved BOTH halves of what these cases drive:
//  · the tree itself retired into the panel's Browse half (FR-44/FR-46), so every `.ft-*`
//    locator here needs `showBrowse` first and is scoped to the panel. Browse carries the
//    retired tree's class vocabulary verbatim — BrowseView's `sectionHead` says
//    `.ft-scratchpad` "has no CSS at all and exists purely as a query hook, which is
//    exactly why it has to be carried across" — so the node, its icon, its label and its
//    count all survive the move unchanged;
//  · a row click lands in the pinned `files` tab's reading area (FR-10) rather than the
//    retired aux Preview pane. The kit's `readingTitle` / `readingBody` name that surface.
//
// RETIRED with the sidebar tree: the All / Changed / Preview chip ladder and the
// chip-scoping clauses that rode on it. FR-46 makes ⌗ Scratchpad and ↗ Outside
// unconditional first-class roots of Browse — "Browse offers the two virtual roots
// `⌗ Scratchpad` and `↗ Outside`" — so reaching the node no longer requires selecting a
// filter first. That is a route that stopped existing, not one that moved.
//
// Deleted rather than adapted, deliberately: `.ft-chip` still resolves, but it now means
// FR-40's Status / Ownership / Type chips in the Changes filter menu, and each of those
// three groups carries an `all` chip — so an inherited `.ft-chip.on` → toHaveText('All')
// would go GREEN against a different feature. A green test pointed at the wrong feature is
// worse than a red one.

test('a file claude drops in its scratchpad is listed in Browse and opens', async ({
  page,
  env
}) => {
  test.setTimeout(150_000)

  // a clean repo, so Browse's decorations are well defined. (It used to be a DIRTY one, to
  // give the former Changed chip something to filter; that clause is gone — see header.)
  gitInit(env.workspaces.a)
  gitCommitAll(env.workspaces.a)

  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await expect(page.locator('.ws-tab-title', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
    timeout: 40_000
  })

  // The write itself is transcript-silent (no tool_use, no hook) — the Bash/subagent shape.
  // The scratchpad dir does not exist when a session binds, so the tree's fs watch on it
  // could not attach and discovery rides a re-list throttled on session activity. `ping` is
  // the explicit tick this fixture command is too quiet to produce on its own; a real Bash
  // write always carries its own tool_use record, and a subagent grows its own transcript.
  await runIn(page, centerTerm(page), '/scratch analysis.py')
  await runIn(page, centerTerm(page), 'ping')

  // --- the fix: FR-46's root is there on arrival, with nothing to select first ---------
  // `showBrowse` only reaches Browse; it selects no filter and expands no section, so the
  // node being visible right after it IS the "no gesture required" clause the former
  // chip step used to carry.
  await showBrowse(page)
  const panel = workbenchPanel(page)
  const scratchpad = panel.locator('.ft-scratchpad')
  await expect(scratchpad).toBeVisible({ timeout: 40_000 })
  await expect(scratchpad.locator('.ft-ext-icon')).toHaveText('⌗')
  await expect(scratchpad.locator('.ft-name')).toHaveText('Scratchpad')
  await expect(scratchpad.locator('.ft-dir-agg')).toHaveText('1')

  // the node points at the session's REAL scratch dir under the seam base, not at some
  // path re-derived from the workspace
  const dir = await scratchpad.getAttribute('data-path')
  expect(dir?.startsWith(env.scratchpadBase + path.sep)).toBe(true)
  expect(path.basename(dir!)).toBe('scratchpad')
  expect(fs.existsSync(path.join(dir!, 'analysis.py'))).toBe(true)

  const analysis = panel.locator('.ft-node.ft-file', { hasText: /analysis\.py/ })
  await expect(analysis).toHaveCount(1)
  await expect(analysis).toBeVisible()

  // --- it really opens: a code file out of root renders like any other ----------------
  // FR-10: the click makes no tab at all — it renders in the pinned `files` tab's reading
  // area, which stays the active tab throughout
  await analysis.click()
  await expect.poll(() => activeKind(page), { timeout: 15_000 }).toBe('files')
  await expect(openTabs(page)).toHaveCount(0)
  // FR-31's path form, on a file that has no relative form: the header relativizes against
  // the workspace root, and the scratchpad is outside it, so the dimmed half is the whole
  // absolute directory rather than a short prefix. Asserted as both halves — strictly
  // sharper than the former pane's bare basename, because it says WHICH analysis.py is on
  // screen, which is the entire point of a node that lists a directory out of tree.
  const title = page.locator(WORKBENCH.readingTitle)
  await expect(title).toContainText('analysis.py', { timeout: 15_000 })
  await expect(title.locator('.dir')).toHaveText(`${dir}/`)
  await expect(page.locator(WORKBENCH.readingBody)).toContainText('koloft_e2e_scratch_body', {
    timeout: 15_000
  })
})

// MOVED, not dropped: "a scratchpad file the session also wrote is listed once, not also
// under ↗ Outside" now lives in workbench-browse.spec.ts's WB-B04, beside the other three
// A7 constraints FR-46 locks. It belongs there under the one-spec-per-flow rule, and it is
// a sharper case there: WB-B04 asserts the OTHER Outside rows are visible in the same
// breath, so the absence reads as de-duplication rather than as an Outside pipeline that
// never ran — a barrier this file had to build by hand out of a seeded control file.

test('a session that has written nothing to its scratchpad shows no Scratchpad node', async ({
  page
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await expect(page.locator('.ws-tab-title', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
    timeout: 40_000
  })

  // the startup turn's in-project NOTES.md is the gate, and it carries more weight now
  // than it did in the sidebar: `.ft-scratchpad` renders only inside Browse, so a
  // `toHaveCount(0)` taken anywhere else would pass for the wrong reason entirely. The
  // NOTES.md row proves Browse is on screen AND has listed the root for this session, so
  // an absent node is a decision and not a slow first paint.
  await showBrowse(page)
  const panel = workbenchPanel(page)
  await expect(panel.locator('.ft-node.ft-file', { hasText: /NOTES\.md/ })).toHaveCount(1, {
    timeout: 40_000
  })
  await expect(panel.locator('.ft-scratchpad')).toHaveCount(0)

  // and it stays absent across the re-list a session tick triggers — an empty (here:
  // missing) dir must never render an empty node. The terminal echo is the deterministic
  // gate that the tick landed; only the settle window after it has to be waited out,
  // since "a node never appears" has nothing positive to poll for.
  await runIn(page, centerTerm(page), 'ping')
  await expect(centerTerm(page)).toContainText('handled: ping', { timeout: 30_000 })
  await page.waitForTimeout(1200) // > the re-list throttle
  await expect(panel.locator('.ft-scratchpad')).toHaveCount(0)
})
