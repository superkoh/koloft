import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import {
  auxIcon,
  centerTerm,
  gitCommitAll,
  gitInit,
  layoutOnDisk,
  openMenu,
  runIn,
  seedJsonl,
  startSessionIn,
  waitForCalls,
  wsRows
} from './helpers/p1'
import {
  BROWSER,
  activeKind,
  activeSurface,
  browserSurface,
  downloadedFiles,
  globeIcon,
  guestByUrl,
  guestContents,
  newWebTab,
  openBrowser,
  openTabs,
  pinnedTab,
  typeInAddressBar
} from './helpers/browser'
import {
  WORKBENCH,
  openInBrowse,
  sessionWorkbenchOnDisk,
  showBrowse,
  wbActiveTab,
  wbFrozenTabs,
  wbTabByTitle,
  wbTabTitles,
  writeLegacyV2Layout
} from './helpers/workbench'
import { startEchoServer } from './helpers/fixtureServer'

/**
 * The Workbench's Preview-retirement, persistence and session-lifecycle cluster (issue
 *; the case ids are the original case list's, and the spec
 * carrying an id IS its contract):
 *
 *   BB-M05 BB-M16 BB-M17.html renders in a `web` tab, its source/diff stays in the
 *                          reading area, and it stays in the sidebar's Preview filter
 *   BB-C49 BB-C51          what the retirement must NOT break
 *   BB-C66 BB-C39 BB-C40   the tab set surviving a kind switch, a session switch, a
 *   BB-C41 BB-C42          `/clear` id change, a cold→resume and a restart
 *   BB-C43                 archiving the viewed session
 *
 * Each test asserts exactly its case's **Then** and reads only requirement-visible
 * surfaces (the panel's own markup, the `data-surface` / `data-kind` seam, the TEST-10
 * request log, TEST-4's `KOLOFT_DOWNLOAD_DIR`) — never anything imported from src/.
 */

/** FR-02 — the pinned `files` tab is always the strip's first entry, so it is always the
 *  first label `wbTabTitles` reports. Spelled once, so the expectations below still read
 *  as "the tabs the user opened". */
const FILES_LABEL = 'Files'

/**
 * Bring the panel up. `openBrowser` chooses T1 vs T2 now rather than a surface, and the
 * panel is open by DEFAULT after the merge (`workbench.defaultOpen`, FR-06), so it is a
 * no-op more often than not.
 */
async function showWorkbench(page: Page): Promise<void> {
  await expect(globeIcon(page)).toBeVisible({ timeout: 20_000 })
  await openBrowser(page)
}

/**
 * Put a url on screen the way a user does: a fresh `web` tab from the ＋'s two-item
 * dropdown (FR-52), then its address bar. Every url gets its own tab now — the panel
 * opens on the pinned `files` tab, whose kind bar has no address field at all.
 */
async function browseTo(page: Page, url: string, title: string): Promise<void> {
  await newWebTab(page)
  await expect(page.locator(BROWSER.addressField).first()).toBeVisible({ timeout: 20_000 })
  await typeInAddressBar(page, url)
  await expect(wbTabByTitle(page, title)).toHaveCount(1, { timeout: 30_000 })
}

// ---- Preview retirement ------------------------------------------------------------

test('BB-M05: clicking an .html in Browse renders it in a foreground Browser tab', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await startSessionIn(page, 'ws-a')
  const docs = path.join(env.workspaces.a, 'docs')
  const html = path.join(docs, 'page.html')

  // Given (retargeted by FR-02/FR-06): the panel is up on the pinned `files` tab — the
  // merge made that the resting state — and the strip holds no `web` tab yet
  await showWorkbench(page)
  await expect(openTabs(page)).toHaveCount(0)
  expect(await activeKind(page)).toBe('files')

  await openInBrowse(page, html)

  // FR-11 — the panel swaps to the `web` kind rather than opening a second surface
  await expect(browserSurface(page)).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('web')

  // …with a FOREGROUND tab that loaded the file over file://, rendered
  await expect(wbActiveTab(page)).toHaveCount(1)
  await expect(openTabs(page)).toHaveCount(1)
  const guest = await guestByUrl(app, html)
  expect(guest.url().startsWith('file://')).toBe(true)
  await expect(guest.locator('#top')).toHaveText('koloft-e2e-page-html', { timeout: 20_000 })

  // internal anchors work and back/forward are available
  await guest.locator('#to-anchor').click()
  await expect.poll(() => guest.evaluate(() => location.hash), { timeout: 15_000 }).toBe('#section')
  await expect
    .poll(
      () =>
        page
          .locator(`${BROWSER.addressBar} [aria-label="Back"]`)
          .evaluate((el) => (el as HTMLButtonElement).disabled),
      { timeout: 15_000 }
    )
    .toBe(false)

  // …and it did not open in the reading area
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveCount(0)
})

