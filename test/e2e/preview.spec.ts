import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import {
  centerTerm,
  gitCommitAll,
  gitInit,
  runIn,
  startSessionIn,
  waitBooted,
  wsRows
} from './helpers/p1'
import { artifactBody, openFileTab, WORKBENCH } from './helpers/workbench'
import { openTabs, pinnedTab } from './helpers/browser'
import type { E2EEnv } from './helpers/env'

/**
 * Artifact rendering, driven through the real UI (built app) — FR-30…FR-33
 *, i.e. the
 * WB-R01/R02/R04/R05 cases:
 *  R1 — an artifact survives switching tabs, scroll position intact (per tab, kept mounted)
 *  R2 — a markdown file opens on its Rendered view even when it has a diff (+ FR-31's header)
 *  R3 — a CHANGED code file opens on Diff, showing the whole file with its adds/dels inline
 *  R3b — an UNCHANGED code file opens on Source, with Diff offered but disabled
 *  R4 — a markdown artifact auto-refreshes when the file changes on disk (no interaction)
 *  R5 — a code artifact auto-refreshes in place, scroll position intact
 *  R6 — a pdf never auto-reloads: a notice bar offers Reload / Dismiss, and so does ↻
 *
 * Surface migration: the aux column's single-file Preview pane is gone. Artifacts render
 * inside the Workbench, either in a `file` tab or in the pinned `files` tab's Browse
 * reading area. Both mount the same `ArtifactPane`, so the rendering contract below holds
 * on either; it is pinned to the `file` tab because that is the surface FR-30/FR-31 define
 * the HEADER on, and because ＋ ▸ "Open file…" reaches it without going through Browse.
 *
 * The one assertion that could NOT be carried over is the old Content/Diff toggle: `view`
 * went from two states to three (FR-30's Rendered / Diff / Source), so "code has no
 * toggle at all" is re-expressed as R3/R3b — code gets a two-wide segment whose Diff goes
 * DISABLED rather than vanishing.
 *
 * The panel is per session, so every case starts one; the fixtures it reads are written
 * straight to disk (a watcher cannot tell a test's write from anyone else's).
 *
 * These exercise the built renderer end to end, so they need `npm run build` + `npm run
 * rebuild` first (the standard e2e prerequisite).
 */

/** A repo whose fixture files are all committed — the baseline a diff is read against. */
function committedRepo(dir: string): void {
  gitInit(dir)
  gitCommitAll(dir)
}

const numberedLines = (n: number): string =>
  Array.from({ length: n }, (_, i) => String(i + 1)).join('\n') + '\n'

// ---- the panel's own controls (FR-31's kind bar) --------------------------------------

/** FR-31's path label: parent directories relative to the workspace root, then the name. */
function artifactTitle(page: Page): Locator {
  return page.locator(WORKBENCH.artifactTitle)
}

/** FR-30/FR-31's `[ Rendered | Diff | Source ]`. Two-wide for code, absent for image/pdf. */
function viewSegment(page: Page): Locator {
  return page.locator(WORKBENCH.viewSeg).locator('button')
}

/** Which view is on screen — the segment's own pressed state, not a guess from content. */
function activeView(page: Page): Locator {
  return page.locator(WORKBENCH.viewSegOn)
}

/**
 * Open a workspace file as a `file` tab the way a user does (FR-52's ＋ ▸ "Open file…"),
 * then pin FR-31's path form: the label carries the parent directories relative to the
 * workspace root, which is the half `openFileTab` itself cannot know.
 *
 * ＋ ▸ "Open file…" is the route taken here on purpose: FR-10's own routes (a Browse row,
 * a Changes row) render into the `files` tab's reading area instead, and FR-12's ↗ New tab
 * needs a Changes row to split off — both would make the fixture depend on the Files half
 * rather than on the artifact this file is about.
 */
