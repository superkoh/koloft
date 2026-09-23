import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { expect } from './app'
import type { E2EEnv } from './env'
import { encodeCwd, layoutOnDisk } from './p1'
import { assertFixtureDir } from './fixtureGuard'
import { PNG_1X1 } from './filesFixture'
import type { LayoutV2, PersistedTab, SessionWorkbenchState } from '../../../src/shared/types'

/**
 * The Workbench test kit: the panel that
 * absorbed the aux column's Preview and Browser panes into one tab strip, plus the three
 * seams the cases file declares as still-to-build — the git spawn counter (NFR-02 / WB-C17,
 * WB-K08), the file-dialog answer (WB-T11/T19/R01/K02) and the guest-limit override
 * (WB-T13, which already existed and is only re-surfaced here).
 *
 * Same two rules helpers/browser.ts was written under, and for the same reasons:
 *  - every selector is ONE constant, so the surface can be renamed in one place instead
 *    of in a dozen spec files. Koloft has no data-testids; these follow the house
 *    convention of stable classes plus `aria-label` on buttons.
 *  - nothing here knows what the panel DOES. The locators are thin on purpose: the UI
 *    is not built yet, so anything deeper than "the strip, its tabs, their state" would
 *    be a guess this file has no standing to make. The owner of the markup corrects the
 *    constants below; nothing else in the suite has to move.
 *
 * Selector traps, all measured (moved here from test/CLAUDE.md, — they are
 * facts about this panel's markup, so they live next to the constants). Two are
 * documented on the helper that closes them: `.wb-artifact` matching every visited tab
 * (see `WORKBENCH.artifact` / `artifactBody`) and `:visible` locators breaking in the
 * full-width state (see `layoutState`). The three below have NO constant of their own
 * yet — the selectors are hand-typed in the specs, so the comment is the only guard:
 *  - Counting tabs: the pinned `files` tab is always present, so every pre-merge count
 *    is off by one. `BROWSER.tabOpen` / `openTabs()` is the closable set. The retired
 *    `n/8` counter has no successor — the pinned tab's badge counts changed FILES, not
 *    tabs — so the cap is asserted by counting.
 *  - The Files tab's row context menu is portalled to `document.body` and
 *    `position: fixed` — a fixed layer rendered in place is re-based by any ancestor
 *    with a `transform`, and the panel has several. So a locator rooted at `.wb-panel`
 *    will not find it; root it at the page. Which half of that tab is on screen reads
 *    off `.fv[data-view="changes"|"browse"]`, not off which children happen to exist.
 *  - Browse reuses the former sidebar tree's `.ft-*` class names on purpose, so most
 *    of those selectors still resolve — but `.ft-chip` no longer means what it did, and
 *    it fails by passing: it is now the Filter menu's Status/Ownership/Type chips, and
 *    each of those three groups carries an `all`, so an inherited `.ft-chip.on` →
 *    `toHaveText('All')` assertion can go green against an entirely different feature.
 *    Delete those rather than adapting them. A file legitimately appears in Bookmarks,
 *    Recents and the tree at once, so scope row locators through
 *    `.bv-sec[data-section=…]`; bare `.ft-node` also matches Changes' rows, so scope
 *    Browse's to `.bv-body`. And `showBrowse()` expands a collapsed panel as its first
 *    step, so it cannot be the vehicle in a case whose subject IS "this gesture expands
 *    the panel" — reach those through the terminal island's `open`, which is FR-57's
 *    own user-source route.
 *  - A bare `.ed-area` now matches TWO text boxes: the Workbench's file editor and the
 *    Notes island's note, which is always in the left dock. Root the panel's at
 *    `.wb-panel` and the note's at `notesIsland(page)` (helpers/p1.ts); an unrooted one
 *    fails by resolving to whichever came first in the DOM — the note.
 */

/**
 * The panel's markup contract, reconciled against the spec's 1:1 figures
 * (whose `<style>` block IS the class vocabulary) and against App.tsx's focus
 * arbitration, which reads `.wb-panel[data-surface]`. Mirrors the former Browser
 * surface's `.btabs` / `.btab`. CORRECT THESE HERE, not in a spec.
 */