// FR-48 keeps the retiring tree's row context menu verbatim (`.ft-ctx` / `.ft-ctx-it`),
// Browse's rows included, so the gesture is unchanged — only the surface it is made on
// moved. The segmented control under it did NOT survive unchanged; §Architecture's
// mount-strategy callout is explicit that this is a contract change, not a port:
//   "Note `view` goes from today's 2 states (content / diff, FilePane.tsx:278) to 3
//    (Rendered | Diff | Source) — this layer is NOT a logic-preserving move."
// An .html is a non-markdown kind, so FR-30 offers it [ Diff | Source ] — the same two
// shapes the former pane spelled Content·Diff, renamed and in the other order. Hence the
// segments are driven BY TEXT below: their positions no longer mean what they meant.
test('BB-M16: View source on an .html opens its source and diff in the reading area', async ({
  page,
  env
}) => {
  test.setTimeout(180_000)
  // an .html in the tree that HAS git modifications
  gitInit(env.workspaces.a)
  gitCommitAll(env.workspaces.a)
  const html = path.join(env.workspaces.a, 'docs', 'page.html')
  fs.appendFileSync(html, '<!-- koloft-e2e-html-edit -->\n')
  await startSessionIn(page, 'ws-a')

  // reveal the row without opening it: a plain click on an .html leaves for a `web` tab
  // (FR-11), which is exactly what "View source" exists to bypass
  await showBrowse(page)
  await page
    .locator(`${WORKBENCH.panel} .ft-node.ft-dir[data-path="${path.dirname(html)}"]`)
    .click({ timeout: 30_000 })
  await page
    .locator(`${WORKBENCH.panel} .ft-node.ft-file[data-path="${html}"]`)
    .click({ button: 'right', timeout: 30_000 })
  // the menu is portalled to document.body and position:fixed — root it at the page
  await page.locator('.ft-ctx-it', { hasText: 'View source' }).click({ timeout: 20_000 })

  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('docs/page.html', {
    timeout: 20_000
  })

  // …with a working [ Diff | Source ] segmented control. The file is modified, so FR-30's
  // default lands on Diff; Source is the shape that shows the TEXT (markup readable in the
  // host DOM, not rendered).
  const segs = page.locator(
    `${WORKBENCH.panel} .fv-artifact-hd .seg[aria-label="View mode"] button`
  )
  await expect(segs).toHaveText(['Diff', 'Source'])
  await expect(page.locator(`${WORKBENCH.readingBody} .idiff`)).toContainText(
    'koloft-e2e-html-edit',
    {
      timeout: 20_000
    }
  )
  await segs.filter({ hasText: 'Source' }).click()
  await expect(page.locator(`${WORKBENCH.readingBody} .idiff`)).toHaveCount(0)
  await expect(page.locator(WORKBENCH.readingBody)).toContainText('<h1 id="top">', {
    timeout: 20_000
  })
  await segs.filter({ hasText: 'Diff' }).click()
  await expect(page.locator(`${WORKBENCH.readingBody} .idiff`)).toContainText(
    'koloft-e2e-html-edit'
  )
})

