import fs from 'fs'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import {
  centerTerm,
  clickAppMenuItem,
  runIn,
  setNextSessionTitle,
  startSessionIn,
  waitBooted
} from './helpers/p1'
import { setupChangeFixture, seedBrowseTree } from './helpers/filesFixture'
import {
  WORKBENCH,
  WORKBENCH_GIT,
  countGitSpawns,
  installGitSpawnLog,
  isAggregateDiff,
  layoutState,
  openFileTab,
  openInBrowse,
  seedWorkbenchDefault,
  showBrowse,
  waitGitQuiet,
  wbTabs,
  workbenchIcon,
  workbenchPanel
} from './helpers/workbench'

/**
 * Workbench · the `files` tab's CHANGES half (WB-C01…WB-C17, plus WB-R08
 * and WB-K08).
 *
 * Changes is one continuous diff stream beside a file list, and almost every case here is
 * about a property that a screenshot cannot tell apart from its own failure:
 *
 *  - "a stream, not a page swap" looks identical to a page swap the moment you are looking
 *    at the file you clicked. WB-C01 therefore stamps an expando on a block's DOM node and
 *    reads it back after scrolling away and back — a node that was unmounted and rebuilt
 *    loses it, while `toBeVisible()` on the rebuilt one passes just as happily.
 *  - "in place, without a jump" (WB-C09) and "the badge ignores the filter" (WB-C10) are
 *    both NUMBERS that a correct build leaves alone. They can only be caught by capturing
 *    the number first and comparing, never by waiting a beat and looking.
 *  - "the baseline is resolved once" (WB-C17) and "a collapsed panel spawns no git"
 *    (WB-K08) have no DOM at all. They read the PATH shim's argv log
 *    (helpers/gitSpawnLog.ts) — production code, observed with no production branch.
 *
 * WB-C05 (base/filters stay with their tab across a session switch) is NOT here: it belongs to the shell that
 * owns those controls and is carried by `workbench-files-shell.spec.ts`.
 *
 * Three of these were red on real product defects before they were green — WB-C16's lazy
 * highlight (three separate fixes) and WB-R08's two. Each says at its own comment what its
 * assertion caught; none of them is a redundant restatement of the one above it.
 *
 * Two structural facts that shape every test below:
 *  - Changes is the DEFAULT half (`useFilesController` starts on `view: 'changes'`), but
 *    any USER-sourced file open switches the pinned tab to Browse (FR-57). A case that
 *    opens a file and then wants Changes back has to ask for it — `showChanges` does.
 *  - `.cv-stream` is both the scroller and the offset parent, so a block's anchor position
 *    is `stream.scrollTop === block.offsetTop`. Every scroll assertion here reads those two
 *    numbers rather than a bounding box, which stays correct when the panel is resized.
 */

// ---- the surface -------------------------------------------------------------------------

/** The Changes half's own DOM, as `ChangesView.tsx` renders it. Rooted at the panel so a
 *  retired sidebar tree's leftovers (same `.ft-node` skin) can never answer instead. */
const CV = {
  /** the left file list, and one of its rows (`data-path` = repo-relative) */
  row: '.wb-panel .cv-row',
  /** the right column: the scroller AND the offset parent for every block */
  stream: '.wb-panel .cv-stream',
  /** one file's block in the stream (`data-path` / `data-kind` / `data-status`) */
  block: '.wb-panel .cv-blk',
  /** FR-31's reduced header — [ Diff | Source | ↗ New tab ], no Rendered segment */
  blockSeg: '.seg[aria-label="Block view"]',
  /** FR-38's ⤢, riding the first hunk header */
  expand: '.cv-exp',
  /** one hunk's `@@` row — the cheapest count for "did the context widen" */
  hunk: '.cv-hunk',
  /** a rendered diff line, and the token span that only a HIGHLIGHTED one has (NFR-01) */
  diffRow: '.idiff-row',
  token: '.idiff-code > span',
  /** FR-41's one-line summary for binary / deleted / conflict / renamed */
  special: '.cv-special',
  /** the list's summary row: the listed set's file count and its totalled ±N */
  total: '.wb-panel .cv-total',
  /** §Edge's banners: truncation and the git failure */
  banner: '.cv-banner',
  /** the empty / not-a-repo state */
  empty: '.wb-panel .cv-empty'
} as const

/** FR-50's count, on the pinned tab and nowhere else. */
const badge = (page: Page): Locator => page.locator('.wb-tab.pinned .cnt')
/** FR-58's ↻, in the Files kind bar (Changes has no reading area, so there is only one). */
const reloadBtn = (page: Page): Locator => page.locator('.wb-bar .icobtn[aria-label="Reload"]')
const baseBtn = (page: Page): Locator =>
  page.locator('.wb-bar .seg button', { hasText: /^(base|vs HEAD) ▾$/ })
const filterBtn = (page: Page): Locator =>
  page.locator('.wb-bar .seg button', { hasText: 'Filter' })
const filesMenu = (page: Page): Locator => page.locator('.wb-bar .fv-menu')

const rows = (page: Page): Locator => page.locator(CV.row)
const blocks = (page: Page): Locator => page.locator(CV.block)
const rowOf = (page: Page, rel: string): Locator => page.locator(`${CV.row}[data-path="${rel}"]`)
const blockOf = (page: Page, rel: string): Locator =>
  page.locator(`${CV.block}[data-path="${rel}"]`)
const stream = (page: Page): Locator => page.locator(CV.stream)

/** Every left-list row's `data-path`, in strip order — the oracle for both the filters
 *  (WB-C06/C10) and the baseline switch (WB-C04). */
async function shownPaths(page: Page): Promise<string[]> {
  return (await rows(page).evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).dataset.path ?? '')
  )) as string[]
}

/**
 * Put the Changes half on screen. The mirror of helpers/workbench.ts's `showBrowse`, and
 * needed for the same reason: a `web` tab on top replaces the Files kind bar entirely, and
 * a user file open (FR-57) has already switched the pinned tab to Browse.
 */
async function showChanges(page: Page): Promise<void> {
  const panel = workbenchPanel(page)
  if (!(await panel.isVisible())) {
    await workbenchIcon(page).click()
    await expect(panel).toBeVisible({ timeout: 20_000 })
  }
  const pinned = page.locator(WORKBENCH.tabFiles)
  if (!(await pinned.getAttribute('class'))?.split(/\s+/).includes('on')) await pinned.click()
  const changes = page
    .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
    .filter({ hasText: 'Changes' })
  await expect(changes).toBeVisible({ timeout: 20_000 })
  if ((await changes.getAttribute('aria-pressed')) !== 'true') await changes.click()
  await expect(page.locator(`${WORKBENCH.panel} .fv`)).toHaveAttribute('data-view', 'changes', {
    timeout: 20_000
  })
}

/**
 * The stream has settled: `n` files listed, every ordinary file showing its rows, and no
 * block still waiting for a diff.
 *
 * Blocks appear from the STATUS map, which lands well before the aggregate diff does, so a
 * spec that only counted rows would read diff content that has not arrived and mistake
 * "not yet" for "none". Two barriers rather than one, because they fail differently:
 *
 *  · POSITIVE — every block carries `data-ready="1"`, which `ChangeBlock` stamps in the
 *    same commit that renders its rows (or its FR-41 summary row, or the Source view — all
 *    three are a block at its own final height). This waits for content to actually exist,
 *    which no absence-assertion can do: an absence is satisfied the instant the DOM is
 *    empty. The ONE shape that never goes ready is a block the truncated aggregate never
 *    reached, which is WB-C11's alone and does not come through here.
 *  · NEGATIVE — neither transient note is on screen. BOTH have to be barred, which is not
 *    obvious: a block waiting on its diff says "Loading…" only while `load.done` is false,
 *    and the stream's first fetch completes against a still-empty status map, so the
 *    realistic in-flight text is "No diff available." — the SETTLED wording. (Measured
 *    while diagnosing WB-C16; it is the same ordering that defeated the
 *    lazy-highlight gate three times.) Neither string is a legitimate terminal state for
 *    any fixture in this file.
 */
async function waitStream(page: Page, n: number, timeout = 30_000): Promise<void> {
  await expect(rows(page)).toHaveCount(n, { timeout })
  await expect(page.locator(`${CV.block}:not([data-ready="1"])`)).toHaveCount(0, { timeout })
  await expect(
    page.locator('.wb-panel .cv-note', { hasText: /^(Loading…|No diff available\.)$/ })
  ).toHaveCount(0, { timeout })
}