export const WORKBENCH = {
  /** the island the panel lives in: `.off` when collapsed (T1), `.full` in T3 */
  column: '.wb-col',
  /** the panel root (the merged aux column: T2 right rail or T3 full width) */
  panel: '.wb-panel',
  /** the tab strip: pinned `files` first (FR-02), then web/file tabs in user order */
  tabStrip: '.wb-tabs',
  /** the strip's empty run: the one window drag handle in the panel */
  dragHandle: '.wb-tabs .wb-drag',
  tab: '.wb-tab',
  /** the tab's own label text (FR-27: a page's title, a file's name) */
  tabLabel: '.lb',
  /** the active tab (FR-19) */
  tabActive: '.wb-tab.on',
  /** FR-02/FR-18: the system-pinned `files` tab — first slot, no ✕ */
  tabFiles: '.wb-tab.pinned',
  /** FR-13/FR-16: agent-opened and not looked at yet (the left-edge unread dot) */
  tabUnread: '.wb-tab.agent',
  /** FR-24: live guest evicted by the global cap — still listed, frozen, never closed */
  tabFrozen: '.wb-tab.frozen',
  /**
   * FR-19's per-tab ✕.
   *
   * Two spellings on purpose. Playwright resolves a chained selector RELATIVE to the
   * locator it hangs off, so `tab.locator(BROWSER.tabClose)` with the document-rooted
   * form hunts for a `.wb-tab` nested inside a `.wb-tab` and matches nothing. Chain
   * `tabCloseIn`; use `tabClose` only from the page.
   */
  tabClose: '.wb-tab .x',
  /** the ✕ as chained UNDER a tab locator */
  tabCloseIn: '.x',
  /** FR-52: the ＋ (and its dropdown), pinned to the strip's right (FR-26) */
  newTab: '.wb-new',
  /** FR-52: the ＋ dropdown, and one of its items — THREE since R2 added
   *  "New terminal" beside "New web tab" and "Open file…" (pinned by WB-K02) */
  newMenu: '.wb-newmenu',
  newMenuItem: '.wb-newmenu .mi',
  /** FR-55: the titlebar toggle. After the merge the aux roster is exactly [Workbench]
   *  (WB-L05; the Terminal icon left with the island) — `auxIcon(page, 'Workbench')`
   *  in helpers/p1.ts resolves to the same element. */
  titlebarIcon: '.aux-ico[aria-label="Workbench"]',

  // ---- row 2: the kind bar, and the artifact under it (FR-30…FR-35) ----
  /** the active KIND's own bar. `web` supplies `.baddr` instead (see helpers/browser.ts):
   *  the address row is reused verbatim, which is how FR-37 holds.
   *  Every selector in this block is scoped to `.wb-panel`: the workspace note
   *  in the left dock reuses `.wb-bar` / `.wb-title` / `.icobtn` for its own head band,
   *  so a bare form would match a bar outside the panel entirely. */
  kindBar: '.wb-panel .wb-bar',
  /** FR-31's path, with its dimmed parent-directory prefix */
  artifactTitle: '.wb-panel .wb-bar .wb-title',
  /** FR-31's `[ Rendered | Diff | Source ]`, and whichever segment is on */
  viewSeg: '.wb-panel .wb-bar .seg[aria-label="View mode"]',
  viewSegOn: '.wb-panel .wb-bar .seg[aria-label="View mode"] .on',
  reload: '.wb-panel .wb-bar .icobtn[aria-label="Reload"]',
  outline: '.wb-panel .wb-bar .icobtn[aria-label="Outline"]',
  /** FR-05's ⤢. The label FLIPS with the state, so match by prefix. */
  fullWidth: '.wb-panel .wb-bar .icobtn[aria-label^="Full width"]',
  restoreWidth: '.wb-panel .wb-bar .icobtn[aria-label^="Restore"]',
  /**
   * One `file` tab's rendered artifact.
   *
   * ALWAYS pair it with `:visible` (or use `artifactBody()` below): every VISITED file tab
   * keeps a resident node, and an inactive one is `visibility:hidden` — which still has an
   * `offsetParent`, so a bare locator silently matches several and reads the wrong one.
   */
  artifact: '.wb-artifact',
  /** the panel's one find bar (FR-35) */
  findBar: '.wb-panel .find-bar',
  /** §6: the placeholder a deleted file's tab shows, and its close affordance (WB-R12) */
  stateButton: '.wb-state-btn',

  // ---- the pinned `files` tab's reading area (FR-10 / FR-31, inside Browse) ----
  /**
   * FR-10's reading area, as `FilesView` renders it: Browse's right-hand column, under
   * FR-31's own artifact header. It is NOT the `file` tab's kind bar — both are `.wb-bar`
   * and both carry a `.wb-title`, so a case that reads the reading area while ANY panel
   * chrome is on screen has to say which one it means. `.fv-artifact-hd` is that word.
   *
   * (The P1 placeholder these two replace was the former FilePane's own `.file-pane-title`
   * / `.file-pane-body`. `.file-pane-body` still exists — `ArtifactPane` kept the class —
   * but it is now one per mounted artifact, reading-area and `file` tabs alike, so the
   * bare form matches several.)
   */
  readingTitle: '.wb-panel .fv-artifact-hd .wb-title',
  /** the reading area's rendered artifact. Absent until a file is being read: Browse with
   *  nothing open shows `.fv-empty` instead, which is what makes a `count() === 0` here a
   *  real "no file was opened" rather than "the column is off screen". */
  readingBody: '.wb-panel .fv-read .wb-artifact'
} as const