// RETARGETED by the tree's retirement. The sidebar tree's "Preview" filter chip went with
// the tree; Browse, which replaced it, filters nothing at all — so re-aiming this case
// there would give it a surface that cannot fail for its own reason. The claim it carries
// — "a filter that means viewable content must not drop .html just because .html no longer
// previews in-app" — survives as FR-40's Type ▸ Docs group, whose `isDocPath` counts html
// as a doc while FR-11 still routes it to a `web` tab. That is the surface asserted here.
test('BB-M17: .html files stay visible under the Files tab’s Docs filter', async ({
  page,
  env
}) => {
  test.setTimeout(180_000)
  // Changes needs a repo to have anything to list at all (WB-C13's "Not a git repository"
  // is the other branch); with no commit every fixture file reads as untracked, which is
  // all this case needs.
  gitInit(env.workspaces.a)
  await startSessionIn(page, 'ws-a')

  // the session's touched files now include an .html (startup NOTES.md is the first)
  await runIn(page, centerTerm(page), '/write docs/report.html')
  const report = page.locator(`${WORKBENCH.panel} .cv-row[data-path="docs/report.html"]`)
  const code = page.locator(`${WORKBENCH.panel} .cv-row[data-path="src/app.ts"]`)
  await expect(report).toHaveCount(1, { timeout: 40_000 })
  await expect(code).toHaveCount(1)

  // Filter ▾ ▸ Type ▸ Docs
  await page.locator(`${WORKBENCH.kindBar} .seg button`, { hasText: 'Filter' }).click()
  await page.locator('.fv-filters .ft-chip[data-chip="docs"]').click({ timeout: 20_000 })

  // the .html survived the filter — and the filter really is on, which is what the code
  // file's disappearance proves
  await expect(report).toHaveCount(1)
  await expect(report).toBeVisible()
  await expect(code).toHaveCount(0)

  // …and clicking the row anchors its diff like any other row (since), while
  // the block's `↗ New tab` is the route to a `web` tab — never to the reading area
  await report.click()
  await expect(report).toHaveClass(/\bactive\b/, { timeout: 20_000 })
  expect(await activeKind(page)).toBe('files')
  await page.locator(`${WORKBENCH.panel} .cv-blk[data-path="docs/report.html"] .cv-split`).click()
  await expect(browserSurface(page)).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('web')
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveCount(0)
})

// RETARGETED by the merge (NFR-06): the case's Given — a layout.json written before the
// Browser existed — is now a layout.json written before the MERGE existed, i.e. a genuine
// v2 document with the former `aux` block and `auxMode`. WB-P03 owns the JSON-level
// migration; what stays this case's own is the behavioural half it always asserted: after
// reading such a document the panel renders normally instead of spinning empty.
test('BB-C49: a pre-merge (v2) layout.json loads and the panel works', async ({ env }) => {
  test.setTimeout(240_000)
  const id = seedJsonl(env, env.workspaces.a, { summary: 'Old layout session' })

  // the pre-merge shape, verbatim. The pinned workspaces are carried over from what the
  // env fixture wrote — a v2 document with an empty `workspaces` boots onto the "no
  // workspace yet" panel, where the case would pass for the wrong reason.
  writeLegacyV2Layout(env, {
    version: 2,
    workspaces: (layoutOnDisk(env).workspaces ?? []) as { path: string }[],
    aux: { defaultMode: 'preview' },
    sessions: { [id]: { auxMode: 'preview' } }
  })

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // it starts without error
    await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
    const row = page.locator('.ws-tab', { hasText: 'Old layout session' })
    await expect(row).toBeVisible({ timeout: 40_000 })

    // the session's own entry survived the version bump rather than being dropped — and
    // lands COLLAPSED: v4 reads a v2 `auxMode` as the seeded value it was,
    // never as the user's own expand (WB-P03 owns the JSON-level rules)
    await expect
      .poll(() => sessionWorkbenchOnDisk(env, id)?.open ?? null, { timeout: 30_000 })
      .toBe(false)
    expect(layoutOnDisk(env).version).toBe(4)

    // …and the panel renders normally instead of spinning empty
    await row.click()
    await expect(auxIcon(page, 'Workbench')).toHaveAttribute('aria-disabled', 'false', {
      timeout: 60_000
    })
    await showWorkbench(page)
    await openInBrowse(page, path.join(env.workspaces.a, 'README.md'))
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.md', { timeout: 30_000 })
    await expect(browserSurface(page)).toBeVisible()
    await expect(page.locator(WORKBENCH.readingBody)).toContainText('koloft-e2e-alpha')
  } finally {
    await app.close().catch(() => {})
  }
})