/** Which half of the pinned tab is on screen — `changes` | `browse` | null when the pinned
 *  tab is not the active one at all. */
async function activeView(page: Page): Promise<string | null> {
  const fv = page.locator(`${WORKBENCH.panel} .fv`)
  return (await fv.count()) === 0 ? null : fv.first().getAttribute('data-view')
}

/** `.cv-stream`'s scroll offset. */
const scrollTop = (page: Page): Promise<number> => stream(page).evaluate((el) => el.scrollTop)

/** Where a block sits in the stream's own coordinates (`.cv-stream` is `position:relative`,
 *  so `offsetTop` IS the anchor the left list scrolls to). */
function blockTop(page: Page, rel: string): Promise<number> {
  return blockOf(page, rel).evaluate((el) => (el as HTMLElement).offsetTop)
}

/**
 * Pick one filter chip and close the menu again, so the stream underneath is readable.
 *
 * The GROUP is part of the address on purpose: `all` is a chip in all three groups, so a
 * key-only locator is ambiguous — and silently picking the wrong `all` would look like a
 * filter that failed to clear.
 */
async function pickChip(
  page: Page,
  group: 'Status' | 'Ownership' | 'Type',
  chip: string
): Promise<void> {
  const target = page.locator(
    `.fv-filters .fv-fgroup[aria-label="${group}"] .ft-chip[data-chip="${chip}"]`
  )
  if ((await filesMenu(page).count()) === 0) await filterBtn(page).click()
  await expect(filesMenu(page)).toBeVisible()
  await target.click()
  await expect(target).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(filesMenu(page)).toHaveCount(0)
}

/** Start a session in ws-a with the panel on Changes — the opening move of nearly every
 *  case here. The fixture is built BEFORE the session so the first refresh already sees it. */
async function openChanges(page: Page, ws = 'ws-a'): Promise<void> {
  await startSessionIn(page, ws)
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
  await showChanges(page)
}

/** Relaunch the fixture app with the git-spawn PATH shim installed (WB-C17, WB-K08). It is
 *  a launch-time seam, so the fixture's already-running app has to be replaced. */
async function relaunchWithGitLog(
  app: ElectronApplication,
  env: E2EEnv
): Promise<{ app: ElectronApplication; page: Page }> {
  await app.close().catch(() => {})
  installGitSpawnLog(env)
  const next = await launchApp(env)
  const page = await next.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app: next, page }
}

// ---- WB-C01 ------------------------------------------------------------------------------

// WB-C01 (FR-38, FR-10) — Changes is ONE stream, not a per-file page.
//
// The assertion that carries the case is the expando probe. Everything else here
// (`toBeVisible`, a row count, even "the third diff is on screen after scrolling up")
// passes just as well against a build that unmounts every other file and rebuilds the one
// you scroll back to — which is precisely the implementation FR-38 rules out, because it
// loses per-block state (⤢, the Diff/Source choice) and re-parses on every scroll. A DOM
// node that survived carries the property; a rebuilt one cannot.
test('WB-C01: clicking a row scrolls the stream to its anchor and leaves every other block mounted', async ({
  page,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)
  fx.modifyTracked(5)
  await openChanges(page)
  await waitStream(page, 5)

  const tabsBefore = await wbTabs(page).count()
  expect(await shownPaths(page)).toEqual([
    'src/change-1.ts',
    'src/change-2.ts',
    'src/change-3.ts',
    'src/change-4.ts',
    'src/change-5.ts'
  ])

  // stamp the THIRD block's node, before anything scrolls
  await page.evaluate(() => {
    const el = document.querySelector('.cv-blk[data-path="src/change-3.ts"]') as
      (HTMLElement & { __koloftProbe?: string }) | null
    if (el) el.__koloftProbe = 'block-3'
  })
  expect(await blockOf(page, 'src/change-3.ts').locator(CV.diffRow).count()).toBeGreaterThan(0)

  await rowOf(page, 'src/change-4.ts').click()

  // FR-38's anchor: the stream scrolls so block 4's header is at the top of the viewport.
  // Clamped when block 4 is the last screenful, so compare against what the stream can
  // actually reach rather than against `offsetTop` blindly.
  const want4 = await blockTop(page, 'src/change-4.ts')
  await expect
    .poll(async () => {
      const [top, max] = await stream(page).evaluate((el) => [
        el.scrollTop,
        el.scrollHeight - el.clientHeight
      ])
      return top === Math.min(want4, max)
    })
    .toBe(true)
  expect(await scrollTop(page)).toBeGreaterThan(0)
  // FR-10 — reading a file in the stream never mints a tab
  expect(await wbTabs(page).count()).toBe(tabsBefore)

  // scroll back up: block 3's diff is there IMMEDIATELY…
  await stream(page).evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(blockOf(page, 'src/change-3.ts').locator(CV.diffRow).first()).toBeVisible()
  // …and it is the SAME node, never unloaded and rebuilt
  const survived = await page.evaluate(
    () =>
      (
        document.querySelector('.cv-blk[data-path="src/change-3.ts"]') as
          (HTMLElement & { __koloftProbe?: string }) | null
      )?.__koloftProbe ?? null
  )
  expect(survived).toBe('block-3')
})

// ---- WB-C02 ------------------------------------------------------------------------------

// WB-C02 (FR-31, §7 diff-only) — the stream NEVER renders, not even a markdown file.
//
// "It shows a diff" is not enough: a build that rendered the prose ABOVE the diff would
// satisfy it. The negative half — no `.md-body` anywhere inside the block, and no
// `Rendered` segment in its header — is what actually pins "diff-only", and the ↗ split
// landing on Rendered is what makes that restriction liveable (the typeset form is one
// click away, FR-12).
test('WB-C02: a changed .md is diff-only in the stream, and ↗ splits it out as Rendered', async ({
  page,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)
  fx.modifyMarkdown()
  await openChanges(page)
  await waitStream(page, 1)

  const blk = blockOf(page, 'docs/guide.md')
  await expect(blk.locator(CV.diffRow).first()).toBeVisible()
  // no typeset body, in either of the two shapes a renderer would leave behind
  expect(await blk.locator('.md-body').count()).toBe(0)
  expect(await blk.locator('.wb-artifact').count()).toBe(0)

  // FR-31's reduced header: exactly three controls, and `Rendered` is not one of them
  const seg = blk.locator(CV.blockSeg)
  expect(await seg.locator('button').allTextContents()).toEqual(['Diff', 'Source', '↗ New tab'])

  const tabsBefore = await wbTabs(page).count()
  await seg.locator('button', { hasText: '↗ New tab' }).click()
  await expect(wbTabs(page)).toHaveCount(tabsBefore + 1)
  // FR-30 decides the split tab's view; for markdown that is Rendered
  await expect(page.locator(WORKBENCH.viewSegOn)).toHaveText('Rendered', { timeout: 20_000 })
})

// ---- WB-C03 ------------------------------------------------------------------------------

// WB-C03 (FR-38) — ⤢ widens ONE file, and ↻ drops the widening.
//
// Y's row count is the assertion that matters. Re-fetching the whole aggregate at full
// context would widen X correctly and pass every X-side check; only an untouched Y proves
// the expansion is per file. The ↻ leg is the other half of the same property: the
// expansion is view state, not a new baseline, so a refresh must not preserve it.
test('WB-C03: ⤢ expands one file to full context, leaves the others alone, and ↻ collapses it', async ({
  page,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)
  fx.modifyTracked(2)
  await openChanges(page)
  await waitStream(page, 2)

  const x = blockOf(page, 'src/change-1.ts')
  const y = blockOf(page, 'src/change-2.ts')
  const compactX = await x.locator(CV.diffRow).count()
  const compactY = await y.locator(CV.diffRow).count()
  // git's default 3 lines of context around a one-line edit in a 40-line file
  expect(compactX).toBeLessThan(12)
  expect(compactY).toBeLessThan(12)

  await x.locator(CV.expand).click()
  await expect(x.locator(CV.expand)).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => x.locator(CV.diffRow).count()).toBeGreaterThan(30)
  expect(await y.locator(CV.diffRow).count()).toBe(compactY)

  await reloadBtn(page).click()
  await expect.poll(() => x.locator(CV.diffRow).count(), { timeout: 20_000 }).toBe(compactX)
  await expect(x.locator(CV.expand)).toHaveAttribute('aria-pressed', 'false')
  expect(await y.locator(CV.diffRow).count()).toBe(compactY)
})

// ---- WB-C04 ------------------------------------------------------------------------------