/**
 * FR-04 — the panel is ATTACHED to a session, which lands a moment after the sidebar row
 * starts reading running: a resume binds asynchronously, so there is a window where the
 * row is live, the tree is clickable, and no session is bound to the tab yet.
 *
 * Every panel gesture is inert in that window, so a case that acts inside it races and
 * fails for a reason that has nothing to do with what it tests. Wait on this first.
 * (`startSessionIn` waits on the same signal, which is why a fresh session needs no extra
 * barrier; a RESUMED one does.)
 *
 * Two traps: a same-run SIGKILL-then-resume never binds (the row sits at `st-pending`
 * for good), so a real pre-bind window needs an actual app restart; and
 * `not.toHaveClass(/cold/)` is not a bind barrier, because `st-pending` is not cold either.
 */
export async function waitPanelAttached(page: Page, timeout = 60_000): Promise<void> {
  await expect(workbenchIcon(page)).toHaveAttribute('aria-disabled', 'false', { timeout })
}

/**
 * Which of FR-05's three layout states is on screen, read only from what a user sees.
 *
 * Measured in ONE evaluate rather than through locators: in T3 the TUI island is
 * `display:none`, so a `:visible` locator matches nothing and `boundingBox()` throws
 * instead of answering "T3".
 */
export async function layoutState(page: Page): Promise<'T1' | 'T2' | 'T3'> {
  return page.evaluate(() => {
    const panel = document.querySelector('.wb-panel') as HTMLElement | null
    if (!panel || getComputedStyle(panel).visibility === 'hidden' || panel.offsetWidth === 0) {
      return 'T1' as const
    }
    const tui = document.querySelector('.term-island') as HTMLElement | null
    return tui && tui.offsetWidth > 0 ? ('T2' as const) : ('T3' as const)
  })
}

/**
 * The ACTIVE tab's artifact. Never use the bare class: an inactive visited tab keeps a
 * resident, visibility-hidden node that still has an `offsetParent`, so the bare selector
 * matches several and reads the wrong one.
 *
 * `:visible` belongs in a LOCATOR only. It is a Playwright pseudo-class, not CSS, so
 * putting it inside a `page.evaluate` reaches `document.querySelector` as a syntax error
 * and takes out every assertion in that block.
 */
export function artifactBody(page: Page): Locator {
  return page.locator(`${WORKBENCH.artifact}:visible`)
}

/** Which kind the panel is showing — `files` | `web` | `file`. */
export async function activeKind(page: Page): Promise<string | null> {
  return page.locator(WORKBENCH.panel).first().getAttribute('data-kind')
}

/**
 * FR-52 — open one `file` tab through the product's own door: ＋ ▸ "Open file…", answered
 * by the harness's queue rather than a native panel.
 *
 * The drain check is a positive barrier, not politeness: an empty queue reads as a
 * CANCELLED pick, so a case whose answer never got consumed would otherwise look like a
 * cancel that silently made no tab.
 */