// The two-segment Content·Diff control became FR-31's [ Rendered | Diff | Source ]. That
// is a contract change the spec states outright, in §Architecture's mount-strategy callout:
//   "Note `view` goes from today's 2 states (content / diff, FilePane.tsx:278) to 3
//    (Rendered | Diff | Source) — this layer is NOT a logic-preserving move."
// README.md is markdown, so it gets all three; a code file would get two. The roster is
// asserted by CONTENTS and the clicks are BY TEXT, because a segment's index no longer
// means the same thing from one file kind to the next. What the case asserts is unchanged:
// markdown typesets, the diff is reachable, and going back really removes the diff rather
// than layering it under the rendered body.
test('BB-C51: markdown still renders in the reading area with a working view control', async ({
  page,
  env
}) => {
  test.setTimeout(180_000)
  gitInit(env.workspaces.a)
  gitCommitAll(env.workspaces.a)
  const readme = path.join(env.workspaces.a, 'README.md')
  fs.appendFileSync(readme, '\nkoloft-e2e-md-edit\n')
  await startSessionIn(page, 'ws-a')

  await openInBrowse(page, readme)

  // it renders as markdown
  await expect(page.locator(`${WORKBENCH.readingBody} .md-body`)).toContainText(
    'koloft-e2e-alpha',
    {
      timeout: 20_000
    }
  )

  // …with a working segmented control
  const segs = page.locator(
    `${WORKBENCH.panel} .fv-artifact-hd .seg[aria-label="View mode"] button`
  )
  await expect(segs).toHaveText(['Rendered', 'Diff', 'Source'])
  await segs.filter({ hasText: 'Diff' }).click()
  await expect(page.locator(`${WORKBENCH.readingBody} .idiff`)).toContainText(
    'koloft-e2e-md-edit',
    {
      timeout: 20_000
    }
  )
  await segs.filter({ hasText: 'Rendered' }).click()
  await expect(page.locator(`${WORKBENCH.readingBody} .md-body`)).toContainText('koloft-e2e-alpha')
  await expect(page.locator(`${WORKBENCH.readingBody} .idiff`)).toHaveCount(0)
})

// ---- the tab set across aux toggles, session switches and id changes ----------------

// RETARGETED by the merge: "the Eye and the Globe are mutually exclusive" retired with the
// two-pane aux column (FR-55 — one icon, one panel). Its invariant did NOT retire, it moved
// down a level: leaving the web surface and coming back keeps the tab set intact. The
// post-merge way to leave it is a kind switch inside the one strip — `files` and back — so
// that is what this case drives now.
test('BB-C66: switching to the Files tab and back keeps the web tab set', async ({ page }) => {
  test.setTimeout(240_000)
  const srv = await startEchoServer()
  try {
    await startSessionIn(page, 'ws-a')
    await showWorkbench(page)
    await browseTo(page, srv.url('/a'), 'Page A')
    await browseTo(page, srv.url('/b'), 'Page B')
    expect(await wbTabTitles(page)).toEqual([FILES_LABEL, 'Page A', 'Page B'])

    // away: the pinned `files` tab takes the panel over, and the web chrome goes with it
    await pinnedTab(page).click()
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
    await expect(page.locator(BROWSER.addressField)).toHaveCount(0)

    // …and back
    await wbTabByTitle(page, 'Page B').click()
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('web')

    expect(await wbTabTitles(page)).toEqual([FILES_LABEL, 'Page A', 'Page B'])
  } finally {
    await srv.close()
  }
})

test('BB-C39: switching away and back preserves the tab set and the current page', async ({
  page
}) => {
  test.setTimeout(300_000)
  const srv = await startEchoServer()
  try {
    await startSessionIn(page, 'ws-a')
    await startSessionIn(page, 'ws-b')
    const rowA = wsRows(page, 'ws-a').first()
    const rowB = wsRows(page, 'ws-b').first()

    await rowA.click()
    await showWorkbench(page)
    await browseTo(page, srv.url('/a'), 'Page A')
    await browseTo(page, srv.url('/b'), 'Page B')
    await wbTabByTitle(page, 'Page A').click()
    await expect(wbActiveTab(page).locator(BROWSER.tabLabel)).toHaveText('Page A')

    await rowB.click()
    await expect(rowB).toHaveClass(/\bactive\b/, { timeout: 20_000 })
    await rowA.click()
    await expect(rowA).toHaveClass(/\bactive\b/, { timeout: 20_000 })
    await showWorkbench(page)

    expect(await wbTabTitles(page)).toEqual([FILES_LABEL, 'Page A', 'Page B'])
    await expect(wbActiveTab(page).locator(BROWSER.tabLabel)).toHaveText('Page A')
  } finally {
    await srv.close()
  }
})