// WB-C04 (FR-39) — the default baseline is the merge-base, so work already COMMITTED on
// the branch stays visible; `vs HEAD` narrows to the working tree.
//
// The fixture is what makes this falsifiable: C1 is committed and C2 is not, so a build
// that quietly diffs against HEAD shows one file where the default must show two. Asserting
// the exact path SET rather than a count catches the mirror-image bug (a build that shows
// two files under `vs HEAD` by never re-querying).
test('WB-C04: merge-base lists the committed and the uncommitted change; vs HEAD lists only the uncommitted', async ({
  page,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)
  const fb = fx.featureBranch()
  expect(fx.rel(fb.committed)).toBe('src/change-1.ts')
  expect(fx.rel(fb.uncommitted)).toBe('src/change-2.ts')

  await openChanges(page)
  await waitStream(page, 2)
  await expect(baseBtn(page)).toHaveText(/^base ▾$/)
  expect(await shownPaths(page)).toEqual(['src/change-1.ts', 'src/change-2.ts'])

  await baseBtn(page).click()
  await filesMenu(page).getByRole('menuitemradio', { name: 'vs HEAD' }).click()
  await expect(baseBtn(page)).toHaveText(/^vs HEAD ▾$/)

  await waitStream(page, 1)
  expect(await shownPaths(page)).toEqual(['src/change-2.ts'])
  await expect(blockOf(page, 'src/change-2.ts').locator(CV.diffRow).first()).toBeVisible()
})

// ---- WB-C06 ------------------------------------------------------------------------------

// WB-C06 (FR-40) — three filter groups, single-select within a group, AND across groups.
//
// The ownership group is the one that cannot be faked: it reads the SESSION's transcript
// (`access: 'wrote'`), so the fixture drives fake-claude's `/write` rather than editing the
// files from the harness. That is also why the "externally changed" file has to be in the
// set — without it, "this session wrote" would select everything and the chip would be
// tautological.
test('WB-C06: the three filter groups AND together, and Docs is markdown + html', async ({
  page,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)
  const mixed = fx.mixedOwnershipSet()

  await openChanges(page)
  // the two agent writes; each holds its turn open for a beat before Stop
  await runIn(page, centerTerm(page), `/write ${mixed.agentTsRel}`)
  await runIn(page, centerTerm(page), `/write ${mixed.agentMdRel}`)
  await showChanges(page)
  await waitStream(page, 4)
  expect(await shownPaths(page)).toEqual([
    'docs/agent-notes.md',
    'src/agent-notes.ts',
    'src/change-1.ts',
    'src/legacy.ts'
  ])
  expect(fx.rel(mixed.external)).toBe('src/change-1.ts')
  expect(fx.rel(mixed.deleted)).toBe('src/legacy.ts')

  // Ownership — only what this session wrote
  await pickChip(page, 'Ownership', 'session')
  await expect
    .poll(() => shownPaths(page), { timeout: 30_000 })
    .toEqual(['docs/agent-notes.md', 'src/agent-notes.ts'])

  // …AND Type=docs on top of it
  await pickChip(page, 'Type', 'docs')
  await expect.poll(() => shownPaths(page)).toEqual(['docs/agent-notes.md'])

  // clear both groups, then a Status pick alone
  await pickChip(page, 'Ownership', 'all')
  await pickChip(page, 'Type', 'all')
  await expect.poll(() => shownPaths(page)).toHaveLength(4)

  await pickChip(page, 'Status', 'deleted')
  await expect.poll(() => shownPaths(page)).toEqual(['src/legacy.ts'])
  // single-select WITHIN a group: the new pick replaced `all` rather than adding to it
  await filterBtn(page).click()
  await expect(
    page.locator('.fv-fgroup[aria-label="Status"] .ft-chip[data-chip="all"]')
  ).toHaveAttribute('aria-checked', 'false')
  await page.keyboard.press('Escape')
})

// ---- WB-C07 ------------------------------------------------------------------------------

// WB-C07 (FR-41, FR-42) — four special states, one summary row each, and only the rename
// opens.
//
// "It does not expand" is the whole point, so each of the three has to be CLICKED and
// re-checked: a block that shows a summary but expands into a whole-file add on click is
// exactly the regression FR-41 forbids, and a static assertion cannot see it. The rename's
// expanded size is asserted as a BOUND, not just "> 0": a failed pairing degrades into a
// whole-file delete plus a whole-file add (≈80 rows here), which "it expanded" would wave
// through.
test('WB-C07: rename / binary / deleted / conflict are one summary row each, and only the rename opens', async ({
  page,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)
  const st = fx.specialStates()
  // the fixture's own guarantee, independent of what the panel decides to show
  expect(fx.unmergedPaths()).toContain('src/conflict.ts')

  await openChanges(page)
  await waitStream(page, 4)

  const kinds = Object.fromEntries(
    (await blocks(page).evaluateAll((els) =>
      els.map((e) => [(e as HTMLElement).dataset.path, (e as HTMLElement).dataset.kind])
    )) as [string, string][]
  )
  expect(kinds).toEqual({
    'assets/logo.png': 'binary',
    'src/conflict.ts': 'conflict',
    'src/legacy.ts': 'deleted',
    'src/newname.ts': 'renamed'
  })
  expect(fx.rel(st.renamed.to)).toBe('src/newname.ts')
  expect(fx.rel(st.binary)).toBe('assets/logo.png')
  expect(fx.rel(st.deleted)).toBe('src/legacy.ts')
  expect(fx.rel(st.conflicted)).toBe('src/conflict.ts')

  // the three that never open — asserted AFTER a click, which is the only way to tell a
  // summary row apart from a collapsed one
  for (const rel of ['assets/logo.png', 'src/conflict.ts', 'src/legacy.ts']) {
    const blk = blockOf(page, rel)
    await expect(blk.locator(CV.special)).toHaveCount(1)
    expect(await blk.locator(CV.diffRow).count()).toBe(0)
    await blk.locator(CV.special).click()
    expect(await blk.locator(CV.diffRow).count()).toBe(0)
  }

  // the one that does — into the PAIRED diff git already carried, not an add + a delete
  const ren = blockOf(page, 'src/newname.ts')
  await expect(ren.locator('.cv-rename')).toHaveAttribute('aria-expanded', 'false')
  await expect(ren.locator('.cv-rename')).toHaveText(/Renamed from src\/oldname\.ts/)
  expect(await ren.locator(CV.diffRow).count()).toBe(0)
  await ren.locator('.cv-rename').click()
  await expect(ren.locator('.cv-rename')).toHaveAttribute('aria-expanded', 'true')
  const paired = await ren.locator(CV.diffRow).count()
  expect(paired).toBeGreaterThan(0)
  expect(paired).toBeLessThan(20) // the file is 40 lines; an unpaired R would be ~80 rows
})

// ---- WB-C08 ------------------------------------------------------------------------------

// WB-C08 (FR-43) — untracked and binary files carry the status letter and NO ±N.
//
// The third file is the barrier, not decoration: without an ordinary tracked text file in
// the same set, "no ±N anywhere" would pass against a build that had simply lost the
// decoration altogether.
test('WB-C08: untracked and binary rows show a status letter but no ±N', async ({ page, env }) => {
  const fx = setupChangeFixture(env.workspaces.a)
  fx.modifyTracked(1)
  fx.addUntracked()
  fx.changeBinary()

  await openChanges(page)
  await waitStream(page, 3)

  const untracked = rowOf(page, 'src/brand-new.ts')
  const binary = rowOf(page, 'assets/logo.png')
  const tracked = rowOf(page, 'src/change-1.ts')

  await expect(untracked.locator('.ft-gbadge')).toHaveText('U')
  expect(await untracked.locator('.ft-delta').count()).toBe(0)
  await expect(binary.locator('.ft-gbadge')).toHaveText('M')
  expect(await binary.locator('.ft-delta').count()).toBe(0)
  // the positive control: a tracked text change DOES carry ±N
  await expect(tracked.locator('.ft-delta .add')).toHaveText('+1')
  await expect(tracked.locator('.ft-delta .del')).toHaveText('−1')
})

// ---- the totals row ----------------------------------------------------------------------