export async function openFileTab(page: Page, env: E2EEnv, absPath: string): Promise<void> {
  answerFileDialog(env, absPath)
  await page.locator(WORKBENCH.panel).click({ position: { x: 5, y: 5 } })
  await page.locator(WORKBENCH.newTab).click()
  await page.locator(WORKBENCH.newMenuItem, { hasText: 'Open file…' }).click()
  await expect.poll(() => pendingFileDialogAnswers(env)).toEqual([])
  await expect.poll(() => activeKind(page)).not.toBe('files')
}

// ---- panel & tab strip ----------------------------------------------------------------

export function workbenchPanel(page: Page): Locator {
  return page.locator(WORKBENCH.panel)
}

/** the computed `app-region` of the first element `sel` matches: 'drag', 'no-drag' or '' */
export function appRegion(page: Page, sel: string): Promise<string> {
  return page
    .locator(sel)
    .first()
    .evaluate((el) => getComputedStyle(el).getPropertyValue('app-region').trim())
}

export function workbenchIcon(page: Page): Locator {
  return page.locator(WORKBENCH.titlebarIcon)
}

/** Every tab in strip order — `files` included, since FR-02 makes it a real tab. */
export function wbTabs(page: Page): Locator {
  return page.locator(WORKBENCH.tab)
}

export function wbActiveTab(page: Page): Locator {
  return page.locator(WORKBENCH.tabActive)
}

/** The tabs still carrying an unread dot (FR-16: an expand must not clear them). */
export function wbUnreadTabs(page: Page): Locator {
  return page.locator(WORKBENCH.tabUnread)
}

export function wbFrozenTabs(page: Page): Locator {
  return page.locator(WORKBENCH.tabFrozen)
}

export function wbTabByTitle(page: Page, text: string | RegExp): Locator {
  return page.locator(WORKBENCH.tab).filter({ hasText: text })
}

/** Every tab label, in strip order — the oracle for FR-21 reordering and FR-27 titles. */
export async function wbTabTitles(page: Page): Promise<string[]> {
  const texts = await page.locator(`${WORKBENCH.tab} ${WORKBENCH.tabLabel}`).allTextContents()
  return texts.map((t) => t.replace(/\s+/g, ' ').trim())
}

// ---- layout v3 on disk ------------------------------------------------------------------

/**
 * The Workbench's slice of layout.json, per session (`sessions[id]`, layout v3). null
 * when the session has no entry of its own, which is NOT the same as an entry holding
 * the defaults: an absent one means the panel inherits `workbench.defaultOpen`, and
 * conflating the two would let a migration that silently dropped every session entry
 * (WB-P03's failure mode) still read as a pass.
 */
export function sessionWorkbenchOnDisk(
  env: E2EEnv,
  sessionId: string
): SessionWorkbenchState | null {
  return layoutOnDisk(env).sessions?.[sessionId] ?? null
}

/** The persisted tab set for one session, in strip order (`files` is never in it — FR-02
 *  makes it implied). [] for a session with no entry, so a caller can compare lengths. */
export function persistedTabsOnDisk(env: E2EEnv, sessionId: string): PersistedTab[] {
  return sessionWorkbenchOnDisk(env, sessionId)?.tabs ?? []
}

/** The global default (`workbench.defaultOpen`) as it currently sits on disk. */
export function workbenchDefaultOnDisk(env: E2EEnv): boolean | null {
  return layoutOnDisk(env).workbench?.defaultOpen ?? null
}

function patchLayout(env: E2EEnv, patch: (doc: Record<string, unknown>) => void): void {
  const file = path.join(env.userData, 'layout.json')
  const doc = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)
    : { version: 4, workspaces: [], workbench: { defaultOpen: true }, sessions: {} }
  patch(doc)
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))
}

/**
 * Seed one session's persisted panel state — the tab set a restart is supposed to bring
 * back (WB-P01), or the collapsed/expanded flag a session switch is supposed to respect
 * (WB-L06). Merges into whatever layout.json already holds, so the ownership entry
 * `seedJsonl` wrote and the pins `pinWorkspaces` wrote both survive.
 *
 * Must run BEFORE launchApp — main reads layout.json once, in the WorkspaceManager
 * constructor. The state is written RAW: a case that wants a dirty document (WB-P04's
 * url-less web tab, unknown kind, ninth tab) hands one in and asserts what the
 * per-item sanitizer made of it.
 */
