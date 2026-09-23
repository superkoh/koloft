import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import type { E2EEnv } from './helpers/env'
import { centerTerm, runIn, startSessionIn, termIds, waitBooted, waitForCalls } from './helpers/p1'
import { LINE42_MARKER, seedOutsideDir, setupChangeFixture } from './helpers/filesFixture'
import {
  WORKBENCH,
  activeKind,
  openInBrowse,
  seedScratchpad,
  showBrowse,
  wbActiveTab,
  wbTabs,
  workbenchPanel
} from './helpers/workbench'
import { guestByUrl, openTabs } from './helpers/browser'

/**
 * Workbench · the `files` tab's BROWSE half.
 *
 * Browse is the former sidebar `FileTree`'s job moved into the panel: lazy directory
 * browsing, the two virtual roots, both search modes, the decoration rail, the row context
 * menu, keyboard navigation and the two per-workspace localStorage conveniences. Its cases
 * live apart from the shell's (workbench-files-shell.spec.ts) for the reason the shell's do:
 * they must keep failing for the tree's reasons, not for the kind bar's.
 *
 * Two things worth knowing before reading any test here:
 *  - Browse is NOT the default half. `useFilesController` starts on `changes`, so every
 *    case reaches Browse first (`showBrowse`) — except the ones a USER-sourced open drags
 *    there by itself (FR-57), which is asserted rather than assumed where it matters.
 *  - the row context menu is PORTALLED to `document.body` and `position: fixed`, so it is
 *    not inside `.wb-panel`; every locator for it is rooted at the page (the trap list in
 *    helpers/workbench.ts's header).
 *
 * WB-B02 (⌘⇧F) is deliberately absent: it belongs to the shell and is covered in
 * workbench-files-shell.spec.ts. Nothing here re-tests it.
 */

// ---- locators ---------------------------------------------------------------------------

/**
 * One Browse row, scoped to the SECTION it belongs to.
 *
 * The scoping is not tidiness: the same file can be on screen three times at once (its
 * place in the tree, a Bookmarks row and a Recents row), and a bare `[data-path]` locator
 * matches all of them — so `toHaveCount(0)` on one section would read as a pass while the
 * row is right there in another, and `.click()` would fail as a strict-mode violation.
 */
function row(page: Page, abs: string, section = 'tree'): Locator {
  return page.locator(`.wb-panel .bv-sec[data-section="${section}"] .ft-node[data-path="${abs}"]`)
}

function section(page: Page, name: string): Locator {
  return page.locator(`.wb-panel .bv-sec[data-section="${name}"]`)
}

/** Every file row of one section, in render order (Recents' oracle: order IS the contract). */
function fileRows(page: Page, name: string): Locator {
  return page.locator(`.wb-panel .bv-sec[data-section="${name}"] .ft-node.ft-file`)
}

/** The Files half's own Changes/Browse switch, matched through the labelled group rather
 *  than by button text: Browse renders file rows, and one of them could carry either word. */
function halfBtn(page: Page, name: 'Changes' | 'Browse'): Locator {
  return page.locator('.wb-bar .seg[aria-label="Files view"] button', { hasText: name })
}

const searchToggle = (page: Page): Locator =>
  page.locator('.wb-bar .icobtn[aria-label="Search files"]')
const searchInput = (page: Page): Locator => page.locator('.wb-panel .ft-search-input')
const searchMode = (page: Page, mode: 'name' | 'content'): Locator =>
  page.locator(`.wb-panel .ft-mode-btn[data-mode="${mode}"]`)

/** FR-48's menu. Rooted at the PAGE: it is portalled out of the panel (see the file doc). */
const ctxMenu = (page: Page): Locator => page.locator('.ft-ctx[role="menu"]')
const ctxItems = (page: Page): Locator => page.locator('.ft-ctx .ft-ctx-it')

const readingTitle = (page: Page): Locator => page.locator(WORKBENCH.readingTitle)
const readingBody = (page: Page): Locator => page.locator(WORKBENCH.readingBody)

// ---- small oracles ----------------------------------------------------------------------

/** Reach Browse with the fixture tree already listed — the barrier every case below needs
 *  before it can click a row (the first `listDir` is a real IPC round trip). */
async function browseReady(page: Page, root: string): Promise<void> {
  await showBrowse(page)
  await expect(row(page, root)).toBeVisible({ timeout: 30_000 })
  await expect(row(page, `${root}/src`)).toBeVisible({ timeout: 30_000 })
}

/** Expand every ancestor of `abs` under `root`, top down. Spelled out rather than reusing
 *  `openInBrowse` where the EXPANSION itself is the subject. */
async function expandTo(page: Page, root: string, abs: string): Promise<void> {
  const segs = abs.slice(root.length + 1).split('/')
  let dir = root
  for (const seg of segs.slice(0, -1)) {
    dir += '/' + seg
    const r = row(page, dir)
    await expect(r).toBeVisible({ timeout: 20_000 })
    if (!(await r.getAttribute('class'))?.split(/\s+/).includes('open')) await r.click()
    await expect(r).toHaveClass(/\bopen\b/, { timeout: 20_000 })
  }
}

/**
 * Is a tree row inside the visible band of the SCROLLING tree body?
 *
 * Measured geometrically in one evaluate rather than through `toBeInViewport`: the tree
 * scrolls inside its own clipping container, and a row scrolled out of THAT can still sit
 * inside the browser window — which would make FR-47's auto-scroll assertion pass on a
 * build that revealed the row and never scrolled to it.
 */
async function rowInBody(page: Page, abs: string): Promise<boolean> {
  return page.evaluate((p) => {
    const body = document.querySelector('.wb-panel .bv-body') as HTMLElement | null
    const el = document.querySelector(
      `.wb-panel .bv-sec[data-section="tree"] .ft-node[data-path="${p}"]`
    ) as HTMLElement | null
    if (!body || !el) return false
    const b = body.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return r.bottom > b.top && r.top < b.bottom
  }, abs)
}

/** Is the reading area's source line `n` inside the visible band of the artifact? Same
 *  measurement, same reason, one container down (see `rowInBody`). */
async function sourceLineInView(page: Page, n: number): Promise<boolean> {
  return page.evaluate((line) => {
    const host = document.querySelector('.wb-panel .fv-read .wb-artifact') as HTMLElement | null
    const el = document.querySelectorAll<HTMLElement>('.wb-panel .fv-read .code-body .line')[
      line - 1
    ]
    if (!host || !el) return false
    const h = host.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return r.bottom > h.top && r.top < h.bottom
  }, n)
}

/** The session TUI's cursor column, read off the live xterm through the `__koloftTerms` seam.
 *  The pty echoes what the product writes into it, so this counts the characters that
 *  actually landed on the input line — trailing space included. */