// The left list's summary row: the whole listed set added up. It carries no retired-plan
// id because the row postdates that plan — before it, the panel showed a ±N per file and
// the totals nowhere, so "how big is this change" had no answer on screen at all.
//
// Two properties, and each fails differently:
//  · the sum is a SUM. Five files — four at +1/−1 and one untracked, which FR-43 gives no
//    count — read '+4 −4'. Not '+1 −1' (a build echoing one row's badge) and not '+5 −5'
//    (one that invented a count for the untracked file), while the file count beside it
//    still says all five are listed.
//  · the row follows the LIST, not the pinned tab's badge, which counts the unfiltered
//    set (WB-C10). While a filter hides four of the five files, the badge and the row have
//    to disagree — a build that wired the row to the badge is right on every unfiltered
//    screen and wrong only here.
test('the file list totals the change set, and the total follows the filter', async ({
  page,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)
  fx.modifyTracked(3) // three tracked files, one line replaced in each → +1/−1 apiece
  fx.modifyMarkdown() // a fourth, same shape
  fx.addUntracked() // no ±N at all (FR-43), so it must not move the sum

  await openChanges(page)
  await waitStream(page, 5)

  const total = page.locator(CV.total)
  // the untracked file is IN the list and OUT of the sum, and the row says so on its own
  // face — a tooltip is not read by someone with no reason to doubt the number
  await expect(total.locator('.cv-total-n')).toHaveText('5 files · 1 not counted')
  await expect(total.locator('.ft-delta .add')).toHaveText('+4')
  await expect(total.locator('.ft-delta .del')).toHaveText('−4')
  await expect(total).toHaveAttribute(
    'title',
    '5 files listed · 4 added, 4 removed. 1 of them brings no line count (new, binary, or git gave none).'
  )
  await expect(total).toHaveAttribute('data-partial', '1')

  await pickChip(page, 'Type', 'docs')
  await expect.poll(() => shownPaths(page)).toEqual(['docs/guide.md'])
  await expect(total.locator('.cv-total-n')).toHaveText('1 file')
  await expect(total.locator('.ft-delta .add')).toHaveText('+1')
  await expect(total.locator('.ft-delta .del')).toHaveText('−1')
  await expect(badge(page)).toHaveText('5') // …while the badge still counts them all
  // the filter left only counted files, so the caveat goes away with them
  await expect(total).not.toHaveAttribute('data-partial', '1')

  // an edit under the filter still moves the sum — the row is live, not a first-paint value
  fx.editTracked(fx.paths.markdown)
  await expect(total.locator('.ft-delta .add')).toHaveText('+2', { timeout: 30_000 })
})

// The summary is a header of the column, not a row in it: it stays put while the list
// scrolls. `room > 0` is the barrier — on a column tall enough to show every row, "did not
// move on scroll" passes by having nothing to scroll. The set is tracked edits almost
// entirely, so it costs one aggregate diff per tick rather than a `--no-index` diff per
// file; the four untracked ones are the margin. Measured: 29 rows under five
// group headers, scrollHeight 881 against a 760px column — 121px of room, about four rows.
test('the change-set summary stays put while the file list scrolls', async ({ page, env }) => {
  const fx = setupChangeFixture(env.workspaces.a)
  const p = fx.paths
  const tracked = [
    ...p.changeable,
    p.markdown,
    p.html,
    p.htm,
    p.agentTs,
    p.agentTsB,
    p.agentMd,
    p.deepFile,
    p.readme,
    p.deletable,
    p.renameSource,
    p.conflictFile,
    p.huge,
    ...p.bulk
  ]
  for (const abs of tracked) fx.editTracked(abs)
  for (let i = 0; i < 4; i++) fx.addUntracked(`src/extra-${i}.ts`)

  await openChanges(page)
  await expect(rows(page)).toHaveCount(tracked.length + 4, { timeout: 60_000 })

  const list = page.locator('.wb-panel .cv-list')
  const total = page.locator(CV.total)
  await expect(total).toBeVisible()
  const room = await list.evaluate((el) => el.scrollHeight - el.clientHeight)
  expect(room).toBeGreaterThan(0)

  // rounded: sub-pixel layout noise moves the box by ~0.007px between two reads of an
  // element that did not move, and the claim is "did not scroll", not "identical float"
  const topOf = async (): Promise<number> => {
    const box = await total.boundingBox()
    if (!box)
      throw new Error('the summary header left the screen — it must survive every scroll offset')
    return Math.round(box.y)
  }
  const before = await topOf()
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  expect(await topOf()).toBe(before)
})

// `groupByDir` (changesModel.ts) says how a duplicated group key let rows outlive their
// session — a subdirectory sorting between two of its parent's files. This drives that
// shape through the two renders that showed it. Both halves are EXACT lists, because an
// orphan is a real `.cv-row` with a real `data-path`: a count on one path (`rowOf`) misses
// the orphans of every other path, and only the whole list catches them. The first half is
// the root cause's own symptom, reached without leaving the session; the second is the
// symptom that was reported: the previous session's rows above the next one's.
test('a directory split by its subdirectory leaves no orphaned rows — across a poll, or a session switch', async ({
  page,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)
  fx.modifyTracked(2) // src/change-1.ts, src/change-2.ts
  fx.addUntracked('src/lib/util.ts') // sorts between them and…
  fx.addUntracked('src/zz-late.ts') // …this one, which is src/ again

  await openChanges(page)
  await waitStream(page, 4)

  // a group that sorts in FRONT of `src` arrives from a poll: the reconciler now walks the
  // old groups through its key map, which is where a duplicated key loses a group
  fx.modifyMarkdown()
  await expect(rowOf(page, 'docs/guide.md')).toHaveCount(1, { timeout: 30_000 })
  expect
    .soft(await shownPaths(page))
    .toEqual([
      'docs/guide.md',
      'src/change-1.ts',
      'src/change-2.ts',
      'src/zz-late.ts',
      'src/lib/util.ts'
    ])

  // another worktree's session: its list is its own and nothing else
  const fb = setupChangeFixture(env.workspaces.b)
  fb.modifyTracked(1)
  await startSessionIn(page, 'ws-b')
  await showChanges(page)
  await expect.poll(() => shownPaths(page), { timeout: 30_000 }).toEqual(['src/change-1.ts'])
})

// ---- WB-C09 ------------------------------------------------------------------------------

// WB-C09 (FR-58) — an external write updates the stream IN PLACE.
//
// `scrollTop` captured before and compared after is the only honest oracle. A build that
// re-fetches and re-renders the whole stream still ends up showing the right content, and
// every content assertion passes — the reader is just somewhere else. The edited file is
// deliberately BELOW the anchored one, so the anchored block's own `offsetTop` is invariant
// too and the assertion means "the viewport did not move", not merely "the number is equal".
test('WB-C09: an external write updates one block and the badge without moving the viewport', async ({
  page,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)
  fx.modifyTracked(5)

  await openChanges(page)
  await waitStream(page, 5)
  await expect(badge(page)).toHaveText('5')

  await rowOf(page, 'src/change-4.ts').click()
  const anchoredTop = await scrollTop(page)
  expect(anchoredTop).toBeGreaterThan(0)
  const anchorOffset = await blockTop(page, 'src/change-4.ts')

  const y = blockOf(page, 'src/change-5.ts')
  expect(await y.locator(CV.hunk).count()).toBe(1)

  // a second, separate edit to Y — one more hunk, and a ±N that has to move with it
  fx.editTracked(fx.paths.changeable[4])
  await expect.poll(() => y.locator(CV.hunk).count(), { timeout: 30_000 }).toBe(2)
  await expect(rowOf(page, 'src/change-5.ts').locator('.ft-delta .add')).toHaveText('+2')
  await expect(rowOf(page, 'src/change-5.ts').locator('.ft-delta .del')).toHaveText('−2')

  expect(await scrollTop(page)).toBe(anchoredTop)
  expect(await blockTop(page, 'src/change-4.ts')).toBe(anchorOffset)

  // FR-58's other half: the pinned tab's badge follows the disk with no ↻. The new file
  // sorts LAST, so it cannot move the anchored block either.
  fx.addUntracked('src/zz-late.ts')
  await expect(badge(page)).toHaveText('6', { timeout: 30_000 })
  await expect(rowOf(page, 'src/zz-late.ts')).toHaveCount(1)
  expect(await scrollTop(page)).toBe(anchoredTop)
})

// ---- WB-C10 ------------------------------------------------------------------------------