export function seedWorkbench(
  env: E2EEnv,
  sessionId: string,
  state: SessionWorkbenchState | Record<string, unknown>
): void {
  patchLayout(env, (doc) => {
    const sessions = (doc.sessions ?? {}) as Record<string, unknown>
    sessions[sessionId] = state
    doc.sessions = sessions
  })
}

/** Seed the global default a session with no entry of its own inherits (v3
 *  `workbench.defaultOpen`; v2 spelled it `aux.defaultMode`). */
export function seedWorkbenchDefault(env: E2EEnv, defaultOpen: boolean): void {
  patchLayout(env, (doc) => {
    doc.workbench = { defaultOpen }
  })
}

/**
 * Overwrite layout.json with a LEGACY v2 document — the input half of WB-P03/NFR-06.
 *
 * It exists so the former shape is spelled ONCE, by the type that still describes it,
 * rather than re-invented as an untyped literal in whichever spec needs it: a v2
 * document that misses `aux` is not "slightly wrong", it fails `isLayoutV2`, degrades to
 * the empty layout, and the case then passes or fails for the wrong reason.
 *
 * Must run BEFORE launchApp; the boot that follows is what performs the migration.
 */
export function writeLegacyV2Layout(env: E2EEnv, doc: LayoutV2): void {
  fs.writeFileSync(path.join(env.userData, 'layout.json'), JSON.stringify(doc, null, 2))
}

// ---- ⌗ Scratchpad, the session-scoped virtual root (WB-B04) --------------------------------

export interface ScratchpadFixture {
  /** the real dir `sessionTracker.scratchpadDirFor` resolves for this session */
  dir: string
  md: string
  png: string
  ts: string
  /**
   * A7's `tasks/` blackout, INSIDE spelling (`<scratchpad>/tasks`). This is the one the
   * ⌗ Scratchpad node's own filter sees, since `scratchpadEntries` filters what
   * `listDir(scratchpadDir)` returned.
   */
  tasksDir: string
  tasksFile: string
  /**
   * The same blackout, SIBLING spelling (`<sessionDir>/tasks`) — where real Claude Code
   * actually puts subagent transcripts (docs/claude-code-contract.md §2), and the spelling
   * `browseModel.isTasksPath` checks second.
   *
   * It needs its own entry because the two are reached through DIFFERENT roots: the inside
   * one can only ever surface under ⌗ Scratchpad, while the sibling is outside the
   * scratchpad dir entirely and so can only surface under ↗ Outside — and only once the
   * session has WRITTEN it. So a case that wants to prove "`tasks/` is invisible under
   * every root" has to drive `/write <siblingTasksFile>` as well; seeding alone tests the
   * inside half only.
   */
  siblingTasksDir: string
  siblingTasksFile: string
  /** the missing-directory branch — the whole ⌗ Scratchpad node must disappear. Scoped to
   *  the scratchpad dir, which IS the node's directory; the sibling `tasks/` survives. */
  remove(): void
}

/**
 * Fill one session's scratchpad with the four kinds WB-B04 asks about (its `↗ Outside`
 * sibling is `seedOutsideDir` in helpers/filesFixture.ts).
 *
 * Written from the SPEC's side rather than through fake-claude's `/scratch`, because
 * `/scratch` writes one flat text file per call: it can produce neither a real `.png` nor
 * the `tasks/` SUBDIRECTORY the case turns on (its `mkdirSync` covers the scratchpad dir
 * only, so a nested name would throw inside the fake session).
 *
 * The path is derived exactly as `scratchpadDirFor` derives it — `<KOLOFT_SCRATCHPAD_BASE>/
 * <slug of the transcript's bucket dir>/<sessionId>/scratchpad` — so `bucketDir` is the
 * dir whose slug the session's jsonl lives under (what `seedJsonl` was handed), which is
 * not always the session's cwd: a `-w` launch keeps its transcript in the repo-root slug.
 *
 * It lives HERE rather than with the other Files fixtures because deriving that slug needs
 * p1.ts's `encodeCwd`, and filesFixture.ts is kept free of p1's `@playwright/test` chain so
 * the unit layer can exercise its git builders.
 */