async function ttyCursorX(page: Page): Promise<number> {
  const ids = await termIds(page)
  return page.evaluate((id) => {
    const map = (
      window as unknown as {
        __koloftTerms?: Record<string, { buffer: { active: { cursorX: number } } }>
      }
    ).__koloftTerms
    return map?.[id]?.buffer.active.cursorX ?? -1
  }, ids[0])
}

/** A file's contents, or '' while it is not there yet — so a poll can wait for a write
 *  rather than throwing on the first miss. */
function readIfPresent(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** Relaunch against the SAME home — the restart half of WB-B06 and WB-P06. localStorage
 *  lives in `--user-data-dir`, so the two Browse conveniences ride through it. */
async function relaunch(
  app: ElectronApplication,
  env: E2EEnv
): Promise<{ app: ElectronApplication; page: Page }> {
  await app.close().catch(() => {})
  const next = await launchApp(env)
  const page = await next.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app: next, page }
}

/** The stream's scroll offset and one block's own offset, in one read (WB-R13). */
async function streamAt(page: Page, rel: string): Promise<{ scrollTop: number; blockTop: number }> {
  return page.evaluate((r) => {
    const stream = document.querySelector('.wb-panel .cv-stream') as HTMLElement | null
    const blk = document.querySelector(`.wb-panel .cv-blk[data-path="${r}"]`) as HTMLElement | null
    return { scrollTop: stream?.scrollTop ?? -1, blockTop: blk?.offsetTop ?? -2 }
  }, rel)
}

// -----------------------------------------------------------------------------------------