test('BB-C40: /clear carries the browser subtree onto the new session id', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  const srv = await startEchoServer()
  try {
    await startSessionIn(page, 'ws-a')
    const [call] = await waitForCalls(env, 1)
    await showWorkbench(page)
    await browseTo(page, srv.url('/a'), 'Page A')
    await browseTo(page, srv.url('/b'), 'Page B')

    // both guests are really loaded before the id changes — the baseline the D8
    // assertions below are measured against (the BB-C37 technique: a request count is
    // the only honest oracle for "was this page fetched again"), and their webContents
    // ids are the second half: a guest that was RECYCLED and never reloaded leaves the
    // count untouched too, so the count alone cannot see it go
    await expect.poll(() => srv.count('/a'), { timeout: 20_000 }).toBe(1)
    await expect.poll(() => srv.count('/b'), { timeout: 20_000 }).toBe(1)
    await guestByUrl(app, '/a')
    await guestByUrl(app, '/b')
    const guestIdsBefore = (await guestContents(app))
      .filter((g) => /\/[ab]$/.test(g.url))
      .map((g) => g.id)
      .sort()
    expect(guestIdsBefore).toHaveLength(2)

    await runIn(page, centerTerm(page), '/clear')

    // the session rebinds under a brand-new id (the layout registration is the id's
    // black-box arrival point)
    let newId = ''
    await expect
      .poll(
        () => {
          const ids = Object.keys(layoutOnDisk(env).sessions as Record<string, unknown>)
          newId = ids.find((i) => i !== call.sessionId) ?? ''
          return newId
        },
        { timeout: 60_000 }
      )
      .not.toBe('')

    await showWorkbench(page)
    expect(await wbTabTitles(page)).toEqual([FILES_LABEL, 'Page A', 'Page B'])

    // D8/R10 — the panel hangs off the CONVERSATION TAB now, not off the Claude
    // session id, so a `/clear` costs the live guests nothing. The strip surviving
    // (above) never proved that on its own: the tab set was carried across the id change
    // while the guests behind it were free to be recycled, which a label list cannot see.
    //
    // The webContents ids are the assertion carrying this half. `id` is a per-process
    // handle — a recycled guest comes back with a new one, or does not come back at all —
    // so the SAME two ids is the only statement that means "these pages were never
    // touched". The request counts sit beside them for the other failure shape, a guest
    // kept but reloaded in place. Held for a beat first: what is merely LATE still counts.
    await page.waitForTimeout(5000)
    expect(srv.count('/a')).toBe(1)
    expect(srv.count('/b')).toBe(1)
    const guestIdsAfter = (await guestContents(app))
      .filter((g) => /\/[ab]$/.test(g.url))
      .map((g) => g.id)
      .sort()
    expect(guestIdsAfter).toEqual(guestIdsBefore)
  } finally {
    await srv.close()
  }
})

test('BB-C41: a session that went cold resumes with its tab structure restored', async ({
  page,
  env
}) => {
  test.setTimeout(300_000)
  const srv = await startEchoServer()
  try {
    await startSessionIn(page, 'ws-a')
    const [call] = await waitForCalls(env, 1)
    await showWorkbench(page)
    await browseTo(page, srv.url('/a'), 'Page A')
    await browseTo(page, srv.url('/b'), 'Page B')
    const loadsOfA = srv.count('/a')
    const loadsOfB = srv.count('/b')

    // the session ends — a signal-driven teardown is what a closed TUI / ⌘W does to the
    // pty, and it leaves the row behind as cold (T-LIFE-15)
    const row = wsRows(page, 'ws-a').first()
    process.kill(call.pid, 'SIGHUP')
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 60_000 })

    // …and it is resumed
    await row.click()
    await expect(auxIcon(page, 'Workbench')).toHaveAttribute('aria-disabled', 'false', {
      timeout: 60_000
    })
    await showWorkbench(page)

    // the structure is back — titles in order. The old case also pinned "the FIRST tab is
    // active, since activeIndex is not persisted"; after the merge a cold→resume inside one
    // run never round-trips through disk at all (the live set is kept and re-adopted, see
    // `setWorkbenchState`), so the selection is simply where the user left it and asserting
    // it here would pin an implementation detail. The restart path is BB-C42's.
    expect(await wbTabTitles(page)).toEqual([FILES_LABEL, 'Page A', 'Page B'])
    // D8 + "a dead session is a cold session": the resume no longer re-adopts a live
    // set. The panel hangs off the CONVERSATION TAB, and a cold row resumed inside one run
    // opens a BRAND-NEW conversation tab, which reads its structure back off disk — the
    // same shape a restart produces (BB-C42), not `frozen`. `frozen` means "was live, guest
    // evicted by the cap, structure kept" (FR-24); nothing here was ever live in this tab.
    //
    // So the oracle mirrors BB-C42's: the tabs are listed and titled (above) and NOTHING
    // was fetched. THE REQUEST COUNTS ARE WHAT CARRY THE CASE — a tab quietly reloaded
    // behind the user looks identical in the strip, and no DOM class can see it. Held for
    // a beat first: what is merely LATE still counts as a reload.
    await page.waitForTimeout(5000)
    expect(srv.count('/a')).toBe(loadsOfA)
    expect(srv.count('/b')).toBe(loadsOfB)
    // `frozen` is checked only to say what these tabs are NOT. It is a consequence of the
    // above, not a decision of its own: nothing in this tab was ever live, so the class
    // that means "was live, guest evicted by the cap" cannot apply. Do not read this line
    // as the case — it would stay green through a reload.
    await expect(wbFrozenTabs(page)).toHaveCount(0, { timeout: 20_000 })

    // …and a tab loads on demand, from its stored url
    await wbTabByTitle(page, 'Page A').click()
    await expect.poll(() => srv.count('/a'), { timeout: 30_000 }).toBeGreaterThan(loadsOfA)
  } finally {
    await srv.close()
  }
})