async function openArtifact(page: Page, env: E2EEnv, rel: string): Promise<void> {
  await openFileTab(page, env, path.join(env.workspaces.a, rel))
  await expect(artifactTitle(page)).toHaveText(rel, { timeout: 30_000 })
}

// WB-R01 + WB-R02 (FR-30, FR-31) — markdown routes to Rendered even when it HAS a diff, and
// the single-artifact header carries all five elements FR-31 names.
test('a markdown file opens on its Rendered view, not a diff (R2)', async ({ page, env }) => {
  test.setTimeout(120_000)
  // make ws-a a repo and modify README.md so it HAS a diff — the point is that even a changed
  // markdown file still defaults to Rendered, and merely offers Diff alongside.
  committedRepo(env.workspaces.a)
  fs.appendFileSync(path.join(env.workspaces.a, 'README.md'), '\nmore alpha content\n')

  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await openArtifact(page, env, 'README.md')

  // FR-30: the default view is the rendered markdown, NOT the inline diff
  await expect(artifactBody(page).locator('.md-body')).toContainText('koloft-e2e-alpha', {
    timeout: 15_000
  })
  await expect(artifactBody(page).locator('.idiff')).toHaveCount(0)

  // FR-31's header, all five elements: path · git status · ±N · the three-way segment · ↻ · ≡
  const bar = page.locator(WORKBENCH.kindBar)
  await expect(bar.locator('.ft-gbadge')).toHaveText('M', { timeout: 20_000 })
  await expect(bar.locator('.ft-delta .add')).toContainText('+')
  await expect(viewSegment(page)).toHaveText(['Rendered', 'Diff', 'Source'])
  await expect(activeView(page)).toHaveText('Rendered')
  await expect(page.locator(WORKBENCH.reload)).toBeVisible()
  await expect(page.locator(WORKBENCH.outline)).toBeVisible()

  // …and the three segments are mutually exclusive, each really swapping the body
  await viewSegment(page).nth(1).click()
  await expect(artifactBody(page).locator('.idiff')).toBeVisible({ timeout: 15_000 })
  await expect(artifactBody(page).locator('.md-body')).toHaveCount(0)
  await expect(activeView(page)).toHaveText('Diff')

  await viewSegment(page).nth(2).click()
  await expect(artifactBody(page).locator('.code-body')).toBeVisible({ timeout: 15_000 })
  await expect(artifactBody(page).locator('.idiff')).toHaveCount(0)
  await expect(activeView(page)).toHaveText('Source')
})

// WB-R01 (FR-30) — a CHANGED code file lands on Diff, as the whole file with its changes
// inline. Code has no typeset form, so the segment is two-wide: Rendered never appears.
test('a changed code file opens as the whole file with its diff inline (R3)', async ({
  page,
  env
}) => {
  test.setTimeout(120_000)
  committedRepo(env.workspaces.a)
  // change the one committed line AND append a new one, so the inline view must show
  // a deletion (old line, red), an addition (new line, green), and a tail addition.
  fs.writeFileSync(
    path.join(env.workspaces.a, 'src', 'app.ts'),
    'export const answer = 43\nexport const added = true\n'
  )

  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await openArtifact(page, env, 'src/app.ts')

  const idiff = artifactBody(page).locator('.idiff')
  await expect(idiff).toBeVisible({ timeout: 15_000 })
  await expect(viewSegment(page)).toHaveText(['Diff', 'Source'])
  await expect(activeView(page)).toHaveText('Diff')
  // a removed line (old value) in red and an added line (new value) in green are both
  // present. Target each expected line individually: the diff legitimately renders TWO
  // add-rows here, so a bare `.idiff-add` locator is ambiguous under strict mode.
  await expect(idiff.locator('.idiff-del')).toContainText('42')
  await expect(idiff.locator('.idiff-add', { hasText: 'answer = 43' })).toBeVisible()
  await expect(idiff.locator('.idiff-add', { hasText: 'added = true' })).toBeVisible()
})