// WB-C10 (FR-50, FR-58) — the badge counts the UNFILTERED set.
//
// The number has to be captured and re-read across the filter, because the obvious
// implementation (badge = the list's length) is right on every unfiltered screen and wrong
// only here. The second half is the same property under a change: while a filter hides four
// of the six files, a seventh change still has to move the badge.
test('WB-C10: the badge counts every change, not the filtered ones, and survives ↻', async ({
  page,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)
  fx.modifyTracked(4)
  fx.modifyMarkdown()
  fx.modifyHtml()

  await openChanges(page)
  await waitStream(page, 6)
  await expect(badge(page)).toHaveText('6')

  await pickChip(page, 'Type', 'docs')
  await expect.poll(() => shownPaths(page)).toEqual(['docs/guide.md', 'docs/report.html'])
  // the whole case: the filter moved the list and left the badge alone
  await expect(badge(page)).toHaveText('6')

  // a seventh change arrives while the filter still hides it
  fx.editTracked(fx.paths.changeable[4])
  await expect(badge(page)).toHaveText('7', { timeout: 30_000 })
  expect(await shownPaths(page)).toEqual(['docs/guide.md', 'docs/report.html'])

  // ↻ re-queries everything; the list and the stream still agree with the disk
  await reloadBtn(page).click()
  await expect(badge(page)).toHaveText('7')
  await expect.poll(() => shownPaths(page)).toEqual(['docs/guide.md', 'docs/report.html'])
  await expect(blockOf(page, 'docs/guide.md').locator(CV.diffRow).first()).toBeVisible()

  await pickChip(page, 'Type', 'all')
  await expect.poll(() => shownPaths(page)).toHaveLength(7)
  await expect(badge(page)).toHaveText('7')
})

// ---- WB-C11 ------------------------------------------------------------------------------

// WB-C11 (§Edge maxBuffer, §7 {text,truncated}) — a truncated aggregate is never presented
// as complete.
//
// The banner MUST be present; that is the case. The second assertion is the sharper one:
// a file the truncated aggregate never reached says so in its own block, rather than
// rendering as "no diff" — which is the shape the pre- behaviour had and is
// indistinguishable from a genuinely unchanged file.
test('WB-C11: an over-sized change set shows the truncation banner and labels what was cut off', async ({
  page,
  env
}) => {
  test.slow()
  test.setTimeout(240_000)
  const fx = setupChangeFixture(env.workspaces.a)
  fx.overflowAggregateDiff()
  fx.modifyTracked(1) // sorts after `bulk/huge.txt`, so the aggregate never reaches it

  await openChanges(page)
  await expect(rows(page)).toHaveCount(2, { timeout: 180_000 })

  const banner = page.locator(CV.banner)
  await expect(banner).toHaveCount(1, { timeout: 180_000 })
  await expect(banner).toHaveText(/^Change set too large — showing the first \d+ files\.$/)

  // what did come through is folded (it is past the big-diff bound) — no rows until asked,
  // because rendering them is the cost the fold exists to defer — and then readable
  const huge = blockOf(page, 'bulk/huge.txt')
  await expect(huge.locator('.cv-bigdiff')).toBeVisible({ timeout: 60_000 })
  await expect(huge.locator(CV.diffRow)).toHaveCount(0)
  await huge.locator('.cv-bigdiff').click()
  await expect(huge.locator(CV.diffRow).first()).toBeVisible({ timeout: 60_000 })
  // …and what did not is LABELLED, not silently shown as unchanged
  await expect(blockOf(page, 'src/change-1.ts').locator('.cv-note')).toHaveText(
    'Not shown — the change set was truncated.'
  )
})

// ---- WB-C12 ------------------------------------------------------------------------------

// WB-C12 (§Edge empty) — a clean repo says so, and the controls stay live.
//
// The second half is why this is not a screenshot case: the cheap empty state is an early
// return that also drops the kind bar's Changes-side controls, and nothing about the
// message itself would reveal it.
test('WB-C12: a clean repo shows the empty state with the base and filter controls still usable', async ({
  page,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)
  expect(fx.isClean()).toBe(true)

  await openChanges(page)
  await expect(page.locator(CV.empty)).toHaveText('No changes against the base.', {
    timeout: 30_000
  })
  expect(await rows(page).count()).toBe(0)
  expect(await badge(page).count()).toBe(0)

  await baseBtn(page).click()
  await expect(filesMenu(page)).toBeVisible()
  await filesMenu(page).getByRole('menuitemradio', { name: 'vs HEAD' }).click()
  await expect(baseBtn(page)).toHaveText(/^vs HEAD ▾$/)
  await expect(page.locator(CV.empty)).toHaveText('No changes against the base.')

  await filterBtn(page).click()
  await expect(page.locator('.fv-filters .fv-fgroup')).toHaveCount(3)
  await page.keyboard.press('Escape')
})

// ---- WB-C13 ------------------------------------------------------------------------------

// WB-C13 (§Edge not a git repo) — Changes reports it; Browse keeps working.
//
// The Browse half is the case. "Not a git repository" is easy to get right and easy to
// over-apply: blanking the whole `files` tab (the shell's own root-missing placeholder)
// would satisfy every Changes-side assertion and take the directory browser down with it,
// in a workspace where browsing is the only thing left that CAN work.
test('WB-C13: a non-git workspace fails Changes only — Browse still lists and opens files', async ({
  page,
  env
}) => {
  const paths = seedBrowseTree(env.workspaces.a)
  expect(fs.existsSync(`${env.workspaces.a}/.git`)).toBe(false)

  await openChanges(page)
  await expect(page.locator(CV.empty)).toHaveText('Not a git repository.', { timeout: 30_000 })
  // the shell's own placeholder is a DIFFERENT state and must not be the one on screen
  expect(await page.locator('.wb-panel .fv.fv-empty').count()).toBe(0)

  await openInBrowse(page, paths.deepFile)
  await expect(page.locator(WORKBENCH.readingTitle)).toContainText('beacon.ts', {
    timeout: 30_000
  })
  await expect(page.locator(WORKBENCH.readingBody)).toBeVisible()
})

// ---- WB-C14 ------------------------------------------------------------------------------

// WB-C14 (§Edge treeRoot gone) — a deleted worktree shows a placeholder and starts no
// retry storm.
//
// The `file` tab is deliberately rooted OUTSIDE the deleted directory. That is what makes
// it a test of the SHELL's blast radius (root missing ⇒ the pinned tab, and only the
// pinned tab, goes to the placeholder) rather than a second copy of WB-R12's "the file
// itself was deleted". The quiet window is asserted on the git-spawn log and on
// `pageerror`, because a retry storm is invisible in the DOM — the placeholder looks the
// same whether it is painted once or two hundred times.
test('WB-C14: a deleted worktree shows the placeholder, keeps other tabs readable, and stops polling', async ({
  app,
  page,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)
  fx.modifyTracked(2)
  const relaunched = await relaunchWithGitLog(app, env)
  const p = relaunched.page
  try {
    await openChanges(p)
    await waitStream(p, 2)

    // a `file` tab on a file the deletion will NOT touch
    await openFileTab(p, env, `${env.workspaces.b}/README.md`)
    await expect(p.locator(`${WORKBENCH.artifact}:visible`)).toContainText('koloft-e2e-bravo', {
      timeout: 30_000
    })
    await p.locator(WORKBENCH.tabFiles).click()

    const errors: string[] = []
    p.on('pageerror', (e) => errors.push(String(e)))

    fs.rmSync(env.workspaces.a, { recursive: true, force: true })

    await expect(p.locator('.wb-panel .fv.fv-empty')).toHaveText(
      'This directory no longer exists.',
      { timeout: 60_000 }
    )
    // Browse is the same placeholder — the shell owns it, so the switch cannot escape it
    await p
      .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
      .filter({ hasText: 'Browse' })
      .click()
    await expect(p.locator('.wb-panel .fv.fv-empty')).toHaveText('This directory no longer exists.')

    const quiet = await waitGitQuiet(env, { root: env.workspaces.a })
    await p.waitForTimeout(10_000)
    expect(countGitSpawns(env, { root: env.workspaces.a })).toBe(quiet)
    expect(errors).toEqual([])

    // the other tab is untouched
    await p.locator(WORKBENCH.tab).filter({ hasText: 'README.md' }).click()
    await expect(p.locator(`${WORKBENCH.artifact}:visible`)).toContainText('koloft-e2e-bravo')
  } finally {
    await relaunched.app.close().catch(() => {})
  }
})

// ---- WB-C15 ------------------------------------------------------------------------------