// WB-B01 (FR-44, FR-10) — three claims in one gesture chain, and the middle one is the
// only one a naive tree gets right by accident.
//
// The lazy half is asserted NEGATIVELY first: `lib/deep` must not be in the DOM before
// `lib` is opened. A recursive lister renders a tree that looks identical once everything
// is expanded, so only the "absent before the click" beat can tell the two apart — and it
// is also the one that keeps `git check-ignore` off the whole worktree at mount.
//
// The tab count is the claim most easily forgotten: FR-10 makes clicking a file inside
// Files a NON-tab-creating act, so a build that routed the click through the ordinary
// open path would render the same content in a new `file` tab and every content
// assertion would still pass.
test('WB-B01: Browse lists lazily, hides ignored and heavy dirs, and a file click makes no tab', async ({
  page,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
  await browseReady(page, fx.root)

  const tabsBefore = await wbTabs(page).count()

  // the root arrives expanded (FR-47's persisted expansion always contains it), so its
  // immediate children are listed — and nothing below them is
  await expect(row(page, `${fx.root}/lib`)).toBeVisible()
  await expect(row(page, `${fx.root}/lib/deep`)).toHaveCount(0)
  await expect(row(page, fx.paths.deepDir)).toHaveCount(0)
  await expect(row(page, fx.paths.deepFile)).toHaveCount(0)

  await row(page, `${fx.root}/lib`).click()
  await expect(row(page, `${fx.root}/lib/deep`)).toBeVisible({ timeout: 20_000 })
  // …one level at a time: opening `lib` must not have listed its grandchildren either
  await expect(row(page, fx.paths.deepDir)).toHaveCount(0)

  await row(page, `${fx.root}/lib/deep`).click()
  await expect(row(page, fx.paths.deepDir)).toBeVisible({ timeout: 20_000 })
  await row(page, fx.paths.deepDir).click()
  await expect(row(page, fx.paths.deepFile)).toBeVisible({ timeout: 20_000 })

  // Two different mechanisms, which is why both are named: `secrets/` is hidden by
  // `.gitignore` (a `git check-ignore` verdict) and `node_modules/` by fileTree's own
  // HEAVY set. A build that dropped either filter passes the other assertion.
  await expect(row(page, fx.paths.ignoredDir)).toHaveCount(0)
  await expect(row(page, fx.paths.heavyDir)).toHaveCount(0)
  // …and the sibling that proves the listing really happened, so the two zeros above are
  // "filtered out" rather than "nothing was listed at all"
  await expect(row(page, `${fx.root}/docs`)).toBeVisible()

  await row(page, fx.paths.deepFile).click()
  await expect(readingTitle(page)).toHaveText('lib/deep/nested/beacon.ts', { timeout: 25_000 })
  await expect(readingBody(page)).toContainText('beacon_1', { timeout: 25_000 })
  // FR-10 — the whole point: the file is on screen and the strip did not move
  expect(await wbTabs(page).count()).toBe(tabsBefore)
})

// WB-B03 (FR-45, FR-47, §Edge/"a search has no hits") — the two modes are not two skins on
// one query: the name mode lists FILES and the content mode lists LINES, and only the
// second carries a `line` through to the artifact.
//
// The jump is asserted with BOTH halves — line 42 inside the visible band AND line 1
// outside it. Without the negative half the assertion passes on a build that opened the
// file and never scrolled, since line 42 of a 60-line file is on screen in a tall enough
// pane. That is the assertion carrying this case.
//
// It is then asserted a second time through Enter in the search box, which is a different
// handler on a different element — the case text names the click, but the keyboard route to
// the same landing has no case of its own and would otherwise be untested.
test('WB-B03: name search lists the file, a content hit opens it at its line, and empty / truncated results say so', async ({
  page,
  env
}) => {
  test.slow()
  const fx = setupChangeFixture(env.workspaces.a)
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
  await browseReady(page, fx.root)

  await searchToggle(page).click()
  await expect(searchInput(page)).toBeFocused()

  // --- name mode: the file whose NAME matches, wherever it sits in the tree
  await searchInput(page).fill('beacon')
  const nameHit = page.locator(`.wb-panel .ft-result[data-path="${fx.paths.deepFile}"]`)
  await expect(nameHit).toBeVisible({ timeout: 20_000 })
  // the tree itself is gone while a search is active — results REPLACE it, they do not
  // filter it in place
  await expect(section(page, 'tree')).toHaveCount(0)

  // --- content mode: the one line in the whole fixture tree carrying the beacon
  await searchMode(page, 'content').click()
  await searchInput(page).fill(LINE42_MARKER)
  const contentHit = page.locator(
    `.wb-panel .ft-cresult[data-path="${fx.paths.deepFile}"][data-line="42"]`
  )
  await expect(contentHit).toBeVisible({ timeout: 25_000 })
  await contentHit.click()

  await expect(readingTitle(page)).toHaveText('lib/deep/nested/beacon.ts', { timeout: 25_000 })
  await expect.poll(() => sourceLineInView(page, 42), { timeout: 25_000 }).toBe(true)
  expect(await sourceLineInView(page, 1)).toBe(false)

  // --- the same landing through the KEYBOARD. Enter in the search box opens the selected
  // hit and carries its line; it is a different handler on a different element from the row
  // click above, so five-key coverage of the tree body never reaches it.
  //
  // The target is line 800 of a 900-line file, in a DIFFERENT file from the click. Both
  // choices are forced: a different file makes the title change the proof that Enter opened
  // anything at all, and a line that far down cannot be on screen from the top of the file —
  // a nearby line in the file already open reads as visible without anything having
  // scrolled, which is what the first draft of this beat did.
  const bulk3 = fx.paths.bulk[2]
  await searchInput(page).fill('part3_800')
  await expect(
    page.locator(`.wb-panel .ft-cresult[data-path="${bulk3}"][data-line="800"]`)
  ).toBeVisible({ timeout: 25_000 })
  await expect(readingTitle(page)).toHaveText('lib/deep/nested/beacon.ts')
  await searchInput(page).press('Enter')
  await expect(readingTitle(page)).toHaveText('bulk/part-3.ts', { timeout: 25_000 })
  await expect.poll(() => sourceLineInView(page, 800), { timeout: 25_000 }).toBe(true)
  expect(await sourceLineInView(page, 1)).toBe(false)

  // --- no hits (§Edge Cases): a named answer, never an empty list
  await searchInput(page).fill('koloft-e2e-no-such-token-anywhere')
  await expect(page.locator('.wb-panel .bv-nomatch')).toHaveText('No matches', { timeout: 20_000 })

  // --- truncation: the six 900-line bulk files carry ~5400 matching lines, far past the
  // backend's 300 cap, so the notice is produced by a REAL overflow rather than a stub
  await searchInput(page).fill('export const part')
  const truncated = page.locator('.wb-panel .bv-truncated')
  await expect(truncated).toBeVisible({ timeout: 30_000 })
  await expect(truncated).toHaveText('Showing the first 300 — narrow the query.')
  await expect(page.locator('.wb-panel .ft-cresult')).toHaveCount(300)
})

// WB-B04 (FR-46) — the two virtual roots, and A7's four locked constraints. The negative
// halves ARE the case: every one of them is a rule that a "just list what the session
// touched" implementation breaks while looking perfectly fine on screen.
//
//  · `.ts` outside the root is reachable from NO root at all (the allowlist is md / html /
//    image), so its absence under ↗ Outside is the constraint, not an oversight;
//  · a scratchpad file the session also WROTE is an Outside candidate on every count —
//    it is out of root and it is markdown — and must still appear only under ⌗ Scratchpad;
//  · `tasks/` holds subagent transcripts that reach megabytes, and is blacked out under
//    every root — which is TWO assertions, not one, because the rule has two spellings
//    reached through two different roots (see below);
//  · a missing directory hides its WHOLE node, not its contents — an empty ↗ Outside
//    heading left behind would be the bug this last beat catches.
test('WB-B04: ⌗ Scratchpad and ↗ Outside carry A7’s allowlist, de-duplication, tasks blackout and missing-dir rule', async ({
  page,
  env
}) => {
  test.slow()
  const fx = setupChangeFixture(env.workspaces.a)
  const outside = seedOutsideDir(env)
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

  const call = (await waitForCalls(env, 1))[0]
  const scratch = seedScratchpad(env, call.cwd, call.sessionId)

  // Only a file the SESSION wrote can reach ↗ Outside, so the fixture files are written
  // through the session itself. The two that must NOT show up go FIRST on purpose: their
  // absence below is then ordered behind writes that do produce rows, so "not listed"
  // cannot be read as "the write had not landed yet". (The writes are not acknowledged one
  // by one — fake-claude echoes the absolute path it wrote, which wraps in an 80-column pty
  // and would make the acknowledgement itself the flaky part. The rows below are the
  // barrier.)
  const scratchWritten = `${scratch.dir}/from-agent.md`
  // …and one control file in a subdirectory of the session dir, structurally parallel to
  // `tasks/subagent.md`: markdown, out of root, in no other root's territory, so it must
  // reach ↗ Outside. It is what makes the `tasks/` absence attributable to the BLACKOUT
  // rather than to "nothing written beside the session dir reaches Outside at all".
  const controlDir = path.join(path.dirname(scratch.siblingTasksDir), 'control')
  const siblingControl = path.join(controlDir, 'sibling-control.md')
  for (const abs of [
    outside.ts,
    scratch.siblingTasksFile,
    siblingControl,
    outside.md,
    outside.html,
    outside.png,
    scratchWritten
  ]) {
    await runIn(page, centerTerm(page), `/write ${abs}`)
  }

  // The two files that must NOT appear have no row to wait on, so their positive control is
  // on disk: fake-claude writes the file and appends the `Write` tool_use in the same
  // synchronous step, so this body proves the transcript really carries the write and the
  // absences below are a FILTER's verdict rather than a write that never happened.
  await expect
    .poll(() => [outside.ts, scratch.siblingTasksFile].map((p) => readIfPresent(p)), {
      timeout: 30_000
    })
    .toEqual([
      expect.stringContaining('Written mid-turn'),
      expect.stringContaining('Written mid-turn')
    ])

  await browseReady(page, fx.root)

  // both roots are on screen, by their own heads
  await expect(section(page, 'scratchpad')).toBeVisible({ timeout: 30_000 })
  await expect(section(page, 'scratchpad').locator('.ft-scratchpad')).toContainText('Scratchpad')
  await expect(section(page, 'outside')).toBeVisible({ timeout: 30_000 })
  await expect(section(page, 'outside').locator('.ft-external')).toContainText('Outside')

  // ⌗ Scratchpad lists what is on disk, whether or not the transcript recorded it
  for (const p of [scratch.md, scratch.png, scratch.ts, scratchWritten]) {
    await expect(row(page, p, 'scratchpad')).toBeVisible({ timeout: 30_000 })
  }

  // ↗ Outside: md / html / image only — the control file included, which is what makes the
  // `tasks/` absence below mean "blacked out" rather than "out of reach"
  for (const p of [outside.md, outside.html, outside.png, siblingControl]) {
    await expect(row(page, p, 'outside')).toBeVisible({ timeout: 30_000 })
  }
  // … never a `.ts`, even though the session wrote it into the same directory
  await expect(row(page, outside.ts, 'outside')).toHaveCount(0)
  // … and never a scratchpad file, which has a root of its own
  await expect(row(page, scratchWritten, 'outside')).toHaveCount(0)

  // an Outside row OPENS — what the session touched is readable wherever it lives. The
  // body is what fake-claude's `/write` put there (it names the path), not the seed text.
  await row(page, outside.md, 'outside').click({ timeout: 30_000 })
  await expect(readingBody(page)).toContainText(path.basename(outside.md), { timeout: 30_000 })

  // `tasks/` is invisible under EVERY root, and the rule has two spellings that surface
  // through two different roots — so this is two assertions, both unscoped across the
  // whole panel:
  //  · the INSIDE one (`<scratchpad>/tasks`) is what the ⌗ Scratchpad node's own filter
  //    sees, since it filters what `listDir(scratchpadDir)` returned;
  //  · the SIBLING one (`<sessionDir>/tasks`) is where real Claude Code actually puts
  //    subagent transcripts, and it lives outside the scratchpad dir entirely — so it can
  //    only ever surface under ↗ Outside, and only once the session has written it. It is
  //    markdown, i.e. an Outside-ELIGIBLE kind, so if the blackout stopped firing this file
  //    would really appear; a `.ts` would be caught by the allowlist and the assertion
  //    would pass for the wrong reason. Testing only the inside spelling leaves the
  //    megabyte transcripts the rule exists for completely uncovered.
  await expect(page.locator(`.wb-panel .ft-node[data-path="${scratch.tasksDir}"]`)).toHaveCount(0)
  await expect(page.locator(`.wb-panel .ft-node[data-path="${scratch.tasksFile}"]`)).toHaveCount(0)
  await expect(
    page.locator(`.wb-panel .ft-node[data-path="${scratch.siblingTasksDir}"]`)
  ).toHaveCount(0)
  await expect(
    page.locator(`.wb-panel .ft-node[data-path="${scratch.siblingTasksFile}"]`)
  ).toHaveCount(0)

  // The missing-directory branch: the node goes, not just its rows. Both directories
  // backing ↗ Outside are removed — the fixture's own and the control's — because the claim
  // is about the node disappearing once what backs it is gone, and a surviving control row
  // would (correctly) keep the node alive and make this assertion untrue rather than
  // failing for the reason the case is about. It converges rather than flipping: existence
  // is settled by a stat poll per on-screen candidate, so this must be a RETRYING count.
  outside.remove()
  fs.rmSync(controlDir, { recursive: true, force: true })
  await expect(section(page, 'outside')).toHaveCount(0, { timeout: 40_000 })
  await expect(page.locator('.wb-panel .ft-external', { hasText: 'Outside' })).toHaveCount(0)
  // …while the other root is untouched, so this is a targeted disappearance and not the
  // tree having collapsed
  await expect(section(page, 'scratchpad')).toBeVisible()
})

// WB-B05 (FR-47) — the decoration rail. Four marks, each fed by a different pipeline, which
// is exactly why one test carries all four: they share a row renderer and are trivially
// swapped for one another by a refactor.
//
// The forced-visible row is the sharp one. `secrets/` is gitignored, so the LISTING can
// never return it; the row exists only because the session's own write list re-synthesises
// the path. A build that dropped that synthesis loses an agent's `.env` / `dist/` writes
// silently — the tree looks correct, and the file is simply unreachable.
test('WB-B05: a written gitignored file is forced visible, and status / ±N / pulse / dir marks paint', async ({
  page,
  env
}) => {
  test.slow()
  const fx = setupChangeFixture(env.workspaces.a)
  fx.editTracked(fx.paths.changeable[0]) // src/change-1.ts, changed by something else
  fx.modifyMarkdown() //                    docs/guide.md, so `docs` has changes and no writes
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

  const ignoredWrite = `${fx.paths.ignoredDir}/agent-note.txt`
  await runIn(page, centerTerm(page), `/write ${fx.rel(ignoredWrite)}`)
  await expect(centerTerm(page)).toContainText('wrote secrets/agent-note.txt', { timeout: 30_000 })

  await browseReady(page, fx.root)

  // 1. force-revealed: both the synthetic directory and the file under it, marked as such
  const forcedDir = row(page, fx.paths.ignoredDir)
  await expect(forcedDir).toBeVisible({ timeout: 30_000 })
  await expect(forcedDir).toHaveAttribute('data-forced', '1')
  const forcedFile = row(page, ignoredWrite)
  await expect(forcedFile).toBeVisible()
  await expect(forcedFile).toHaveAttribute('data-forced', '1')

  // 2. the status letter and ±N on an ordinary tracked file. The NAME TINT is asserted
  //    alongside the letter because they are two independent channels off the same status:
  //    the letter is a badge element, the tint a class on `.ft-name` (and `git-deleted`
  //    also strikes the name through). A regression that dropped the tint would leave the
  //    badge assertion perfectly green.
  await expandTo(page, fx.root, fx.paths.changeable[0])
  const changed = row(page, fx.paths.changeable[0])
  await expect(changed.locator('.ft-gbadge.git-modified')).toHaveText('M', { timeout: 30_000 })
  await expect(changed.locator('.ft-name')).toHaveClass(/\bgit-modified\b/)
  await expect(changed.locator('.ft-delta .add')).toHaveText('+1')
  await expect(changed.locator('.ft-delta .del')).toHaveText('−1')

  // 3. the directory-level change dot — `docs` holds a changed file and no session write,
  //    which is what distinguishes the plain dot from the ●N written-here badge
  const docsRow = row(page, `${fx.root}/docs`)
  await expect(docsRow).toHaveClass(/\bhas-changes\b/, { timeout: 30_000 })
  await expect(docsRow.locator('.bv-dot')).toBeVisible()

  // 4. the being-written pulse, during the window `/write` holds the turn open. The target
  //    is a row already on screen, so this measures the DECORATION and not a re-listing.
  const pulsing = fx.paths.changeable[1]
  await runIn(page, centerTerm(page), `/write ${fx.rel(pulsing)}`)
  await expect(row(page, pulsing).locator('.ft-pulse')).toBeVisible({ timeout: 10_000 })
  await expect(row(page, pulsing)).toHaveClass(/\blive\b/)

  // …and once that write is recorded, `src` carries the written-here count rather than the
  // plain dot: the two directory marks are one slot, and only one may win
  await expect(centerTerm(page)).toContainText(`wrote ${fx.rel(pulsing)}`, { timeout: 30_000 })
  await expect(row(page, `${fx.root}/src`).locator('.ft-dir-agg')).toContainText('●', {
    timeout: 30_000
  })
})

// WB-B06 (FR-47) — keyboard navigation, bookmarks, persisted expansion and the auto-scroll,
// which is the group of row semantics the retiring tree owned.
//
// The restart is what makes the expansion claim mean anything: an in-memory expansion map
// satisfies every same-run assertion. And the auto-scroll is asserted through the ANCESTOR
// reveal as well as the row's visibility — a file opened from a search hit sits inside
// three collapsed directories, so a build that only called `scrollIntoView` would be
// scrolling to a row that does not exist.
test('WB-B06: arrows expand/collapse/select, a bookmark marks the row, expansion survives a restart, and an opened file is revealed', async ({
  app,
  page,
  env
}) => {
  test.slow()
  const fx = setupChangeFixture(env.workspaces.a)
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
  await browseReady(page, fx.root)

  // The tree body takes the focus when the search row closes — the product's own way of
  // keeping the focus inside the Files tab (FR-45/WB-B02), and therefore a real gesture
  // rather than a synthetic focus() call.
  await searchToggle(page).click()
  await expect(searchInput(page)).toBeFocused()
  await searchToggle(page).click()
  await expect(page.locator('.wb-panel .bv-body')).toBeFocused({ timeout: 10_000 })

  /** ↓ until the keyboard focus lands on `abs`, bounded so a miss fails as a miss. */
  const keyTo = async (abs: string): Promise<void> => {
    for (let i = 0; i < 60; i++) {
      if (
        await row(page, abs)
          .evaluate((el) => el.classList.contains('kbd-focus'))
          .catch(() => false)
      )
        return
      await page.keyboard.press('ArrowDown')
    }
    await expect(row(page, abs)).toHaveClass(/\bkbd-focus\b/)
  }

  await keyTo(`${fx.root}/lib`)
  await page.keyboard.press('ArrowRight')
  await expect(row(page, `${fx.root}/lib`)).toHaveClass(/\bopen\b/)
  await expect(row(page, `${fx.root}/lib/deep`)).toBeVisible({ timeout: 20_000 })

  await keyTo(`${fx.root}/lib/deep`)
  await page.keyboard.press('ArrowRight')
  await expect(row(page, fx.paths.deepDir)).toBeVisible({ timeout: 20_000 })
  // ← folds the same node back up, and its children leave with it
  await page.keyboard.press('ArrowLeft')
  await expect(row(page, `${fx.root}/lib/deep`)).not.toHaveClass(/\bopen\b/)
  await expect(row(page, fx.paths.deepDir)).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(row(page, fx.paths.deepDir)).toBeVisible({ timeout: 20_000 })

  await keyTo(fx.paths.deepDir)
  await page.keyboard.press('ArrowRight')
  await keyTo(fx.paths.deepFile)
  await page.keyboard.press('Enter')
  await expect(readingTitle(page)).toHaveText('lib/deep/nested/beacon.ts', { timeout: 25_000 })

  // bookmarks: added from the row menu, visible as the row's own star AND as a section
  await row(page, fx.paths.deepFile).click({ button: 'right' })
  await ctxMenu(page).getByText('Add bookmark', { exact: true }).click()
  await expect(row(page, fx.paths.deepFile).locator('.bv-bm')).toBeVisible()
  await expect(row(page, fx.paths.deepFile, 'bookmarks')).toBeVisible()

  // --- restart: the expansion is a per-workspace localStorage convenience, so it comes
  // back for a brand-new session in the same worktree, with no clicks at all
  const restarted = await relaunch(app, env)
  await startSessionIn(restarted.page, 'ws-a')
  await expect(workbenchPanel(restarted.page)).toBeVisible({ timeout: 25_000 })
  await browseReady(restarted.page, fx.root)
  await expect(row(restarted.page, fx.paths.deepDir)).toBeVisible({ timeout: 30_000 })
  await expect(row(restarted.page, fx.paths.deepFile)).toBeVisible()
  await expect(row(restarted.page, fx.paths.deepFile, 'bookmarks')).toBeVisible()

  // --- auto-scroll: open a DEEP file from somewhere that is not the tree (a name-search
  // hit), and the tree reveals its ancestors and scrolls the row into view
  await expandTo(restarted.page, fx.root, fx.paths.deepFile)
  await row(restarted.page, fx.paths.deepDir).click() // fold it all away again
  await expect(row(restarted.page, fx.paths.deepFile)).toHaveCount(0)

  await searchToggle(restarted.page).click()
  await searchInput(restarted.page).fill('beacon')
  await restarted.page
    .locator(`.wb-panel .ft-result[data-path="${fx.paths.deepFile}"]`)
    .click({ timeout: 25_000 })
  await expect(readingTitle(restarted.page)).toHaveText('lib/deep/nested/beacon.ts', {
    timeout: 25_000
  })
  await searchToggle(restarted.page).click() // back to the tree

  const revealed = row(restarted.page, fx.paths.deepFile)
  await expect(revealed).toBeVisible({ timeout: 25_000 })
  await expect(revealed).toHaveClass(/\bactive\b/)
  await expect
    .poll(() => rowInBody(restarted.page, fx.paths.deepFile), { timeout: 15_000 })
    .toBe(true)

  await restarted.app.close().catch(() => {})
})

// WB-B07 (FR-49, FR-14, FR-57) — Recents, all three of its rules at once.
//
// The third one is the barrier that makes the case worth writing: an AGENT open lands the
// file in the reading area exactly as a user open does, so every other observable agrees.
// Recents is the only place the two are told apart, and a build that pushed from the store
// instead of from the user path would look completely correct until someone noticed their
// history filling with files they never opened.
test('WB-B07: Recents caps at 12, moves a reopened file to the front, and never records an agent open', async ({
  page,
  env
}) => {
  test.slow()
  test.setTimeout(240_000)
  const fx = setupChangeFixture(env.workspaces.a)
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
  await browseReady(page, fx.root)

  // thirteen distinct files, all under src/, opened the way a user opens them
  const opened = [
    ...fx.paths.changeable, // change-1 … change-7
    fx.paths.deletable,
    fx.paths.renameSource,
    fx.paths.conflictFile,
    fx.paths.agentTs,
    fx.paths.agentTsB,
    `${fx.root}/src/app.ts`
  ]
  expect(opened).toHaveLength(13)

  await expandTo(page, fx.root, opened[0])
  for (const abs of opened) {
    await row(page, abs).click()
    await expect(readingTitle(page)).toHaveText(`src/${abs.slice(abs.lastIndexOf('/') + 1)}`, {
      timeout: 25_000
    })
  }

  const recents = fileRows(page, 'recents')
  await expect(recents).toHaveCount(12, { timeout: 20_000 })
  // the oldest was pushed out, not merely scrolled out of sight
  await expect(row(page, opened[0], 'recents')).toHaveCount(0)
  await expect(recents.first()).toHaveAttribute('data-path', opened[12])

  // reopening one already in the list MOVES it, never duplicates it
  await row(page, opened[1]).click()
  await expect(readingTitle(page)).toHaveText('src/change-2.ts', { timeout: 25_000 })
  await expect(recents.first()).toHaveAttribute('data-path', opened[1])
  await expect(recents).toHaveCount(12)
  await expect(row(page, opened[1], 'recents')).toHaveCount(1)

  // an agent open: same landing, no entry
  await runIn(page, centerTerm(page), '/open README.koloft.md')
  await expect(centerTerm(page)).toContainText('opened README.koloft.md', { timeout: 30_000 })
  // the positive control — it really did reach the reading area, so the silence below is
  // "not recorded" rather than "never happened"
  await expect(readingTitle(page)).toHaveText('README.koloft.md', { timeout: 25_000 })
  await expect(recents).toHaveCount(12)
  await expect(row(page, `${fx.root}/README.koloft.md`, 'recents')).toHaveCount(0)
  await expect(recents.first()).toHaveAttribute('data-path', opened[1])
})

// WB-B08 (FR-48) — one context menu, two surfaces. Asserting it from Changes as well as
// Browse is the point: the two views build their rows independently and the menu is the
// shell's, so a drift shows up here and nowhere else.
//
// The injection is asserted by the terminal's CURSOR COLUMN rather than by its text,
// because the two failure modes this clause exists to catch are both invisible in text:
// a missing trailing space (the user's next keystroke fuses onto the path) and an
// auto-submit (which would return the cursor to the prompt). One number falsifies both.
test('WB-B08: the row menu is the same from Browse and Changes, and @ injection writes a trailing space without submitting', async ({
  page,
  env
}) => {
  test.slow()
  const fx = setupChangeFixture(env.workspaces.a)
  fx.modifyTracked(3)
  fx.modifyHtml()
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
  await browseReady(page, fx.root)

  // --- Browse, on an .html row: the one conditional item is present
  //
  // `Edit` leads and `Open with default app` follows `Reveal in Finder` since the in-panel
  // editor landed (B-03 and A-06). `Edit` is first rather than merely present: reading a
  // file costs two clicks and B-03 is what makes changing one cost two as well. `New File…`
  // is deliberately absent — it belongs to a FOLDER row, and both menus here are files'.
  await expandTo(page, fx.root, fx.paths.html)
  await row(page, fx.paths.html).click({ button: 'right' })
  await expect(ctxMenu(page)).toBeVisible()
  expect(await ctxItems(page).allTextContents()).toEqual([
    'Edit',
    'Open',
    'View source',
    'Reveal in Finder',
    'Open with default app',
    'Copy path',
    'Copy relative path',
    'Add bookmark',
    '@ Inject into terminal'
  ])
  await page.keyboard.press('Escape')
  await expect(ctxMenu(page)).toHaveCount(0)

  // --- Changes, on an ordinary .ts row: the same menu minus "View source"
  await halfBtn(page, 'Changes').click()
  const changesRow = page.locator(
    `.wb-panel .cv-row[data-path="${fx.rel(fx.paths.changeable[0])}"]`
  )
  await expect(changesRow).toBeVisible({ timeout: 30_000 })
  await changesRow.click({ button: 'right' })
  await expect(ctxMenu(page)).toBeVisible()
  expect(await ctxItems(page).allTextContents()).toEqual([
    'Edit',
    'Open',
    'Reveal in Finder',
    'Open with default app',
    'Copy path',
    'Copy relative path',
    'Add bookmark',
    '@ Inject into terminal'
  ])

  // --- the injection itself
  const rel = fx.rel(fx.paths.changeable[0])
  const before = await ttyCursorX(page)
  expect(before).toBeGreaterThanOrEqual(0)
  await ctxMenu(page).getByText('@ Inject into terminal', { exact: true }).click()
  await expect(centerTerm(page)).toContainText(`@${rel}`, { timeout: 20_000 })
  // '@' + the relative path + ONE trailing space, and the line was never submitted —
  // a submit would have run fake-claude's handler and parked the cursor back at the prompt
  await expect.poll(() => ttyCursorX(page), { timeout: 20_000 }).toBe(before + rel.length + 2)
  await expect(centerTerm(page)).not.toContainText('handled:')
})

// WB-B09 (FR-31) — Browse's reading area and a split-off `file` tab are the same artifact
// under the same header. They are two different components (the reading area's header is
// FilesView's, the tab's is the panel's), so "the control set is identical" is a claim that
// has to be measured rather than assumed: the drift this catches is a control quietly
// gained or lost on one of the two paths.
test('WB-B09: Browse’s reading area and a split-off file tab carry the same FR-31 header', async ({
  page,
  env
}) => {
  test.slow()
  const fx = setupChangeFixture(env.workspaces.a)
  fx.modifyMarkdown()
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
  await browseReady(page, fx.root)

  /**
   * Every control a header offers, in row order: the view segments, then the icon buttons
   * by their accessible names.
   *
   * The panel's own ⤢ / ⤡ is filtered out deliberately — FR-05 puts it in EVERY kind bar,
   * including the ones with no artifact at all, so it belongs to the panel and not to
   * FR-31's header. Leaving it in would make the two sets differ by a control that is
   * supposed to differ.
   */
  const controlsOf = async (scope: Locator): Promise<string[]> => {
    const views = await scope.locator('.seg[aria-label="View mode"] button').allTextContents()
    const icons = await scope
      .locator('.icobtn[aria-label]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
    return [...views.map((v) => v.trim()), ...icons.filter((l) => !/^(Full width|Restore)/.test(l))]
  }

  await expandTo(page, fx.root, fx.paths.markdown)
  await row(page, fx.paths.markdown).click()

  const reading = page.locator('.wb-panel .fv-artifact-hd')
  await expect(reading.locator('.wb-title')).toHaveText('docs/guide.md', { timeout: 25_000 })
  await expect(reading.locator('.ft-gbadge.git-modified')).toHaveText('M')
  await expect(reading.locator('.ft-delta')).toBeVisible()
  await expect(reading.locator('.seg[aria-label="View mode"] button')).toHaveCount(3, {
    timeout: 25_000
  })
  const readingControls = await controlsOf(reading)

  // …the same file, reached the other way: Changes' ↗ New tab
  await halfBtn(page, 'Changes').click()
  const block = page.locator(`.wb-panel .cv-blk[data-path="${fx.rel(fx.paths.markdown)}"]`)
  await expect(block).toBeVisible({ timeout: 30_000 })
  await block.locator('.cv-split').click()
  await expect.poll(() => activeKind(page), { timeout: 25_000 }).toBe('file')

  // the panel's kind bar is a DIRECT child of the panel root; the reading area's header is
  // also a `.wb-bar` and stays mounted behind the active tab, so the scoping is required
  const kindBar = page.locator('.wb-panel > .wb-bar')
  await expect(kindBar.locator('.wb-title')).toHaveText('docs/guide.md', { timeout: 25_000 })
  await expect(kindBar.locator('.ft-gbadge.git-modified')).toHaveText('M')
  await expect(kindBar.locator('.ft-delta')).toBeVisible()
  await expect(kindBar.locator('.seg[aria-label="View mode"] button')).toHaveCount(3, {
    timeout: 25_000
  })

  expect(await controlsOf(kindBar)).toEqual(readingControls)
  // ✎ sits between ↻ and ≡ on BOTH bars since the in-panel editor landed: B-01 put it on
  // the `file` tab's kind bar and B-02 put the promoting twin on the reading area's, and
  // this line is what keeps the two from drifting apart.
  expect(readingControls).toEqual(['Rendered', 'Diff', 'Source', 'Reload', 'Edit', 'Outline'])
})

/**
 * FR-31 item 3 — squeeze the reading area's header and the file NAME is the
 * last thing to give way, and never its end.
 *
 * The bug this pins: the name used to keep its full width no matter how narrow the bar
 * got, so it simply ran on under the badges and the view segments beside it. Nothing said
 * it had been cut — `notes.md` read as a file called `notes`.
 *
 * Every field is measured, because each one alone passes on a build with the bug: the dir
 * was already gone, the name was already whole, and "the tail is painted inside the name's
 * box" is true of text that overflows that box too. Only `clearOfControls` catches the
 * running-on itself. The tail is found with a Range over the last characters, which is the
 * only way to ask where the extension actually landed — the DOM text is the whole name
 * either way, ellipsis or not.
 */
test('FR-31: the reading area’s header drops the directory before the file name, tail first', async ({
  page,
  env
}) => {
  test.slow()
  const fx = setupChangeFixture(env.workspaces.a)
  const long = fx.addUntracked('docs/release-notes-september.md')
  await startSessionIn(page, 'ws-a')
  await openInBrowse(page, long)

  const title = page.locator(WORKBENCH.readingTitle)
  await expect(title).toContainText('release-notes-september.md', { timeout: 25_000 })

  // the gutter left of the panel, dragged as far right as it goes: the panel's own floor
  // stops it, so this is the narrowest a user can make the header
  const gutter = page.locator('.center-row .gutter-v').last()
  const box = (await gutter.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 2000, box.y + box.height / 2)
  await page.mouse.up()

  const shape = await page.evaluate((sel) => {
    const hd = document.querySelector(sel)!.parentElement!
    const nm = hd.querySelector('.nm') as HTMLElement
    const dir = hd.querySelector('.dir') as HTMLElement
    const text = [...nm.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text
    const range = document.createRange()
    range.setStart(text, text.data.length - '.md'.length)
    range.setEnd(text, text.data.length)
    const tail = range.getBoundingClientRect()
    const nmBox = nm.getBoundingClientRect()
    return {
      dirIsGone: dir.getBoundingClientRect().width === 0,
      nameIsCut: nm.scrollWidth > nm.clientWidth,
      // the extension is painted inside the name's own box — not spilling out of it, where
      // the controls beside the title would cover it
      tailInside: tail.left >= nmBox.left - 1 && tail.right <= nmBox.right + 1,
      // …and the box itself stays clear of the control next to the title
      clearOfControls: nmBox.right <= hd.querySelector('.ft-gbadge')!.getBoundingClientRect().left
    }
  }, WORKBENCH.readingTitle)
  expect(shape).toEqual({
    dirIsGone: true,
    nameIsCut: true,
    tailInside: true,
    clearOfControls: true
  })
})

// WB-P06 (FR-47, FR-49, §Data Model) — both conveniences are keyed by WORKSPACE ROOT, and
// the case is really about the key: a single global slot restores workspace A's expansion
// and Recents into workspace B and passes every single-workspace assertion on the way.
//
// So B's cleanliness is asserted positively — no Recents section at all, and exactly ONE
// open directory (its own root) — rather than as "not A's paths", which a build with an
// empty-but-shared slot would also satisfy.
test('WB-P06: Browse expansion and Recents come back per workspace, with no cross-talk', async ({
  app,
  page,
  env
}) => {
  test.slow()
  const fx = setupChangeFixture(env.workspaces.a)
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
  await browseReady(page, fx.root)

  await expandTo(page, fx.root, fx.paths.deepFile)
  await row(page, fx.paths.deepFile).click()
  await expect(readingTitle(page)).toHaveText('lib/deep/nested/beacon.ts', { timeout: 25_000 })
  await row(page, fx.paths.readme).click()
  await expect(readingTitle(page)).toHaveText('README.koloft.md', { timeout: 25_000 })
  await expect(fileRows(page, 'recents')).toHaveCount(2)

  const restarted = await relaunch(app, env)

  // --- workspace A: both conveniences restored, with no clicks
  await startSessionIn(restarted.page, 'ws-a')
  await expect(workbenchPanel(restarted.page)).toBeVisible({ timeout: 25_000 })
  await browseReady(restarted.page, fx.root)
  await expect(row(restarted.page, fx.paths.deepFile)).toBeVisible({ timeout: 30_000 })
  const restoredRecents = fileRows(restarted.page, 'recents')
  await expect(restoredRecents).toHaveCount(2, { timeout: 20_000 })
  await expect(restoredRecents.first()).toHaveAttribute('data-path', fx.paths.readme)
  await expect(restoredRecents.nth(1)).toHaveAttribute('data-path', fx.paths.deepFile)

  // --- workspace B: never touched, and it must not inherit A's slot
  await startSessionIn(restarted.page, 'ws-b')
  await expect(workbenchPanel(restarted.page)).toBeVisible({ timeout: 25_000 })
  await showBrowse(restarted.page)
  const rootB = env.workspaces.b
  await expect(row(restarted.page, rootB)).toBeVisible({ timeout: 30_000 })
  await expect(section(restarted.page, 'recents')).toHaveCount(0)
  await expect(
    restarted.page.locator('.wb-panel .bv-sec[data-section="tree"] .ft-node.ft-dir.open')
  ).toHaveCount(1)
  await expect(
    restarted.page.locator(`.wb-panel .ft-node[data-path="${fx.paths.deepFile}"]`)
  ).toHaveCount(0)

  await restarted.app.close().catch(() => {})
})

// WB-R09 (FR-11, FR-10) — in BROWSE, html is the ONE exception to "a click inside Files
// makes no tab": a page has no in-panel rendered form, so the row opens a web tab. The
// value is in covering both spellings plus the negative: the `.ts` click that must leave
// the strip exactly as it found it.
//
// The Changes leg is the OTHER half of the rule (since): there a row click is
// always the anchor scroll, html included — the reader came for the diff, and the page is
// one click away on the block's `↗ New tab` (WB-R13 drives that route). Falsifiable in both
// directions: a build that still routed the row to the web tab would move the strip, and
// one that dropped the click would leave the row inactive.
test('WB-R09: .html and .htm open a web tab from Browse, never from a Changes row; every other file opens none', async ({
  app,
  page,
  env
}) => {
  test.slow()
  const fx = setupChangeFixture(env.workspaces.a)
  fx.modifyHtml()
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
  await browseReady(page, fx.root)

  await expandTo(page, fx.root, fx.paths.html)
  await expect(openTabs(page)).toHaveCount(0)

  // 1. Browse, `.html`
  await row(page, fx.paths.html).click()
  await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
  await expect.poll(() => activeKind(page), { timeout: 25_000 }).toBe('web')
  await expect(wbActiveTab(page)).toHaveAttribute('title', new RegExp('report\\.html$'))
  // "as a page, never as source" — the guest really loaded and rendered it, and the
  // reading area was not used. The second half is what a build that merely opened the
  // markup in the reading area under a `web`-looking tab would fail.
  const htmlGuest = await guestByUrl(app, /report\.html$/, { timeout: 30_000 })
  // the heading carries `modifyHtml`'s edit marker, hence the prefix match
  await expect(htmlGuest.locator('h1')).toHaveText(/^koloft-e2e-report-html/, { timeout: 20_000 })
  await expect(readingTitle(page)).toHaveCount(0)

  // 2. Browse, `.htm` — the second spelling routes the same way
  await showBrowse(page)
  await row(page, fx.paths.htm).click()
  await expect(openTabs(page)).toHaveCount(2, { timeout: 30_000 })
  await expect.poll(() => activeKind(page), { timeout: 25_000 }).toBe('web')
  await expect(wbActiveTab(page)).toHaveAttribute('title', new RegExp('report\\.htm$'))
  const htmGuest = await guestByUrl(app, /report\.htm$/, { timeout: 30_000 })
  await expect(htmGuest.locator('h1')).toHaveText('koloft-e2e-report-htm', { timeout: 20_000 })
  await expect(readingTitle(page)).toHaveCount(0)

  // 3. a file that is not a page: the strip does not move and the reading area takes it
  await showBrowse(page)
  await expandTo(page, fx.root, fx.paths.changeable[0])
  await row(page, fx.paths.changeable[0]).click()
  await expect(readingTitle(page)).toHaveText('src/change-1.ts', { timeout: 25_000 })
  await expect(openTabs(page)).toHaveCount(2)
  expect(await activeKind(page)).toBe('files')

  // 4. Changes' row for the same `.html`: the click is spent on the anchor — the row goes
  //    active and the strip does not move (no new tab, and the existing web tab is NOT
  //    brought forward either). `.active` is the sharper oracle here: the old routing set
  //    it on no row at all, so a build that still opened the web tab fails on both counts.
  await halfBtn(page, 'Changes').click()
  const changesRow = page.locator(`.wb-panel .cv-row[data-path="${fx.rel(fx.paths.html)}"]`)
  await expect(changesRow).toBeVisible({ timeout: 30_000 })
  await changesRow.click()
  await expect(changesRow).toHaveClass(/\bactive\b/, { timeout: 20_000 })
  expect(await activeKind(page)).toBe('files')
  await expect(openTabs(page)).toHaveCount(2)
})

// WB-R13 (FR-56) — "← Back to source" out of a Files-sourced web tab owes TWO things, and
// the second is the one a plain `activate()` misses: the pinned tab holds a whole change
// set, so landing on it is only half an answer.
//
// The stream is parked on a different file first, and the assertion is that the html's
// block ends up at the top of the stream. Asserting only "the pinned tab is active" would
// pass on a build that never scrolled — which is precisely the state the reader is left in
// with a long change set and no idea where the page they were reading came from.
//
// The parked offset is read AFTER the entry click, not before it: Playwright scrolls an
// element into view before clicking it, so a measurement taken earlier is not the offset
// the backlink actually starts from — and the "it moved" guard would be comparing against
// a state that no longer existed.
//
// `.cv-row.active` is asserted too, but it is NOT an independent second signal: `current`
// is set by the same anchor effect that does the scrolling (the web tab here is opened from
// the block's ↗, which touches neither), so the two go true and false together — the effect bails before `setCurrent` when the
// block is not in the rendered set, taking both with it. So do not read a green `.active`
// as corroboration of the offset, and do not add a filter to this test expecting the
// scroll assertion to keep standing on its own. The offset is the one carrying the case.
test('WB-R13: the files backlink activates the pinned tab and scrolls the stream to that file', async ({
  page,
  env
}) => {
  test.slow()
  const fx = setupChangeFixture(env.workspaces.a)
  fx.modifyTracked(7)
  fx.modifyMarkdown()
  fx.modifyHtml()
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })

  // Changes is the default half; park the stream on a file far down the list
  const htmlRel = fx.rel(fx.paths.html)
  const parkRel = fx.rel(fx.paths.changeable[6])
  await expect(page.locator(`.wb-panel .cv-row[data-path="${parkRel}"]`)).toBeVisible({
    timeout: 40_000
  })
  await page.locator(`.wb-panel .cv-row[data-path="${parkRel}"]`).click()
  await expect(page.locator(`.wb-panel .cv-row[data-path="${parkRel}"]`)).toHaveClass(/\bactive\b/)
  await expect.poll(async () => (await streamAt(page, parkRel)).scrollTop).toBeGreaterThan(0)

  // the html block's rendered entry: FR-31 gives the stream ↗ New tab, and FR-11 turns it
  // into a page rather than a `file` tab (`split()` short-circuits to `onOpenWeb` before
  // `onSplit`, so this route can never mint one either)
  await page.locator(`.wb-panel .cv-blk[data-path="${htmlRel}"] .cv-split`).click()
  await expect.poll(() => activeKind(page), { timeout: 30_000 }).toBe('web')

  // the offset the backlink starts from — the files body stays mounted behind the web tab
  // (hidden with `visibility`, so its boxes survive), which is what makes this readable
  const parked = await streamAt(page, htmlRel)
  expect(parked.scrollTop).not.toBe(parked.blockTop)

  const backlink = page.locator('.wb-panel .wb-backlink button')
  await expect(backlink).toBeVisible({ timeout: 20_000 })
  await backlink.click()

  await expect(page.locator(WORKBENCH.tabFiles)).toHaveClass(/\bon\b/, { timeout: 20_000 })
  await expect(page.locator('.wb-panel .fv')).toHaveAttribute('data-view', 'changes')
  await expect(page.locator(`.wb-panel .cv-row[data-path="${htmlRel}"]`)).toHaveClass(
    /\bactive\b/,
    {
      timeout: 20_000
    }
  )
  await expect
    .poll(
      async () => {
        const at = await streamAt(page, htmlRel)
        return Math.abs(at.scrollTop - at.blockTop)
      },
      { timeout: 20_000 }
    )
    .toBeLessThanOrEqual(2)
})