export function seedScratchpad(
  env: E2EEnv,
  bucketDir: string,
  sessionId: string
): ScratchpadFixture {
  const sessionDir = path.join(env.scratchpadBase, encodeCwd(bucketDir), sessionId)
  const dir = path.join(sessionDir, 'scratchpad')
  const siblingTasksDir = path.join(sessionDir, 'tasks')
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true })
  fs.mkdirSync(siblingTasksDir, { recursive: true })
  // no git runs here, but `remove()` is a recursive rm — the same guard, for the same
  // reason  gave it to the git helpers
  assertFixtureDir('seedScratchpad', dir)
  const put = (base: string, rel: string, body: string | Buffer): string => {
    const abs = path.join(base, rel)
    fs.writeFileSync(abs, body)
    return abs
  }
  return {
    dir,
    md: put(dir, 'notes.md', '# Scratch notes\n\nkoloft-e2e-scratch-md\n'),
    png: put(dir, 'shot.png', Buffer.from(PNG_1X1, 'base64')),
    ts: put(dir, 'helper.ts', 'export const scratchHelper = 1\n'),
    tasksDir: path.join(dir, 'tasks'),
    tasksFile: put(dir, 'tasks/plan.md', '# plan\n\nkoloft-e2e-scratch-task\n'),
    siblingTasksDir,
    // markdown on purpose: an Outside-ELIGIBLE kind, so if the `tasks/` rule ever stopped
    // firing this file would really surface there. A `.ts` would be filtered by the
    // allowlist anyway and the case would pass for the wrong reason.
    siblingTasksFile: put(
      siblingTasksDir,
      'subagent.md',
      '# subagent\n\nkoloft-e2e-tasks-transcript\n'
    ),
    remove: () => fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ---- the file-dialog seam (WB-T11, WB-T19, WB-R01, WB-K02) --------------------------------

/**
 * Queue what the next `preview.openFileDialog` calls answer, oldest first: one absolute
 * path per call, consumed as it is handed out. The seam is main-side and env-gated
 * (KOLOFT_FILE_DIALOG_FILE, set for every launch by helpers/env.ts) — with it set the app
 * never raises the native open panel, which a background run could not dismiss.
 *
 *   answerFileDialog(env, `${ws}/a/config.ts`, `${ws}/b/config.ts`)
 *   // …then drive ⌘T ▸ "Open file…" twice: the first pick answers a/config.ts,
 *   // the second b/config.ts, and a third would read as cancelled.
 *
 * Calling it REPLACES the queue rather than appending, so a case never inherits an
 * answer it did not ask for. May run at any time — unlike the launch env, the file is
 * read per invocation.
 */
export function answerFileDialog(env: E2EEnv, ...paths: string[]): void {
  fs.writeFileSync(env.fileDialogFile, paths.length ? paths.join('\n') + '\n' : '')
}

/** Make the next pick read as cancelled (WB-K02 dismisses the picker) — an empty queue
 *  IS the cancel answer, so this just clears it. */
export function cancelFileDialog(env: E2EEnv): void {
  fs.rmSync(env.fileDialogFile, { force: true })
}

/** What is still queued. Draining to [] is the positive barrier that the dialog really
 *  was raised and really answered — assert it before concluding a pick happened. */
export function pendingFileDialogAnswers(env: E2EEnv): string[] {
  if (!fs.existsSync(env.fileDialogFile)) return []
  return fs.readFileSync(env.fileDialogFile, 'utf8').split('\n').filter(Boolean)
}

// ---- the git spawn counter (NFR-02 / WB-C17, WB-K08) --------------------------------------

/**
 * The counter itself moved to helpers/gitSpawnLog.ts so its PARSING half can be
 * unit-tested — this file reaches `@playwright/test` through helpers/app.ts, which a
 * vitest suite must not load. Re-exported here because the Workbench kit is where a spec
 * author looks for it.
 *
 * Attribution lives in `WORKBENCH_GIT` (the subcommands only the panel issues — WB-K08's
 * oracle) and `isAggregateDiff` (the Changes stream specifically). A `root` filter alone
 * is NOT attribution: main runs git at the same root on its own timers.
 */
export {
  installGitSpawnLog,
  installStallingGit,
  gitSpawns,
  countGitSpawns,
  parseGitSpawns,
  filterGitSpawns,
  isAggregateDiff,
  WORKBENCH_GIT,
  waitGitQuiet
} from './gitSpawnLog'
export type { GitSpawn, GitSpawnFilter } from './gitSpawnLog'

// ---- the guest-limit override (WB-T13) -----------------------------------------------------

/**
 * FR-24's "lower the guest cap" seam. It was NOT built — KOLOFT_BROWSER_GUEST_LIMIT
 * already caps main's `browserGuestLimit()` and reaches the renderer as
 * `window.api.browserGuestLimit` — so this is a re-export, not a second implementation.
 * Must run BEFORE launchApp (the value travels in the launch env):
 *
 *   setGuestLimit(env, 3)   // WB-T13: 5 web tabs, the two least-recently-seen freeze
 */
export { setGuestLimit } from './env'

// ---- Browse: what the former sidebar tree's callers use now (FR-44 / FR-10) --------------

/**
 * Put the pinned `files` tab's BROWSE half on screen.
 *
 * Three rungs, and skipping any one of them is the whole reason this exists:
 *  · the panel may be collapsed — the titlebar icon is the user's own way back;
 *  · a `web` tab on top replaces the Files kind bar entirely, so the pinned tab has to be
 *    activated before the view switch is even in the DOM;
 *  · `useFilesController` starts on `changes` (FR-39), so a row click before this reaches
 *    nothing at all — the tree is simply not mounted in the Changes half.
 *
 * Idempotent: each rung is skipped when it is already where it needs to be, so a caller
 * that just came back from a USER open (which switches to Browse by itself, FR-57) pays
 * only the assertion.
 */
export async function showBrowse(page: Page): Promise<void> {
  // FR-04's attach window first: until the panel is bound to a session every gesture below
  // is inert, and a resumed row spends real time there (see waitPanelAttached's comment).
  await waitPanelAttached(page)
  const panel = page.locator(WORKBENCH.panel)
  if (!(await panel.isVisible())) {
    await workbenchIcon(page).click()
    await expect(panel).toBeVisible({ timeout: 20_000 })
  }
  const pinned = page.locator(WORKBENCH.tabFiles)
  if (!(await pinned.getAttribute('class'))?.split(/\s+/).includes('on')) await pinned.click()
  const browse = page
    .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
    .filter({ hasText: 'Browse' })
  await expect(browse).toBeVisible({ timeout: 20_000 })
  if ((await browse.getAttribute('aria-pressed')) !== 'true') await browse.click()
  await expect(page.locator(`${WORKBENCH.panel} .fv`)).toHaveAttribute('data-view', 'browse', {
    timeout: 20_000
  })
}

/**
 * Open a file the way a user does now that the sidebar tree is gone: reach Browse, expand
 * whatever ancestors still hide the row (the listing is lazy — only the root comes
 * expanded), then click it.
 *
 * For cases that used the tree as a VEHICLE — the cheapest way to get a file on screen —
 * and whose subject is something else entirely. A case about Browse itself should spell its
 * own clicks, so that what it asserts stays visible in the spec.
 *
 * `absPath` outside the root (a ⌗ Scratchpad or ↗ Outside row) needs no expansion: those
 * sections render open, so the row is clicked directly.
 */
export async function openInBrowse(page: Page, absPath: string): Promise<void> {
  await showBrowse(page)
  const panel = page.locator(WORKBENCH.panel)
  const rootRow = panel.locator('.ft-node.ft-root')
  await expect(rootRow).toBeVisible({ timeout: 30_000 })
  const root = (await rootRow.getAttribute('data-path')) ?? ''
  if (absPath.startsWith(root + '/')) {
    const segs = absPath.slice(root.length + 1).split('/')
    let dir = root
    for (const seg of segs.slice(0, -1)) {
      dir += '/' + seg
      const row = panel.locator(`.ft-node.ft-dir[data-path="${dir}"]`)
      await expect(row).toBeVisible({ timeout: 30_000 })
      if (!(await row.getAttribute('class'))?.split(/\s+/).includes('open')) await row.click()
      await expect(row).toHaveClass(/\bopen\b/, { timeout: 20_000 })
    }
  }
  await panel.locator(`.ft-node.ft-file[data-path="${absPath}"]`).click({ timeout: 30_000 })
}