test('BB-C42: a Koloft restart loads no tab until a session is resumed', async ({ env }) => {
  test.setTimeout(420_000)
  const srv = await startEchoServer()
  try {
    const app1 = await launchApp(env)
    try {
      const page1 = await app1.firstWindow()
      await page1.waitForLoadState('domcontentloaded')
      await expect(page1.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
      await startSessionIn(page1, 'ws-a')
      await showWorkbench(page1)
      await browseTo(page1, srv.url('/a'), 'Page A')
      await browseTo(page1, srv.url('/b'), 'Page B')
      expect(srv.count()).toBeGreaterThan(0)
    } finally {
      await app1.close().catch(() => {})
    }

    srv.reset()
    const app2 = await launchApp(env)
    try {
      const page2 = await app2.firstWindow()
      await page2.waitForLoadState('domcontentloaded')
      // the cold row is the positive barrier that startup really finished
      const row = wsRows(page2, 'ws-a').first()
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 60_000 })
      expect(srv.count()).toBe(0)

      // only after a resume does the tab structure reappear — still without loading
      await row.click()
      await expect(auxIcon(page2, 'Workbench')).toHaveAttribute('aria-disabled', 'false', {
        timeout: 60_000
      })
      await showWorkbench(page2)
      expect(await wbTabTitles(page2)).toEqual([FILES_LABEL, 'Page A', 'Page B'])
      expect(srv.count()).toBe(0)
    } finally {
      await app2.close().catch(() => {})
    }
  } finally {
    await srv.close()
  }
})

test('BB-C43: archiving the viewed session destroys its guests, not its download', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  const srv = await startEchoServer()
  try {
    await startSessionIn(page, 'ws-a')
    const [call] = await waitForCalls(env, 1)
    await showWorkbench(page)
    await browseTo(page, srv.url('/a'), 'Page A')
    await browseTo(page, srv.url('/b'), 'Page B')
    await expect
      .poll(
        async () => (await guestContents(app)).filter((g) => g.url.startsWith(srv.origin)).length,
        { timeout: 30_000 }
      )
      .toBe(2)

    // a download that is provably still in flight when the session goes away — sent from
    // the current tab's own address bar (Page B's, still the active one)
    const address = page.locator(BROWSER.addressField).first()
    await address.click()
    await address.fill(srv.url('/download-slow?name=slow.bin&ms=8000'))
    await page.keyboard.press('Enter')
    await expect.poll(() => srv.count('/download-slow'), { timeout: 30_000 }).toBe(1)

    // archive it. The row has to leave the running set first (a signal-driven teardown,
    // T-LIFE-15); "Remove from list" is the sessions:archive gesture (T-LIFE-14).
    const row = wsRows(page, 'ws-a').first()
    process.kill(call.pid, 'SIGHUP')
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 60_000 })
    await openMenu(page, row)
    await page.locator('.menu .mi', { hasText: 'Remove from list' }).click()
    await expect(row).toHaveCount(0, { timeout: 30_000 })

    // its guests are destroyed…
    await expect
      .poll(
        async () => (await guestContents(app)).filter((g) => g.url.startsWith(srv.origin)).length,
        { timeout: 30_000 }
      )
      .toBe(0)
    // …the panel goes with the session selection (FR-04: no session, no panel). Read from
    // `data-surface`, which is written only while the panel is SHOWING — `data-kind` names
    // the active tab whether or not anything is on screen, so it stays 'files' here.
    await expect(browserSurface(page)).toBeHidden()
    expect(await activeSurface(page)).toBeNull()
    // …yet the download that was already running still lands on disk
    await expect.poll(() => downloadedFiles(env), { timeout: 60_000 }).toContain('slow.bin')
  } finally {
    await srv.close()
  }
})