// WB-R01 (FR-30) — the other branch of the same routing rule, and the replacement for the
// retired "code has no view toggle at all". Diff stays IN the segment and goes DISABLED:
// a control that appears and disappears as the agent edits the file underneath is a moving
// target for the pointer.
test('an unchanged code file opens on Source, with Diff offered but disabled (R3b)', async ({
  page,
  env
}) => {
  test.setTimeout(120_000)
  committedRepo(env.workspaces.a)

  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await openArtifact(page, env, 'src/app.ts')

  await expect(artifactBody(page).locator('.code-body')).toContainText('answer', {
    timeout: 15_000
  })
  await expect(viewSegment(page)).toHaveText(['Diff', 'Source'])
  await expect(activeView(page)).toHaveText('Source')
  await expect(viewSegment(page).nth(0)).toBeDisabled()
  await expect(artifactBody(page).locator('.idiff')).toHaveCount(0)
  // an unchanged file carries no git letter and no ±N either — the header's other three
  // elements are still there
  await expect(page.locator(`${WORKBENCH.kindBar} .ft-gbadge`)).toHaveCount(0)
  await expect(page.locator(`${WORKBENCH.kindBar} .ft-delta`)).toHaveCount(0)
  await expect(page.locator(WORKBENCH.reload)).toBeVisible()
})

// NFR-03's reason, applied to an artifact (R1) — an inactive tab is hidden with
// `visibility` and never `display`, because a subtree with no layout box cannot hold a
// scroll offset. The session round trip is the second half: only the session on screen
// keeps its artifacts mounted, so the tab comes back with its document but at the top.
test('an artifact survives switching to another tab and back, scroll position intact (R1)', async ({
  page,
  env
}) => {
  test.setTimeout(150_000)
  // a long text file so the Source view actually scrolls
  fs.writeFileSync(path.join(env.workspaces.a, 'long.txt'), numberedLines(400))

  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await openArtifact(page, env, 'long.txt')

  const codeBody = artifactBody(page).locator('.code-body')
  await expect(codeBody).toBeVisible({ timeout: 15_000 })
  await codeBody.evaluate((el) => {
    el.scrollTop = 1200
  })
  await expect.poll(() => codeBody.evaluate((el) => el.scrollTop)).toBe(1200)

  // away to the pinned `files` tab: the artifact is off screen but still mounted…
  await pinnedTab(page).click()
  await expect(codeBody).toBeHidden()

  // …and back on its own tab, both the content and the reading position are as they were
  await openTabs(page).first().click()
  await expect(artifactTitle(page)).toHaveText('long.txt', { timeout: 15_000 })
  await expect.poll(() => codeBody.evaluate((el) => el.scrollTop)).toBe(1200)

  // a second session takes the screen. ws-b so its row can never be confused with the
  // first session's. Only the session on screen keeps its artifacts mounted, so A's
  // leaves the DOM entirely — which is why the scroll clause stops here.
  await startSessionIn(page, 'ws-b')
  await expect(page.locator(WORKBENCH.artifact)).toHaveCount(0)

  // back on A the tab is still on the strip and still renders its file
  await wsRows(page, 'ws-a').first().click()
  await expect(artifactTitle(page)).toHaveText('long.txt', { timeout: 20_000 })
  await expect(artifactBody(page).locator('.code-body')).toContainText('400', { timeout: 20_000 })
})

