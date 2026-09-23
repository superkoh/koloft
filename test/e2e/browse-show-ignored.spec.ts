import fs from 'fs'
import { test, expect, launchApp } from './helpers/app'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import type { E2EEnv } from './helpers/env'
import { startSessionIn, waitBooted } from './helpers/p1'
import { setupChangeFixture } from './helpers/filesFixture'
import { seedEditFixture } from './helpers/editFixture'
import { showBrowse, workbenchPanel } from './helpers/workbench'
import { EDIT, closeDiscardingEdits } from './helpers/editPane'

/**
 * Change one · "let the ignored files be seen",
 * BB-M01…BB-M03 — A-01…A-06).
 *
 * This half ships on its own, so it is tested on its own: nothing here opens an editor,
 * and every case fails for a tree/search reason or not at all.
 *
 * The switch means one thing: off, every ignored entry is hidden; on, EVERYTHING shows and
 * the ignored entries — directories included — are marked. So each revealed row is paired
 * with its mark, and the OFF half re-asserts the hiding, so that a build which simply
 * deleted the ignore filter fails on the second half.
 */

/** One Browse row, scoped to the tree section: the same file can be on screen three times
 *  at once (tree, Bookmarks, Recents) and a bare `[data-path]` matches all of them. */
function row(page: Page, abs: string, section = 'tree'): Locator {
  return page.locator(`.wb-panel .bv-sec[data-section="${section}"] .ft-node[data-path="${abs}"]`)
}

const chip = (page: Page): Locator => page.locator(`.wb-panel ${EDIT.showIgnored}`)
const searchToggle = (page: Page): Locator =>
  page.locator('.wb-bar .icobtn[aria-label="Search files"]')
const searchInput = (page: Page): Locator => page.locator('.wb-panel .ft-search-input')
const ctxMenu = (page: Page): Locator => page.locator(EDIT.ctxMenu)
/** The product's own "this query ran and found nothing" line — the barrier every negative
 *  search assertion below is sequenced behind. */
const noMatches = (page: Page): Locator => page.locator('.wb-panel .bv-nomatch')

async function browseReady(page: Page, root: string): Promise<void> {
  await showBrowse(page)
  await expect(row(page, root)).toBeVisible({ timeout: 30_000 })
  await expect(row(page, `${root}/config`)).toBeVisible({ timeout: 30_000 })
}

/** Relaunch against the SAME home — localStorage rides through `--user-data-dir`, which is
 *  what makes A-05's "the switch is still on" claim mean anything (pattern:
 *  workbench-browse.spec.ts). */
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