// WB-C15 (§Edge multiple sessions) — one worktree, two sessions: the same change set, told
// apart only by ownership.
//
// Both halves are needed. The shared list alone would pass against a build that scopes the
// change set per session (both sessions wrote something, so both lists would be non-empty);
// the ownership split alone would pass against one that never shares. Asserting the SET
// each way is what pins "one worktree, one change set, two readings of it".
test('WB-C15: two sessions on one worktree share the change set and differ only by ownership', async ({
  page,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)

  // The two rows are addressed by TITLE, never by strip position: which end of the group a
  // new session lands on is the sidebar's business, and reading it wrong here would make
  // this case assert the exact opposite of itself while still looking green on one of the
  // two halves.
  setNextSessionTitle(env, 'Session A')
  await openChanges(page)
  await runIn(page, centerTerm(page), `/write ${fx.rel(fx.paths.agentTs)}`)

  setNextSessionTitle(env, 'Session B')
  await startSessionIn(page, 'ws-a') // same worktree
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
  await runIn(page, centerTerm(page), `/write ${fx.rel(fx.paths.agentTsB)}`)

  const rowFor = (title: string): Locator =>
    page.locator('.ws-tab').filter({ has: page.locator('.ws-tab-title', { hasText: title }) })
  await expect(rowFor('Session A')).toHaveCount(1, { timeout: 40_000 })
  await expect(rowFor('Session B')).toHaveCount(1, { timeout: 40_000 })
  const rowA = rowFor('Session A')
  const rowB = rowFor('Session B')

  // B: the full set is both files; its own filter keeps only what B wrote
  await rowB.click()
  await showChanges(page)
  await expect
    .poll(() => shownPaths(page), { timeout: 30_000 })
    .toEqual(['src/agent-notes-b.ts', 'src/agent-notes.ts'])
  await pickChip(page, 'Ownership', 'session')
  await expect.poll(() => shownPaths(page), { timeout: 30_000 }).toEqual(['src/agent-notes-b.ts'])

  // A: the same full set (its own filters were never touched), its own split
  await rowA.click()
  await showChanges(page)
  await expect
    .poll(() => shownPaths(page), { timeout: 30_000 })
    .toEqual(['src/agent-notes-b.ts', 'src/agent-notes.ts'])
  await pickChip(page, 'Ownership', 'session')
  await expect.poll(() => shownPaths(page), { timeout: 30_000 }).toEqual(['src/agent-notes.ts'])
})

// ---- WB-C16 ------------------------------------------------------------------------------

// WB-C16 (NFR-01) — syntax highlighting is lazy, and nothing is truncated to buy it.
//
// The oracle is a Shiki token span inside a diff row: `PlainRows` mirrors `InlineDiff`'s
// markup row for row (same nodes, same height, so the swap cannot reflow the stream), and
// the ONLY difference between them is that the highlighted form fills `.idiff-code` with
// coloured spans. Counting rows or reading text cannot separate the two states at all.
// The first block is the positive control: without it, a build that highlights NOTHING
// would pass the "off-screen block is plain" half outright.
//
// The zero-token line took three fixes to turn green, and what it kept
// catching is worth stating so it is never relaxed to "fewer tokens than block 1": a block
// is measured while it is still a ~70px `Loading…` / `No diff available.` STUB, decides it
// is on screen, and latches — permanently, because `seen` is never cleared. Measured at
// 25 ms through the fill, the failing shape was six stubs → six 70097px blocks → all six
// carrying 16200 spans, with the last at offsetTop 350489 in a 790px viewport. Every
// stream-wide "has the load finished" gate missed it, because the stream's first fetch runs
// against a still-empty status map and reports done with zero sections; the rule that holds
// is per BLOCK (`data-ready`, stamped in the same commit that renders the rows). Which also
// means this case guards WB-C09's territory: a file a LATER poll appends mounts as a stub
// into an already-loaded stream and takes the same path.
//
// `expect.soft` on that one line so a regression there still lets the rest of the case run
// — the two clauses below it were the ones being masked while it was red.
test('WB-C16: only the blocks that have been scrolled to are syntax-highlighted', async ({
  page,
  env
}) => {
  test.slow()
  const fx = setupChangeFixture(env.workspaces.a)
  fx.bigChange()

  await openChanges(page)
  await waitStream(page, 6, 60_000)

  const first = blockOf(page, 'bulk/part-1.ts')
  const far = blockOf(page, 'bulk/part-6.ts')

  // the first block's first row is on screen, and it gets highlighted
  await expect(first.locator(CV.diffRow).first()).toBeVisible()
  await expect.poll(() => first.locator(CV.token).count(), { timeout: 60_000 }).toBeGreaterThan(0)

  // the far block's rows exist (⌘F must find text nobody has scrolled to) but are plain
  expect(await far.locator(CV.diffRow).count()).toBeGreaterThan(0)
  expect.soft(await far.locator(CV.token).count()).toBe(0)
  // and nothing in the stream was dropped to afford it
  expect(await page.locator(CV.banner).count()).toBe(0)
  expect(await page.locator('.wb-panel .idiff-hint').count()).toBe(0)

  // scrolling to it lights it up
  const top = await blockTop(page, 'bulk/part-6.ts')
  await stream(page).evaluate((el, y) => {
    el.scrollTop = y
  }, top)
  await expect.poll(() => far.locator(CV.token).count(), { timeout: 60_000 }).toBeGreaterThan(0)
  // …and the block already passed keeps what it had (WB-C01's stream property, seen from
  // the highlighting side)
  expect(await first.locator(CV.token).count()).toBeGreaterThan(0)
})

// ---- WB-C17 ------------------------------------------------------------------------------

// WB-C17 (NFR-02) — one refresh resolves the baseline exactly once.
//
// `merge-base` has exactly one call site in the whole app (`gitStatus.diffBase`), so
// counting it IS counting baseline resolutions. The number matters because the pre-
// shape spawned the same pair per consumer and per FILE: with an untracked file in the set
// the stream also makes per-file diff calls, and every one of them is a chance to re-derive
// the base. Asserting `=== 1` rather than `>= 1` is the whole case.
//
// TWO windows, because they catch different leaks and the second one is the one that was
// actually leaking. Window 1 is the deterministic core: ↻, one refresh, one resolution.
// Window 2 opens a `file` tab first and then writes that file from outside — which fans a
// single change out to two consumers, the panel's poll and `ArtifactPane`'s own
// `gitFileDiffFull` on its watch. Until that second consumer passed no base and
// re-derived one in main, so the honest count for this window was 2. Note that ↻ alone
// cannot see it: the Files ↻ never reaches a `file` tab's diff fetch (only `fs:file-changed`
// bumps its `diffTick`), so a one-window version of this case would have stayed green
// through the whole leak.
test('WB-C17: one Changes refresh resolves the baseline exactly once', async ({
  app,
  page,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)
  fx.modifyTracked(3)
  fx.addUntracked()
  const ws = env.workspaces.a

  const relaunched = await relaunchWithGitLog(app, env)
  const p = relaunched.page
  const mergeBases = (): number => countGitSpawns(env, { root: ws, subcommand: 'merge-base' })
  const aggregates = (): number => countGitSpawns(env, { root: ws, argv: isAggregateDiff })
  try {
    await openChanges(p)
    await waitStream(p, 4)
    // the untracked file's own diff is fetched per file — the calls most likely to
    // re-derive a base
    await expect(blockOf(p, 'src/brand-new.ts').locator(CV.diffRow).first()).toBeVisible({
      timeout: 30_000
    })
    await waitGitQuiet(env, { root: ws })

    // ---- window 1: the manual refresh ----
    let baseBefore = mergeBases()
    let aggBefore = aggregates()
    await reloadBtn(p).click()
    // a positive barrier that the refresh really ran, so the count below is of a real
    // refresh rather than of nothing happening yet
    await expect.poll(aggregates, { timeout: 30_000 }).toBe(aggBefore + 1)
    await waitGitQuiet(env, { root: ws })
    expect(mergeBases()).toBe(baseBefore + 1)

    // …and the refresh produced a complete screen, not a cheap one
    expect(await shownPaths(p)).toEqual([
      'src/brand-new.ts',
      'src/change-1.ts',
      'src/change-2.ts',
      'src/change-3.ts'
    ])
    await expect(rowOf(p, 'src/change-1.ts').locator('.ft-delta .add')).toHaveText('+1')
    await expect(blockOf(p, 'src/change-1.ts').locator(CV.diffRow).first()).toBeVisible()

    // ---- window 2: a refresh with a `file` tab watching one of the changed files ----
    await openFileTab(p, env, fx.paths.changeable[0])
    await expect(p.locator(WORKBENCH.viewSegOn)).toHaveText('Diff', { timeout: 30_000 })
    await p.locator(WORKBENCH.tabFiles).click()
    await expect.poll(() => activeView(p), { timeout: 20_000 }).toBe('changes')
    await waitGitQuiet(env, { root: ws })

    baseBefore = mergeBases()
    aggBefore = aggregates()
    fx.editTracked(fx.paths.changeable[0])

    // both consumers have reacted: the stream re-queried, and the file tab's own
    // full-context diff ran for that path
    await expect.poll(aggregates, { timeout: 30_000 }).toBe(aggBefore + 1)
    await expect
      .poll(
        () =>
          countGitSpawns(env, {
            root: ws,
            subcommand: 'diff',
            argv: (argv) => argv.includes(fx.paths.changeable[0])
          }),
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0)
    await waitGitQuiet(env, { root: ws })

    expect(mergeBases()).toBe(baseBefore + 1)
    await expect(rowOf(p, 'src/change-1.ts').locator('.ft-delta .add')).toHaveText('+2')

    // ---- window 3: a directory event that changes NOTHING ----
    // The panel re-reads status and numstat on every event the watcher reports, and both
    // arrive as freshly deserialized objects. Storing one whose CONTENT matches what is on
    // screen still changes the identity the stream's fetch depends on, and the whole
    // aggregate diff (plus the untracked backfill behind it) ran a second time against the
    // same baseline — the extra query per refresh NFR-02 exists to forbid. Rewriting a file
    // with its own bytes is the cheapest way to say "the workspace moved, the change set
    // did not".
    aggBefore = aggregates()
    const lsBefore = countGitSpawns(env, { root: ws, subcommand: 'ls-files' })
    fs.writeFileSync(fx.paths.changeable[0], fs.readFileSync(fx.paths.changeable[0]))
    // the positive barrier: the panel really did refresh. Without it "no aggregate diff"
    // would pass just as well on a build whose watcher never fired at all.
    await expect
      .poll(() => countGitSpawns(env, { root: ws, subcommand: 'ls-files' }), { timeout: 30_000 })
      .toBeGreaterThan(lsBefore)
    await waitGitQuiet(env, { root: ws })
    expect(aggregates()).toBe(aggBefore)
  } finally {
    await relaunched.app.close().catch(() => {})
  }
})