// WB-R04 (FR-33) — a disk change reloads the artifact in place, with no interaction and no
// whole-page Loading placeholder in between.
test('a markdown artifact auto-refreshes when the file changes on disk (R4)', async ({
  page,
  env
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await openArtifact(page, env, 'README.md')

  const mdBody = artifactBody(page).locator('.md-body')
  await expect(mdBody).toContainText('koloft-e2e-alpha', { timeout: 15_000 })
  // FR-31: the manual reload entry point is in the kind bar
  await expect(page.locator(WORKBENCH.reload)).toBeVisible()

  // change the file on disk — the artifact must pick it up with NO further interaction
  fs.appendFileSync(path.join(env.workspaces.a, 'README.md'), 'freshline-koloft-e2e\n')
  await expect(mdBody).toContainText('freshline-koloft-e2e', { timeout: 10_000 })
})

// WB-R04 (FR-33) — the same reload for the Source view, and the half the requirement is
// actually about: "in place, preserving scroll position".
test('a code artifact auto-refreshes in place, scroll position intact (R5)', async ({
  page,
  env
}) => {
  test.setTimeout(120_000)
  const long = path.join(env.workspaces.a, 'long.txt')
  fs.writeFileSync(long, numberedLines(400))

  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await openArtifact(page, env, 'long.txt')

  const codeBody = artifactBody(page).locator('.code-body')
  await expect(codeBody).toBeVisible({ timeout: 15_000 })
  await codeBody.evaluate((el) => {
    el.scrollTop = 1200
  })
  await expect.poll(() => codeBody.evaluate((el) => el.scrollTop)).toBe(1200)

  // append on disk: the new content shows up in place, without dropping back through a
  // loading state (which would reset the scroll position we just took)
  fs.appendFileSync(long, 'tail-marker-e2e\n')
  await expect(codeBody).toContainText('tail-marker-e2e', { timeout: 10_000 })
  await expect.poll(() => codeBody.evaluate((el) => el.scrollTop)).toBe(1200)
})

// WB-R05 (FR-33) — the pdf exception: a reload loses PDFium's page position irrecoverably,
// so a disk change only raises a notice and asks first. The kind bar's ↻ is the manual
// route the same requirement names, and it is asserted here because a pdf is the one kind
// where ↻ is falsifiable — nothing else reloads it.
test('a pdf never auto-reloads — a notice offers Reload / Dismiss, and so does ↻ (R6)', async ({
  page,
  env
}) => {
  test.setTimeout(120_000)
  // a minimal (even invalid) pdf is enough: the notice logic is pane-level and must not
  // depend on whether PDFium managed to render the guest
  const pdfPath = path.join(env.workspaces.a, 'tiny.pdf')
  fs.writeFileSync(pdfPath, '%PDF-1.4\n%%EOF\n')

  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await openArtifact(page, env, 'tiny.pdf')

  // FR-30 routes a pdf to the preview: there is no view to choose between, so the segment
  // is absent entirely rather than rendered empty
  await expect(page.locator(WORKBENCH.viewSeg)).toHaveCount(0)
  // `.fp-stale` is not a FilePane leftover: the notice moved into `ArtifactPane` with its
  // class intact, so it is now one per mounted artifact — hence scoped to `artifactBody`.
  const notice = artifactBody(page).locator('.fp-stale')
  await expect(notice).toHaveCount(0)

  // change it on disk → the stale notice appears INSIDE the artifact; nothing auto-reloads
  fs.appendFileSync(pdfPath, 'x')
  await expect(notice).toBeVisible({ timeout: 10_000 })
  // the notice is an overlay: the session's TUI stays usable while it shows (non-blocking)
  await runIn(page, centerTerm(page), 'ping')
  await expect(centerTerm(page)).toContainText('handled: ping', { timeout: 30_000 })
  await expect(notice).toBeVisible()

  // Reload dismisses the notice (and reloads the guest)
  await notice.locator('.fp-stale-btn').click()
  await expect(notice).toHaveCount(0)

  // a further change re-raises it; Dismiss hides it without reloading
  fs.appendFileSync(pdfPath, 'y')
  await expect(notice).toBeVisible({ timeout: 10_000 })
  await notice.locator('.fp-stale-x').click()
  await expect(notice).toHaveCount(0)

  // …and the kind bar's ↻ clears a raised notice too — FR-33's manual reload, on the one
  // kind where the automatic path deliberately does nothing
  fs.appendFileSync(pdfPath, 'z')
  await expect(notice).toBeVisible({ timeout: 10_000 })
  await page.locator(WORKBENCH.reload).click()
  await expect(notice).toHaveCount(0)
})