// BB-M01 (A-01, A-02, A-03, A-05) — the switch, its two exemptions, and the restart.
//
// The restarts are what make the persistence claim falsifiable: an in-memory flag satisfies
// every same-run assertion here. There are TWO of them, because on and off fail
// differently — a build that writes the slot only when the switch goes on comes back on for
// ever, and the first restart cannot see that.
//
// Persistence is read only through the switch itself, never through the storage slot behind
// it. Where the flag lives is the product's business, and a test that read the slot would
// pass on a build that wrote it correctly and never read it back — which the user
// experiences as a switch that forgets.
test('BB-M01: the Show-ignored switch reveals every ignored entry, directories included and marked, and survives a restart', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  const fx = setupChangeFixture(env.workspaces.a)
  const ed = seedEditFixture(env.workspaces.a)
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
  await browseReady(page, fx.root)

  // --- off by default (A-01), and the ignored file is simply not there
  await expect(chip(page)).toHaveText('Show ignored files')
  await expect(chip(page)).not.toHaveClass(/\bon\b/)
  await expect(row(page, ed.env)).toHaveCount(0)
  await expect(row(page, ed.venvDir)).toHaveCount(0)

  // --- on: the FILE appears, dimmed, and says why
  await chip(page).click()
  await expect(chip(page)).toHaveClass(/\bon\b/)
  await expect(row(page, ed.env)).toBeVisible({ timeout: 20_000 })
  await expect(row(page, ed.env)).toHaveClass(/\bignored\b/)
  await expect(row(page, ed.env)).toHaveAttribute('title', EDIT.ignoredTitle)

  // --- A-02/A-03: the ignored DIRECTORIES come back too, hidden until now by two different
  // mechanisms — `.venv/` and `secrets/` by `.gitignore`, `node_modules/` by fileTree's own
  // HEAVY set — each marked like the file, and closed: what is inside stays unlisted until
  // the folder is opened, and then comes marked as well.
  for (const dir of [ed.venvDir, fx.paths.ignoredDir]) {
    await expect(row(page, dir)).toBeVisible({ timeout: 20_000 })
    await expect(row(page, dir)).toHaveClass(/\bignored\b/)
    await expect(row(page, dir)).toHaveAttribute('title', EDIT.ignoredTitle)
  }
  // node_modules is not in any .gitignore here — its tooltip names the other reason
  await expect(row(page, fx.paths.heavyDir)).toBeVisible({ timeout: 20_000 })
  await expect(row(page, fx.paths.heavyDir)).toHaveClass(/\bignored\b/)
  await expect(row(page, fx.paths.heavyDir)).toHaveAttribute('title', EDIT.hiddenByDefaultTitle)
  await expect(row(page, ed.venvFile)).toHaveCount(0)
  await row(page, ed.venvDir).click()
  await expect(row(page, ed.venvFile)).toBeVisible({ timeout: 20_000 })
  await expect(row(page, ed.venvFile)).toHaveClass(/\bignored\b/)
  await row(page, ed.venvDir).click() // fold it back: the restart below should see the same tree
  await expect(row(page, `${fx.root}/docs`)).toBeVisible()

  // --- A-05, through the only door a user has: come back and look. Where the flag is kept
  // is the product's business — reading its localStorage slot from the test would assert
  // the implementation rather than the behaviour, and would go green on a build that wrote
  // the slot correctly and never read it back, which the user experiences as a switch that
  // resets itself.
  const restarted = await relaunch(app, env)
  await startSessionIn(restarted.page, 'ws-a')
  await expect(workbenchPanel(restarted.page)).toBeVisible({ timeout: 25_000 })
  await browseReady(restarted.page, fx.root)
  await expect(chip(restarted.page)).toHaveClass(/\bon\b/, { timeout: 20_000 })
  await expect(row(restarted.page, ed.env)).toBeVisible({ timeout: 25_000 })

  // …and OFF persists too, which needs its own restart: a slot that is only ever written
  // when the switch goes on comes back on for ever, and the assertion above cannot see it.
  await chip(restarted.page).click()
  await expect(row(restarted.page, ed.env)).toHaveCount(0, { timeout: 20_000 })
  // …and the directories go back into hiding with it
  await expect(row(restarted.page, ed.venvDir)).toHaveCount(0)
  await expect(row(restarted.page, fx.paths.heavyDir)).toHaveCount(0)

  const again = await relaunch(restarted.app, env)
  await startSessionIn(again.page, 'ws-a')
  await expect(workbenchPanel(again.page)).toBeVisible({ timeout: 25_000 })
  await browseReady(again.page, fx.root)
  await expect(chip(again.page)).not.toHaveClass(/\bon\b/, { timeout: 20_000 })
  await expect(row(again.page, ed.env)).toHaveCount(0)

  // the same teardown as every other file-edit spec, on the LAST app — the earlier ones
  // were closed by `relaunch` and the fixture's own close is a no-op
  await closeDiscardingEdits(again.app)
})