// ---- WB-R08 ------------------------------------------------------------------------------

// WB-R08 (FR-12) — ↗ New tab inherits the block's VIEW and its scroll offset.
//
// Both halves, because either alone is a plausible partial implementation: handing over the
// view is one argument, handing over the offset needs `ArtifactPane`'s `initialScrollTop`
// seam to fire on the right render. The offset is block-RELATIVE (`stream.scrollTop -
// block.offsetTop`), so the test scrolls past the block's top on purpose — a build that
// forwarded the stream's own `scrollTop` would land somewhere else entirely and still look
// "scrolled".
//
// The subject is a 900-line file on purpose. A 40-line one fits the panel whole, its Source
// view has nothing to scroll, and the browser clamps the inherited offset back to 0 — which
// is exactly what a build that forwarded nothing produces. There has to be room to be wrong
// in.
//
// Both of the assertions below caught a real defect on the way in, which is
// why neither may be dropped as redundant:
//  · the reachability check found `.cv-blk-hd` rendering non-sticky, so the ↗ scrolled off
//    the top with its block — the button FR-12 hangs on was unreachable for exactly the
//    blocks that have an offset worth inheriting;
//  · the offset check found `ArtifactPane`'s seeding latching against an EMPTY body and
//    never retrying (its own comment now records the diagnosis at the load-bearing site).
// A build that regresses either one passes every other assertion in this test.
test('WB-R08: ↗ New tab splits the block out with its view and its scroll offset', async ({
  page,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)
  fx.editTracked(fx.paths.bulk[0])
  fx.modifyTracked(1)
  const subject = 'bulk/part-1.ts'

  await openChanges(page)
  await waitStream(page, 2)

  const blk = blockOf(page, subject)
  const seg = blk.locator(CV.blockSeg)
  await seg.locator('button', { hasText: 'Source' }).click()
  await expect(seg.locator('button[aria-pressed="true"]')).toHaveText('Source')
  await expect(blk.locator('.cv-src')).toBeVisible({ timeout: 20_000 })

  // scroll INTO the block, so the inherited offset is non-zero and is not the stream's own
  const top = await blockTop(page, subject)
  const want = 120
  await stream(page).evaluate((el, y) => {
    el.scrollTop = y
  }, top + want)
  expect((await scrollTop(page)) - top).toBe(want)

  // …and the ↗ has to still be ON SCREEN, because the case's own When clause is a click on
  // it from here. Read as boxes rather than through Playwright's actionability check, which
  // would silently scroll the header back into view and take the offset with it.
  const hd = await blk.locator('.cv-blk-hd').boundingBox()
  const view = await stream(page).boundingBox()
  expect(hd && view && hd.y + hd.height > view.y).toBe(true)

  const tabsBefore = await wbTabs(page).count()
  await seg.locator('button', { hasText: '↗ New tab' }).click()
  await expect(wbTabs(page)).toHaveCount(tabsBefore + 1)

  // the split tab is active, in Source, scrolled to the inherited offset
  await expect(page.locator(WORKBENCH.tabActive)).toContainText('part-1.ts')
  await expect(page.locator(WORKBENCH.viewSegOn)).toHaveText('Source', { timeout: 20_000 })
  // polled, not read once: the seed lands only after the highlighted body is in the DOM
  await expect
    .poll(
      () =>
        page
          .locator(`${WORKBENCH.artifact}:visible .code-body`)
          .evaluate((el) => (el as HTMLElement).scrollTop),
      { timeout: 20_000 }
    )
    .toBe(want)

  // FR-12's last clause: the stream keeps the block it was split from
  await page.locator(WORKBENCH.tabFiles).click()
  await expect(blockOf(page, subject)).toHaveCount(1)
  await expect(blockOf(page, subject).locator('.cv-src')).toBeVisible()
})

// ---- WB-K08 ------------------------------------------------------------------------------

// WB-K08 (FR-51) — a collapsed panel is the Workbench's OFF switch for git.
//
// Now that the sidebar file tree has retired, the panel is the renderer's only git-traffic
// source, so any `merge-base` / `diff` / `ls-files` / `check-ignore` at this workspace is
// attributable to it (helpers/gitSpawnLog.ts `WORKBENCH_GIT` enumerates why those four and
// no others). The expand leg is the barrier that keeps the zero honest: a build that broke
// the refresh entirely would also spawn nothing, and would pass the first half outright.
test('WB-K08: a collapsed panel spawns no git for the workspace, and catches up on expand', async ({
  app,
  page,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)
  fx.modifyTracked(2)
  const ws = env.workspaces.a

  const relaunched = await relaunchWithGitLog(app, env)
  const p = relaunched.page
  try {
    await openChanges(p)
    await waitStream(p, 2)

    await clickAppMenuItem(relaunched.app, p, 'toggle-browser')
    await expect.poll(() => layoutState(p)).toBe('T1')
    await waitGitQuiet(env, { root: ws })
    const before = countGitSpawns(env, { root: ws, subcommand: WORKBENCH_GIT })

    // an external change the panel would normally react to
    fx.addUntracked('src/while-collapsed.ts')
    fx.editTracked(fx.paths.changeable[0])
    await p.waitForTimeout(10_000)

    expect(countGitSpawns(env, { root: ws, subcommand: WORKBENCH_GIT })).toBe(before)

    // …and the data is not stale, it was simply never fetched
    await clickAppMenuItem(relaunched.app, p, 'toggle-browser')
    await expect.poll(() => layoutState(p)).toBe('T2')
    await showChanges(p)
    await waitStream(p, 3)
    await expect(rowOf(p, 'src/while-collapsed.ts')).toHaveCount(1)
    expect(countGitSpawns(env, { root: ws, subcommand: WORKBENCH_GIT })).toBeGreaterThan(before)
  } finally {
    await relaunched.app.close().catch(() => {})
  }
})

// WB-K08b (FR-51, FR-01) — the same OFF switch, for the panel nobody has heard about yet.
//
// The open flag lives in main, which also resolves the global default, so for one IPC
// round trip after a session binds the renderer holds no answer at all. Guessing "open"
// for that window was not free: the panel was laid out and its refresh effect ran, so a
// workspace whose panel is collapsed got the `merge-base` + `diff` + `ls-files` burst
// FR-51 promises it will never see — and the user watched the panel flash open and
// collapse again.
//
// The spawn count is the assertion carrying this, and no layout assertion could replace
// it: the flash is over in one IPC round trip, far inside any poll interval, while the
// PATH shim's log still holds the evidence afterwards. The expand leg keeps the zero
// honest for the same reason it does in WB-K08.
test('WB-K08b: a session whose panel starts collapsed spawns no git before main has answered', async ({
  app,
  env
}) => {
  const fx = setupChangeFixture(env.workspaces.a)
  fx.modifyTracked(2)
  const ws = env.workspaces.a

  // A session with no entry of its own inherits `workbench.defaultOpen` — main's answer,
  // and the shortest route to "persisted collapsed" that needs no session id up front.
  // Seeded with the fixture app down: main reads layout.json once, in its constructor.
  await app.close().catch(() => {})
  seedWorkbenchDefault(env, false)

  const relaunched = await relaunchWithGitLog(app, env)
  const p = relaunched.page
  try {
    // `startSessionIn` returns on the Workbench icon going enabled, i.e. the moment the
    // panel HAS a session id — the first instant the flag can be guessed wrong.
    await startSessionIn(p, 'ws-a')
    await expect.poll(() => layoutState(p)).toBe('T1')
    await waitGitQuiet(env, { root: ws })
    expect(countGitSpawns(env, { root: ws, subcommand: WORKBENCH_GIT })).toBe(0)

    await clickAppMenuItem(relaunched.app, p, 'toggle-browser')
    await expect.poll(() => layoutState(p)).toBe('T2')
    await showChanges(p)
    await waitStream(p, 2)
    expect(countGitSpawns(env, { root: ws, subcommand: WORKBENCH_GIT })).toBeGreaterThan(0)
  } finally {
    await relaunched.app.close().catch(() => {})
  }
})

// ---- WB-C18 ------------------------------------------------------------------------------

// WB-C18 (FR-51,) — a collapsed panel FORGETS its change set, so the next
// session to expand one on this worktree reads afresh instead of inheriting the last
// visit's rows and diffs.
//
// The route this closes: FR-51 stops the watcher and every git process the moment the
// panel leaves the screen, so from then on the map can only go stale — and a NEW session
// on the same worktree starts collapsed (WB-L11), so its first expand painted whatever
// the previous session left, as if it were this session's reading, until the catch-up
// fetch landed. WB-K08 pins the catch-up; this pins that there is nothing stale to paint
// before it.
//
// The assertion carrying the case is the row count of ZERO while the panel is collapsed.
// The panel is a singleton that never unmounts, so the rows it held are still in the DOM
// at width 0 — unless the collapse dropped them. Every assertion after it passes against a
// build that merely refreshes on expand, because the refresh lands inside any poll
// interval; that one fails only in the state where the stale set is still there to be
// painted.
test('WB-C18: a collapsed panel forgets its change set, so a new session reads afresh', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const fx = setupChangeFixture(env.workspaces.a)
  fx.modifyTracked(2)
  await openChanges(page)
  await waitStream(page, 2)

  await clickAppMenuItem(app, page, 'toggle-browser')
  await expect.poll(() => layoutState(page)).toBe('T1')
  await expect(rows(page)).toHaveCount(0)

  // the worktree moves on while nothing is watching: the two edits get committed and a
  // new file appears, so the honest set is now ONE row that the old map never held
  fx.commitAll('while collapsed')
  fx.addUntracked('src/next-session.ts')

  // a new session on the same worktree: its Changes half shows exactly the new set —
  // never the two old rows, and never their diffs under the new list
  await startSessionIn(page, 'ws-a')
  await showChanges(page)
  await waitStream(page, 1)
  expect(await shownPaths(page)).toEqual(['src/next-session.ts'])
})

// ---- the left column: its width, and names it cuts off -----------------------------------

// The file list's width is the reader's to set — ONE number for both halves,
// kept across a relaunch — and a name the column cuts off slides under the pointer so the
// whole of it can be read without waiting on a tooltip. Two measurements carry the case:
// the column's width after the drag (a build that ignores the grip leaves the default), and
// the label's negative `--fs-shift` under hover (a build without the slide never sets the
// class, so `title` alone would still pass every visibility check).
test('the file list drags wider, both halves and a relaunch keep the width, and a clipped name slides under the pointer', async ({
  app,
  page,
  env
}) => {
  test.slow()
  const fx = setupChangeFixture(env.workspaces.a)
  const LONG = 'src/a-very-long-file-name-that-the-column-cannot-show-in-full-at-all.ts'
  fx.addUntracked(LONG)
  await openChanges(page)
  await waitStream(page, 1)

  const width = (loc: Locator): Promise<number> =>
    loc.evaluate((el) => Math.round(el.getBoundingClientRect().width))
  const side = page.locator('.wb-panel .cv-side')
  expect(await width(side)).toBe(230)

  // The width lands where the pointer is released, measured from the column's left edge —
  // so the target is derived from the pointer, not from "230 + 60": the grip's hit area is
  // wider than the line it sits on, and its centre is not the line. The reading column keeps
  // 240px whatever the drag asks for, so the target is clamped to what this panel can give
  // (the panel's default is wide enough for the full +60).
  const fv = (await page.locator('.wb-panel .fv').boundingBox())!
  const grip = page.locator('.wb-panel .fv-gutter')
  const box = (await grip.boundingBox())!
  // whole pixels, so the pointer position the app sees is the one the target is computed from
  const gx = Math.round(box.x + box.width / 2)
  const gy = Math.round(box.y + box.height / 2)
  const want = Math.min(Math.round(gx + 60 - fv.x), Math.round(fv.width) - 240)
  await page.mouse.move(gx, gy)
  await page.mouse.down()
  await page.mouse.move(gx + 60, gy, { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => width(side)).toBe(want)

  // the other half shares the number
  await showBrowse(page)
  expect(await width(page.locator('.wb-panel .fv-tree'))).toBe(want)

  // a relaunch keeps it
  await app.close().catch(() => {})
  const next = await launchApp(env)
  const page2 = await next.firstWindow()
  await page2.waitForLoadState('domcontentloaded')
  await waitBooted(page2)
  await openChanges(page2)
  await waitStream(page2, 1)
  expect(await width(page2.locator('.wb-panel .cv-side'))).toBe(want)

  // the long name is still cut off at that width, and hovering its row slides it
  const name = rowOf(page2, LONG).locator('.ft-name')
  expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  await rowOf(page2, LONG).hover()
  await expect(name).toHaveClass(/\bfs-slide\b/)
  expect(
    await name.evaluate((el) => parseFloat(el.style.getPropertyValue('--fs-shift')))
  ).toBeLessThan(0)
  // leaving the row puts it back
  await page2.locator('.wb-panel .cv-total').hover()
  await expect(name).not.toHaveClass(/\bfs-slide\b/)

  await next.close().catch(() => {})
})

// WB-K08c (FR-51,) — the collapsed-panel rule across a SWITCH. Leaving a session
// whose panel is open for one whose panel is collapsed lands the panel on the target two
// frames after the click (App's `landedTab`), and for those two frames the panel's
// collapse itself is what lags (`panelVisible`). The lag must belong to the tab that is
// collapsing: told it was still visible with the target's root in hand, the panel fetched
// the target's change set and installed a watcher, then threw both away — a spawn for a
// workspace whose panel is shut, which is exactly what WB-K08 forbids. Found by code review.
test('WB-K08c: switching to a session with a collapsed panel spawns no git for its workspace', async ({
  app,
  env
}) => {
  test.setTimeout(240_000)
  setupChangeFixture(env.workspaces.a).modifyTracked(1)
  setupChangeFixture(env.workspaces.b).modifyTracked(1)
  const { app: p1app, page } = await relaunchWithGitLog(app, env)
  try {
    setNextSessionTitle(env, 'S1')
    await startSessionIn(page, 'ws-a')
    await showChanges(page)
    await waitStream(page, 1)
    setNextSessionTitle(env, 'S2')
    await startSessionIn(page, 'ws-b')
    // S2: panel collapsed (main hands a new session the last state the user chose)
    if (await workbenchPanel(page).isVisible()) await workbenchIcon(page).click()
    await expect.poll(() => layoutState(page)).toBe('T1')
    // back to S1, whose panel is open, and let its own refresh settle
    await page.locator('.ws-tab', { has: page.locator('.ws-tab-title', { hasText: 'S1' }) }).click()
    await expect.poll(() => layoutState(page)).toBe('T2')
    await waitStream(page, 1)
    const before = await waitGitQuiet(env, { root: env.workspaces.b })

    // the case: S1 (open) → S2 (collapsed)
    await page.locator('.ws-tab', { has: page.locator('.ws-tab-title', { hasText: 'S2' }) }).click()
    await expect.poll(() => layoutState(page)).toBe('T1')
    await page.waitForTimeout(3000)
    expect(countGitSpawns(env, { root: env.workspaces.b })).toBe(before)
  } finally {
    await p1app.close().catch(() => {})
  }
})