// BB-M02 (A-04) — find-by-name follows the same switch.
//
// Search is a different backend from the tree (`search()`'s ls-files trio, not
// `listDir`'s check-ignore), so "the tree obeys the switch" says nothing at all about it —
// this is the case that separates the two. With the switch on, files inside ignored
// directories are hits like any other (marked); off, none of them is.
test('BB-M02: find-by-name follows the same switch, reaching inside ignored directories only when it is on', async ({
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

  const hit = (abs: string): Locator => page.locator(`.wb-panel .ft-result[data-path="${abs}"]`)

  await searchToggle(page).click()
  await expect(searchInput(page)).toBeFocused()

  // --- switch off: `app.json` is the positive control, so the silence on `.env` below
  // reads as "filtered out" rather than "search answered nothing at all"
  await searchInput(page).fill('app.json')
  await expect(hit(ed.config)).toBeVisible({ timeout: 25_000 })
  await searchInput(page).fill('.env')
  // `No matches` is the barrier, and it is the product's own way of saying the query RAN
  // and came back empty. A bare `toHaveCount(0)` here is true before the search has even
  // started, so it would pass against a build that never filtered anything.
  await expect(noMatches(page)).toBeVisible({ timeout: 25_000 })
  await expect(hit(ed.env)).toHaveCount(0)
  // …nor anything from inside an ignored directory or node_modules
  await searchInput(page).fill('token.txt')
  await expect(noMatches(page)).toBeVisible({ timeout: 25_000 })
  await expect(hit(fx.paths.ignoredFile)).toHaveCount(0)
  await searchInput(page).fill('index.js')
  await expect(noMatches(page)).toBeVisible({ timeout: 25_000 })
  await expect(hit(fx.paths.heavyFile)).toHaveCount(0)

  // --- switch on, through the tree's own control
  await searchToggle(page).click()
  await chip(page).click()
  await expect(chip(page)).toHaveClass(/\bon\b/)
  await searchToggle(page).click()

  await searchInput(page).fill('.env')
  await expect(hit(ed.env)).toBeVisible({ timeout: 25_000 })
  // the result row is marked the same way the tree row is
  await expect(hit(ed.env)).toHaveClass(/\bignored\b/)

  // …and so is everything inside the ignored directories — `.venv/`, `secrets/`,
  // `node_modules/` — each result marked the way its tree row is
  for (const [query, present] of [
    ['x.txt', ed.venvFile],
    ['token.txt', fx.paths.ignoredFile],
    ['index.js', fx.paths.heavyFile]
  ] as const) {
    await searchInput(page).fill(query)
    await expect(hit(present)).toBeVisible({ timeout: 25_000 })
    await expect(hit(present)).toHaveClass(/\bignored\b/)
  }

  // …but the DIRECTORY itself is never a hit: the list is files-only, so a query naming the
  // folder answers with the file inside it and no row for the folder
  await searchInput(page).fill('.venv')
  await expect(hit(ed.venvFile)).toBeVisible({ timeout: 25_000 })
  await expect(hit(ed.venvDir)).toHaveCount(0)
  // the same teardown every file-edit spec uses; harmless with nothing dirty
  await closeDiscardingEdits(app)
})

// BB-M03 (A-06) — "Open with default app", the answer for everything change two's editor
// deliberately cannot open.
//
// Asserted at the ONE choke point every escape route funnels through (`leaveForOS` appends
// to KOLOFT_EXTERNAL_OPENS_FILE) rather than by watching for a launched app: the suite runs on
// a live machine and must never raise a real one. The file's absence before the click is
// half the case — it is what makes the line afterwards attributable to this menu item.
test('BB-M03: a file row can be handed to the system default app', async ({ app, page, env }) => {
  const fx = setupChangeFixture(env.workspaces.a)
  const ed = seedEditFixture(env.workspaces.a)
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
  await browseReady(page, fx.root)

  expect(fs.existsSync(env.externalOpens)).toBe(false)

  // the tree opens collapsed one level down: the file row only exists once its folder
  // has been opened (same idiom as the edit specs' dirtyEditor helper)
  await row(page, `${fx.root}/config`).click()
  await expect(row(page, `${fx.root}/config/app.json`)).toBeVisible({ timeout: 20_000 })
  await row(page, `${fx.root}/config/app.json`).click({ button: 'right' })
  await expect(ctxMenu(page)).toBeVisible()
  expect(await page.locator(EDIT.ctxItem).allTextContents()).toContain('Open with default app')
  await ctxMenu(page).getByText('Open with default app', { exact: true }).click()

  await expect
    .poll(
      () => (fs.existsSync(env.externalOpens) ? fs.readFileSync(env.externalOpens, 'utf8') : ''),
      {
        timeout: 20_000
      }
    )
    .toContain(ed.config)
  // the same teardown every file-edit spec uses; harmless with nothing dirty
  await closeDiscardingEdits(app)
})
