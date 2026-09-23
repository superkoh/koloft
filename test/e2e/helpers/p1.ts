import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFileSync, spawnSync } from 'child_process'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect } from './app'
import type { E2EEnv } from './env'
import { assertFixtureDir } from './fixtureGuard'
import type { SessionWorkbenchState } from '../../../src/shared/types'

/**
 * Shared plumbing for the P1-gate agent-centric specs (retired agent-centric test plan
 * §12): fake-claude call-log reading, hermetic git repo/worktree setup, seeding
 * Claude-storage jsonl fixtures, the §0 shortcut-IPC seam, sidebar fly-out menus,
 * and the pixel-acceptance screenshots under test-results/p1-screens/.
 */

const REPO_ROOT = path.join(__dirname, '..', '..', '..')
export const SCREEN_DIR = path.join(REPO_ROOT, 'test-results', 'p1-screens')

/** One key-state screenshot per case, named by its tests.md id (pixel acceptance). */
export async function snap(page: Page, caseId: string): Promise<string> {
  fs.mkdirSync(SCREEN_DIR, { recursive: true })
  const file = path.join(SCREEN_DIR, `${caseId}.png`)
  await page.screenshot({ path: file })
  return file
}

export interface ClaudeCall {
  pid: number
  argv: string[]
  cwd: string
  effectiveCwd?: string
  sessionId: string
  /** the first typed message the launch carried after `--` (a job's task text), else null */
  firstPrompt?: string | null
  ts: number
  /** D2: the browser endpoint the shim injected into THIS launch (null = none).
   *  A spec reads the ws url here, from the same place a real tool reads it. */
  cdpEndpoint?: string | null
  playwrightMcpEndpoint?: string | null
}

/** Every fake-claude launch so far, oldest first. Absent file = never launched. */
export function readCalls(env: E2EEnv): ClaudeCall[] {
  if (!fs.existsSync(env.claudeCalls)) return []
  return fs
    .readFileSync(env.claudeCalls, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ClaudeCall]
      } catch {
        return [] // a record still being written
      }
    })
}

export async function waitForCalls(
  env: E2EEnv,
  count: number,
  timeout = 40_000
): Promise<ClaudeCall[]> {
  await expect.poll(() => readCalls(env).length, { timeout }).toBeGreaterThanOrEqual(count)
  return readCalls(env)
}

/** The id a launch was told to resume, if any. */
export function resumedId(call: ClaudeCall): string | undefined {
  const i = call.argv.indexOf('--resume')
  return i >= 0 ? call.argv[i + 1] : undefined
}

/** Alive as a real process — a reaped-but-not-yet-collected zombie counts as dead. */
export function processAlive(pid: number): boolean {
  const res = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  if (res.status !== 0) return false
  const stat = res.stdout.trim()
  return stat.length > 0 && !stat.startsWith('Z')
}

/**
 * SIGKILL a session's claude — the "it died hard, with no SessionEnd" half of the
 * lifecycle cases — after checking the pid is still that session's.
 *
 * Every one of these kills works from a pid read out of a file some seconds or minutes
 * earlier, and pids ARE recycled inside one suite run (measured: one pid served two
 * different workers' sessions three minutes apart). An unchecked kill can therefore land
 * on a live session belonging to another worker, failing a test that has nothing to do
 * with this one — a flake with no trace back to its cause. The identity check is this
 * env's own temp home, which the launch carries in its command line and no other worker
 * shares.
 */
export function killSession(pid: number, env: E2EEnv): void {
  const res = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  const cmd = res.status === 0 ? res.stdout.trim() : ''
  if (!cmd) return // already gone: nothing to kill, and nothing to get wrong
  if (!cmd.includes(env.home)) {
    throw new Error(
      `refusing to SIGKILL pid ${pid}: it is not this test's session any more ` +
        `(recycled pid). Running instead: ${cmd.slice(0, 160)}`
    )
  }
  process.kill(pid, 'SIGKILL')
}

// ---- git fixtures ----------------------------------------------------------------

/** Turn a dir into a repo with one commit (worktrees need a HEAD to branch from). */
export function gitInit(dir: string): void {
  assertFixtureDir('gitInit', dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync(
    'git',
    [
      '-c',
      'user.email=e2e@koloft.test',
      '-c',
      'user.name=koloft-e2e',
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      'init'
    ],
    { cwd: dir }
  )
}

/** Commit everything in `dir`, so a fixture file reads as unchanged rather than as an
 *  untracked all-additions diff (which makes Preview show the inline diff, not the file). */
export function gitCommitAll(dir: string): void {
  assertFixtureDir('gitCommitAll', dir)
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync(
    'git',
    [
      '-c',
      'user.email=e2e@koloft.test',
      '-c',
      'user.name=koloft-e2e',
      'commit',
      '-q',
      '-m',
      'fixture'
    ],
    { cwd: dir }
  )
}

/** A linked worktree in CC's own namespace (`.claude/worktrees/<name>`, V2 layout). */
export function gitWorktreeAdd(repo: string, name: string): string {
  assertFixtureDir('gitWorktreeAdd', repo)
  const wt = path.join(repo, '.claude', 'worktrees', name)
  fs.mkdirSync(path.dirname(wt), { recursive: true })
  execFileSync('git', ['worktree', 'add', '-q', wt, '-b', `worktree-${name}`], { cwd: repo })
  return fs.realpathSync(wt)
}

// ---- Claude-storage jsonl seeds ----------------------------------------------------

/** Claude's project-dir encoding (mirrors sessionTracker.encodeCwd). */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export interface SeedOptions {
  id?: string
  /** summary record → the cold row's title (locked §6 chain) */
  summary?: string
  /** false = an EXTERNAL claude run: jsonl only, no ownership entry, so the sidebar
   *  must not list it. Default true — a seeded transcript stands in
   *  for Koloft's own history. */
  owned?: boolean
  /** bare=true writes only an assistant record — no summary, no genuine user
   *  prompt — driving the title chain to its relative-time fallback (T-AGG-03) */
  bare?: boolean
  /** cwd the records carry; defaults to the bucket dir (a differing, deleted path
   *  makes an invalid-cwd row, T-AGG-05) */
  cwd?: string
  /** the lifecycle contract D11: seed the transcript's worktree binding as its head record.
   *  Independent of the bucket dir — a bound session's jsonl may sit in the repo-root
   *  slug (a `-w` launch) or in the worktree's own (§1✎), and both shapes matter. */
  worktreeState?: {
    worktreeName: string
    worktreePath: string
    /** the repo root the session was launched from — where a root-slug resume starts */
    originalCwd: string
    /** defaults to `worktree-<name>`, claude's own derivation */
    worktreeBranch?: string
    originalHeadCommit?: string
  }
  timestamp?: number
  mtime?: number
  /** the projects root to write under, instead of the local `<home>/.claude/projects`.
   *  A remote workspace's rows are read from the mirror under userData, so seeding a
   *  cold remote transcript means writing there (E-RW-09). */
  root?: string
}

/**
 * Declare a session Koloft's own, the way a SessionStart bind does (WorkspaceManager
 * .onSessionBound): a layout v3 `sessions[id]` entry. Only owned (or running) sessions
 * reach the sidebar, so a jsonl fixture without one is invisible by design.
 *
 * The entry is the DEFAULT panel state — expanded, no tabs of its own — which is what
 * v2's `{auxMode:'preview'}` meant here and what the v2→v3 migration projects it to. A
 * case that needs a seeded tab set or a collapsed panel calls `seedWorkbench`
 * (helpers/workbench.ts) after this, on the id it returns.
 *
 * Must run BEFORE launchApp — main reads layout.json once, in the WorkspaceManager
 * constructor. Note the §6 GC: an entry whose id has no jsonl anywhere in Claude's
 * storage is dropped on the first rescan.
 */
function seedOwnership(env: E2EEnv, id: string): void {
  const file = path.join(env.userData, 'layout.json')
  const layout = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)
    : { version: 4, workspaces: [], workbench: { defaultOpen: true }, sessions: {} }
  const sessions = (layout.sessions ?? {}) as Record<string, unknown>
  sessions[id] = { open: true, tabs: [] }
  layout.sessions = sessions
  fs.writeFileSync(file, JSON.stringify(layout, null, 2))
}

/** Write one session jsonl into `<root>/<slug(bucketDir)>/` — `~/.claude/projects` unless
 *  `opts.root` names a mirror — and (unless `owned: false`) claim it for Koloft. */
export function seedJsonl(env: E2EEnv, bucketDir: string, opts: SeedOptions = {}): string {
  const dir = path.join(
    opts.root ?? path.join(env.home, '.claude', 'projects'),
    encodeCwd(bucketDir)
  )
  fs.mkdirSync(dir, { recursive: true })
  const id = opts.id ?? crypto.randomUUID()
  const cwd = opts.cwd ?? bucketDir
  const ts = new Date(opts.timestamp ?? Date.now()).toISOString()
  const lines: unknown[] = []
  if (opts.worktreeState) {
    const w = opts.worktreeState
    lines.push({
      type: 'worktree-state',
      // the real record nests everything under `worktreeSession` (§1✎); its own
      // `sessionId` is written because real transcripts carry it — inherited from a
      // predecessor in 14/116 samples, which is why it is never a key
      worktreeSession: {
        originalCwd: w.originalCwd,
        preEnterOriginalCwd: w.originalCwd,
        worktreePath: w.worktreePath,
        worktreeName: w.worktreeName,
        worktreeBranch: w.worktreeBranch ?? `worktree-${w.worktreeName}`,
        originalBranch: 'main',
        originalHeadCommit: w.originalHeadCommit ?? '0'.repeat(40),
        sessionId: id
      }
    })
  }
  if (!opts.bare && opts.summary) {
    // a real transcript carries BOTH title records with the same text (the tracker
    // titles running rows from ai-title, the aggregator cold rows from summary) —
    // one without the other makes a row rename itself across the running/cold edge
    lines.push({ type: 'ai-title', aiTitle: opts.summary })
    lines.push({ type: 'summary', summary: opts.summary })
  }
  if (opts.bare) {
    lines.push({
      type: 'assistant',
      timestamp: ts,
      cwd,
      message: { role: 'assistant', content: [{ type: 'text', text: 'seeded turn' }] }
    })
  } else {
    lines.push({
      type: 'user',
      timestamp: ts,
      cwd,
      message: { role: 'user', content: opts.summary ?? 'seeded prompt' }
    })
  }
  const file = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  if (opts.mtime) fs.utimesSync(file, new Date(opts.mtime), new Date(opts.mtime))
  if (opts.owned !== false) seedOwnership(env, id)
  return id
}

// ---- §0 seams ----------------------------------------------------------------------

/** The §0 shortcut seam: menu accelerators don't respond to synthesized keys, so a
 *  spec sends the same IPC the menu item forwards. */
export async function sendShortcut(app: ElectronApplication, channel: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, ch) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(ch)
  }, channel)
}

/** The §0 shortcut seam, menu half: click an app-menu item by its stable id — the
 *  exact path the accelerator takes (pattern: restart-session.spec triggerRestart).
 *  Waits for the renderer's listener flag first: a forwarded shortcut that lands
 *  before that effect has run is silently dropped. */
export async function clickAppMenuItem(
  app: ElectronApplication,
  page: Page,
  id: string
): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as unknown as { __koloftShortcutsReady?: boolean }).__koloftShortcutsReady === true,
    undefined,
    { timeout: 20_000 }
  )
  await app.evaluate(({ Menu }, mid) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(mid)
    if (!item) throw new Error(`no application-menu item with id "${mid}"`)
    item.click()
  }, id)
}

/** Drive workspace:add directly — the §0 rule: never open the native folder picker. */
export async function addWorkspace(
  page: Page,
  dir: string
): Promise<{ code: string; path?: string }> {
  return page.evaluate(
    (p) => window.api.workspace.add(p) as Promise<{ code: string; path?: string }>,
    dir
  )
}

/** Sidebar workspace names, in render order. */
export async function workspaceNames(page: Page): Promise<string[]> {
  return page.locator('.ws-head .ws-name').allTextContents()
}

/**
 * layout.json exactly as it sits on disk — the one user artifact the cases file admits
 * as observable ("layout.json / settings.json on disk count as observable user
 * artifacts" — everything else internal is barred from an assertion).
 *
 * Typed as v3 where a spec asserts structure, open (`[key: string]: unknown`) everywhere
 * else, because the migration specs read documents that are deliberately NOT v3: a v1
 * `tabs` array, a v2 `aux` block. The v3 keys carry real types so a stale `auxMode` /
 * `defaultMode` assertion fails to COMPILE instead of silently reading `undefined` and
 * passing (NFR-06). Per-session accessors live in helpers/workbench.ts.
 */
export interface LayoutOnDisk {
  version?: number
  workspaces?: { path: string }[]
  workbench?: { defaultOpen: boolean }
  sessions?: Record<string, SessionWorkbenchState>
  /** LEGACY: the former global terminal island's block. The product no longer
   *  writes or reads it; the key is typed here only so T-WT-12 can seed an old document
   *  and assert the key is DROPPED — a bare `unknown` would let a stale assertion pass. */
  globalTerminal?: { visible: boolean; tabs: { title: string; cwd: string }[] }
  [key: string]: unknown
}

export function layoutOnDisk(env: E2EEnv): LayoutOnDisk {
  return JSON.parse(fs.readFileSync(path.join(env.userData, 'layout.json'), 'utf8')) as LayoutOnDisk
}

export function settingsOnDisk(env: E2EEnv): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(env.userData, 'settings.json'), 'utf8')) as Record<
    string,
    unknown
  >
}

/** the Notes island in the left dock. Selected by its class, never by the word
 *  "notes": ws-a's fixture already holds files whose names carry it. */
export function notesIsland(page: Page): Locator {
  return page.locator('.isl-notes')
}

/** Where one workspace's note file is — for the cases that write it from OUTSIDE the app,
 *  which is the whole point of the head band's Copy path button. */
export function notesPath(env: E2EEnv, wsPath: string): string {
  return path.join(env.userData, 'notes', encodeCwd(wsPath), 'notes.md')
}

/** What one workspace's note holds on disk, or null before it has ever been made. */
export function notesOnDisk(env: E2EEnv, wsPath: string): string | null {
  const file = notesPath(env, wsPath)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

/**
 * Seed the RETIRED global terminal island's persisted state.
 *
 * The only reason this survived the island: T-WT-12 needs an old document to upgrade, and
 * a migration case that writes the legacy key by hand would be pinning its own fixture
 * rather than the shape Koloft used to produce. Must run BEFORE launchApp — main reads
 * layout.json once, in the WorkspaceManager constructor.
 */
export function seedGlobalTerm(
  env: E2EEnv,
  state: { visible: boolean; tabs: { title: string; cwd: string }[] }
): void {
  const file = path.join(env.userData, 'layout.json')
  const layout = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)
    : { version: 4, workspaces: [], workbench: { defaultOpen: true }, sessions: {} }
  layout.globalTerminal = state
  fs.writeFileSync(file, JSON.stringify(layout, null, 2))
}

// ---- sessions & the C6 aux island ------------------------------------------------

/** The title fake-claude gives a session it starts fresh (no title seam set). */
export const FAKE_SESSION_TITLE = 'Fake session: project notes'

/** Name the NEXT fresh session, so a spec can tell several apart. One-shot, and a file
 *  rather than an env var because Koloft spawns the session pty itself — there is no shell
 *  in between to export anything (fake-claude.js nextTitleFromFile). */
export function setNextSessionTitle(env: E2EEnv, title: string): void {
  fs.writeFileSync(path.join(env.home, 'fake-claude-next-title'), title)
}

/** One workspace's group in the sidebar: its head and everything listed under it. */
export function wsGroup(page: Page, wsName: string): Locator {
  return page.locator('.ws').filter({ has: page.locator('.ws-head', { hasText: wsName }) })
}

/** One workspace group's session rows (two workspaces are pinned by default, and both
 *  fixtures' sessions carry the same fake title — the group is what tells them apart). */
export function wsRows(page: Page, wsName: string): Locator {
  return wsGroup(page, wsName).locator('.ws-tab')
}

/** The C1 aux toggle by its accessible name — the order is fixed, and rewrites the
 *  roster: [Preview, Browser, Terminal] before the merge, [Workbench, Terminal] after
 *  (WB-L05 asserts the count is exactly two). 'Workbench' is accepted here already so a spec can be
 *  written against the merged titlebar without inventing a second locator. */
/** One titlebar aux icon by its label. `'Preview'` and `'Terminal'` are kept ONLY so a
 *  case can assert a retired icon is gone (FR-55 shrank the cluster to two, to one:
 *  a shell is a panel tab, opened by ⌃` / the menu / the strip's ＋): nothing paints them
 *  any more, so a locator for either should only ever be expected to have count 0. */
export function auxIcon(page: Page, which: 'Preview' | 'Workbench' | 'Terminal'): Locator {
  return page.locator(`.aux-ico[aria-label="${which}"]`)
}

/** C10 — the workspace picker, in either form (list for the global keys, gate for a
 *  per-workspace launch onto a behind-and-pullable target; §03). */
export function pickerDialog(page: Page): Locator {
  return page.locator('.modal.wspicker')
}

/** C8 — the worktree dialog, the one surface that still carries M4's six states (§04C). */
export function worktreeDialog(page: Page): Locator {
  return page.locator('.modal.worktreesess')
}

/** A dialog's morphing primary — Start / Pull & Start / Pulling… in C10, Create worktree
 *  “x” / Pull & Create… in C8. */
export function dialogPrimary(dlg: Locator): Locator {
  return dlg.locator('.modal-foot .btn-primary')
}

/** In a dialog that offers both methods, click the default one or the other one. Which
 *  method each button carries is the dialog's own business (the label names it); the
 *  button a spec means is the default or not, so that is what this selects on. */
export async function chooseBackend(page: Page, which: 'default' | 'other'): Promise<void> {
  const dialog = page.locator('.modal.wspicker, .modal.worktreesess')
  const start = dialog.locator(
    which === 'default'
      ? '.modal-foot button[data-default="true"]'
      : '.modal-foot button[data-default="false"]'
  )
  await expect(start).toBeEnabled()
  await start.click()
  await expect(dialog).toHaveCount(0)
}

/** The other method's own entrance (§03B): a workspace menu item that names it, so the
 *  click is the launch, exactly like New session. Only there when both are usable. */
export async function newSessionInWith(
  page: Page,
  wsName: string,
  method: 'Claude' | 'Codex'
): Promise<void> {
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page.locator('.menu .mi', { hasText: `New ${method} session` }).click()
}

/** Raise C10's list form through ⌘N's real menu item (the §0 seam). Only reaches the
 *  dialog when the picker is not skipped — several workspaces, or one that is
 *  behind-and-pullable (§03A). */
export async function openPicker(app: ElectronApplication, page: Page): Promise<Locator> {
  await clickAppMenuItem(app, page, 'new-session')
  const dlg = pickerDialog(page)
  await expect(dlg).toBeVisible({ timeout: 15_000 })
  return dlg
}

/** Open C8 for one workspace the way §0 says a spec must: through the fly-out, never a
 *  hover timer. The item is per-workspace, so no picker stands in between. */
export async function openWorktreeSession(page: Page, wsName: string): Promise<Locator> {
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page.locator('.menu .mi', { hasText: 'New worktree session' }).click()
  const dlg = worktreeDialog(page)
  await expect(dlg).toBeVisible({ timeout: 15_000 })
  return dlg
}

/**
 * Start a session in a pinned workspace the way a user does — right-click the
 * workspace head (the §0 menu rule), New session — and wait until SessionStart has
 * bound it. The click IS the launch now (§03B): the entrance names its own workspace,
 * so no dialog may appear, and this asserts that where every caller already stands.
 * "Bound" is read from the row leaving pending, not from the aux toggles: with a
 * session ALREADY running those are enabled before this launch even starts, and would
 * wave a still-pending one through.
 */
export async function startSessionIn(
  page: Page,
  wsName: string,
  opts: { remote?: boolean; method?: 'Claude' | 'Codex' } = {}
): Promise<void> {
  const rows = wsRows(page, wsName)
  const before = await rows.count()
  const titledBefore = await rows.filter({ hasText: FAKE_SESSION_TITLE }).count()
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  // with two methods usable the item names the default instead of saying "New session"
  await page
    .locator('.menu .mi', { hasText: opts.method ? `New ${opts.method} session` : 'New session' })
    .click()
  // the pending row lands immediately and promotes IN PLACE, so the group gains
  // exactly one row either way; the session is bound once no row is pending any more
  await expect(rows).toHaveCount(before + 1, { timeout: 30_000 })
  // …and by the time it did, any dialog the click might have raised would be on screen
  await expect(page.locator('.modal')).toHaveCount(0)
  await expect(page.locator('.ws-tab.st-pending')).toHaveCount(0, { timeout: 60_000 })
  // A remote session has no Workbench at all, so the icon never goes enabled for it
  // : its bind shows as the row wearing the title the fake claude reports.
  if (opts.remote) {
    await expect(rows.filter({ hasText: FAKE_SESSION_TITLE })).toHaveCount(titledBefore + 1, {
      timeout: 60_000
    })
    return
  }
  await expect(page.locator(SESSION_BOUND_ICON)).toHaveAttribute('aria-disabled', 'false', {
    timeout: 30_000
  })
}

/** The titlebar aux icon that goes enabled the moment a session binds — every spec in the
 *  suite waits on it through `startSessionIn`. merged the Eye and the Globe into one
 *  Workbench toggle (FR-55), and nothing paints the `Preview` spelling any more — the
 *  transitional half was dropped once the rename landed. */
const SESSION_BOUND_ICON = '.aux-ico[aria-label="Workbench"]'

/** What owns the focus right now, as a coarse label the DOM can report. In background
 *  test mode the window is never OS-focused (D8), so `document.activeElement` is the
 *  only falsifiable observable for the §03A focus chain. */
export function focusOwner(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el) return 'none'
    // the welcome panel lives INSIDE the TUI island, so it has to be checked first
    if (el.closest('.w-empty')) return 'welcome'
    if (el.closest('.term-island')) return 'tui'
    // D5/D7: the Workbench column is the second island the focus can live in — a
    // web tab's <webview>, the panel root, or a terminal tab's xterm all answer 'panel'
    if (el.closest('.wb-col')) return 'panel'
    return el.tagName.toLowerCase()
  })
}

/** The centre TUI's visible xterm (the session's own claude), never an aux shell. */
export function centerTerm(page: Page): Locator {
  return page.locator('.term-island .term-wrap:visible .xterm')
}

/** Type a command into ONE named terminal and submit it (real xterm keystrokes) —
 *  helpers/app.ts runInTerminal always picks the first visible one, which is the
 *  centre TUI whenever an aux pane is up. */
export async function runIn(page: Page, term: Locator, cmd: string): Promise<void> {
  await term.click()
  await page.keyboard.type(cmd)
  await page.keyboard.press('Enter')
}

/** Cold start is over: shortcut listeners attached AND the first rows push taken. Run
 *  again after a reload — a reloaded renderer boots through exactly the same window. */
export async function waitBooted(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as unknown as { __koloftShortcutsReady?: boolean }).__koloftShortcutsReady === true,
    undefined,
    { timeout: 20_000 }
  )
  await page.waitForFunction(
    () => (window as unknown as { __koloftRowsReady?: boolean }).__koloftRowsReady === true,
    undefined,
    { timeout: 20_000 }
  )
}

/** The pty ids behind the live session-tab xterms (the __koloftTerms test seam). After a
 *  reload, key-set equality with the pre-reload snapshot IS the adoption assertion:
 *  same ids ⇒ the same ptys were re-attached, none respawned. */
export function termIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(
      (window as unknown as { __koloftTerms?: Record<string, unknown> }).__koloftTerms ?? {}
    )
  )
}

// ---- the Workbench's terminal tabs --------------------------------------

/**
 * ⌃` / “New Terminal Tab”: open ONE terminal tab in the session that is currently
 * selected, and wait until its shell can take input (the pty runs Koloft's own PATH
 * setup line first — the same wait `openGlobalTerminal` paid for the former island).
 *
 * Requires a selected, bound, live session: with nothing selected the menu item and the
 * titlebar icon are both greyed (D1/R5) and this call would wait forever on a shell that
 * is never spawned. The shortcut IPC is sent only after the renderer's listener flag is
 * up — a forwarded shortcut that lands before that effect ran is dropped on the floor.
 *
 * It also waits for the TERMINAL ICON to go live before sending, which is the readiness
 * signal a user actually goes by: the icon and ⌃` share one gate (R5 — a bound tab whose
 * claude is still alive), so the icon losing `aria-disabled` is the product saying the
 * shortcut will be honoured. `startSessionIn` is not enough on its own — it waits on the
 * WORKBENCH icon, which only means "bound". A shortcut is not a menu click and does not
 * meet the enabled flag on the way in: `newTerminalTab` drops it silently when the gate is
 * unsatisfied, so the failure surfaces 40 seconds later as a shell that never appeared.
 */
export async function openSessionTerminal(app: ElectronApplication, page: Page): Promise<Locator> {
  await page.waitForFunction(
    () =>
      (window as unknown as { __koloftShortcutsReady?: boolean }).__koloftShortcutsReady === true,
    undefined,
    { timeout: 20_000 }
  )
  // name the contract before waiting on it: a renamed menu id would otherwise surface as
  // a 40-second timeout on a locator, which says nothing about what actually broke
  const hasItem = await app.evaluate(
    ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('new-terminal-tab') != null
  )
  if (!hasItem) throw new Error('no application-menu item with id "new-terminal-tab"')
  // the shortcut and the menu item share one gate (R5); a forwarded IPC never meets the
  // menu's `enabled` flag, so a send before the gate opens is dropped in silence. Wait on
  // the gate itself. (The titlebar Terminal icon that used to carry this signal is gone —
  // ⌃`, the menu item and the strip's ＋ are the three doors now.)
  await expect
    .poll(
      () =>
        app.evaluate(
          ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('new-terminal-tab')?.enabled
        ),
      { timeout: 30_000 }
    )
    .toBe(true)
  const before = await page.locator('.wb-panel .wb-term').count()
  await sendShortcut(app, 'shortcut:new-terminal-tab')
  await expect(page.locator('.wb-panel .wb-term')).toHaveCount(before + 1, { timeout: 40_000 })
  await expect(panelTerm(page)).toBeVisible({ timeout: 40_000 })

  // The shell is VISIBLE well before it can take input: the pty runs Koloft's own PATH
  // setup line first, and a command typed across that window comes out garbled or lost.
  // Ask the shell to say when it is listening rather than guessing at a duration — a fixed
  // sleep is either too short on a loaded machine (a lost first command, surfacing later as
  // a mystery timeout in whatever the caller asserted next) or wasted seconds every call.
  //
  // The signal is the pty going QUIET on a non-empty screen: the setup line has echoed,
  // the prompt is painted, and nothing more is arriving. Reading it rather than typing it
  // matters — an earlier version sent `echo <marker>` on a retry loop and interleaved with
  // the setup line, garbling the shell badly enough to break four unrelated cases
  // downstream. The helper must not put anything in the scrollback a case might later
  // assert on, so it types nothing at all.
  // The screen is read through `window.__koloftTerms`, never off the DOM. Under the real
  // WebGL renderer — which webgl-repair.spec gets by deleting KOLOFT_DOM_RENDERER — xterm
  // paints on a canvas and carries no text nodes at all, so `innerText` is permanently
  // empty and a DOM-based version of this wait can only ever time out. The seam holds the
  // live xterm instance and answers under both renderers (seam comment: TerminalView.tsx).
  const term = panelTerm(page)
  const ptyId = await page.locator('.wb-panel .wb-term:visible').getAttribute('data-pty')
  if (!ptyId) throw new Error('the visible terminal tab carries no data-pty')

  let last = ''
  let stableSince = 0
  await expect
    .poll(
      async () => {
        const now = (
          await page.evaluate((id) => {
            const t = (
              window as unknown as {
                __koloftTerms?: Record<
                  string,
                  {
                    buffer: {
                      active: {
                        length: number
                        getLine(
                          i: number
                        ): { translateToString(trim?: boolean): string } | undefined
                      }
                    }
                  }
                >
              }
            ).__koloftTerms?.[id]
            if (!t) return ''
            const b = t.buffer.active
            const out: string[] = []
            for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
            return out.join('\n')
          }, ptyId)
        ).trim()
        if (now !== last || now === '') {
          last = now
          stableSince = Date.now()
          return false
        }
        if (stableSince === 0) stableSince = Date.now()
        return Date.now() - stableSince >= 700
      },
      { intervals: [200], timeout: 40_000 }
    )
    .toBe(true)
  return term
}

/**
 * The visible shell inside the Workbench panel — a `terminal` tab's xterm.
 *
 * Both prefixes are load-bearing. `.wb-panel` keeps it off the centre TUI's xterm, and
 * `.wb-term:visible` picks the ACTIVE terminal tab out of the several that stay mounted:
 * every live conversation tab's shells are kept in the DOM and merely
 * `visibility:hidden` (R8), because main stores no scrollback and unmounting loses it.
 */
export function panelTerm(page: Page): Locator {
  return page.locator('.wb-panel .wb-term:visible .xterm')
}

/**
 * The pid of the shell in the ACTIVE terminal tab, read from the shell itself.
 *
 * A process-boundary observable, which is the point: it survives the DOM entirely, so
 * “this tab's shell is still the same one / really died” can be asserted without
 * trusting any renderer state. (The island-era twin was `gtShellPid`.)
 */
export async function panelShellPid(page: Page, marker: string): Promise<number> {
  await runIn(page, panelTerm(page), `echo ${marker}_$$`)
  let pid = 0
  await expect
    .poll(
      async () => {
        const text = await panelTerm(page).innerText()
        const m = text.match(new RegExp(`${marker}_(\\d+)`))
        pid = m ? Number(m[1]) : 0
        return pid
      },
      { timeout: 25_000 }
    )
    .toBeGreaterThan(0)
  return pid
}

/**
 * Which island is wearing the focus ring (D5) — `'tui'`, `'panel'`, `'both'`, or neither.
 *
 * Read from `borderTopColor`, never `borderColor`: the shorthand comes back as the empty
 * string whenever the four sides differ, which is a silent “neither is lit” for every
 * assertion built on it. A collapsed panel is excluded by `:not(.off)` — its border is
 * zero-width and cannot be lit anyway.
 *
 * The accent is resolved through a THROWAWAY ELEMENT rather than read off the root's
 * custom property. `getPropertyValue('--accent-line')` hands back the token's raw text,
 * which is comparable to a computed border colour only while the token happens to be
 * spelled as an `rgba()` literal. The day it becomes `#f60`, a `color-mix()`, or merely
 * gains a space, nothing would ever match again and every focus-ring assertion would go
 * quietly green in the "neither is lit" direction. Assigning it to `border-top-color` on a
 * probe makes the engine normalise it exactly as it normalises the real border.
 *
 * Both islands are measured in ONE pass, so `'panel'` already carries “and the TUI is
 * NOT lit”. A build that lit BOTH answers `'both'`, never `'none'`: D5 says exactly one
 * island wears the ring, and folding that failure in with an ordinary unfocused window
 * would report a real defect under the word for the healthy case.
 * `islandBorderColors` is there for a case that wants to spell the inequality out.
 */
export function litIsland(page: Page): Promise<'tui' | 'panel' | 'both' | 'none'> {
  return page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.borderTopColor = 'var(--accent-line)'
    probe.style.display = 'none'
    document.body.appendChild(probe)
    const accent = getComputedStyle(probe).borderTopColor.replace(/\s+/g, '')
    probe.remove()

    const lit = (sel: string): boolean => {
      const el = document.querySelector(sel) as HTMLElement | null
      return !!el && getComputedStyle(el).borderTopColor.replace(/\s+/g, '') === accent
    }
    const tui = lit('.island.term-island')
    const panel = lit('.island.wb-col:not(.off)')
    if (tui && panel) return 'both' as const
    if (tui) return 'tui' as const
    if (panel) return 'panel' as const
    return 'none' as const
  })
}

/** The two islands' border colours and the accent they are compared against, for a case
 *  that asserts the lit one EQUALS the accent and the dark one does not. */
export function islandBorderColors(
  page: Page
): Promise<{ tui: string; panel: string; accent: string }> {
  return page.evaluate(() => {
    const flat = (c: string): string => c.replace(/\s+/g, '')
    const colorOf = (sel: string): string => {
      const el = document.querySelector(sel) as HTMLElement | null
      return el ? flat(getComputedStyle(el).borderTopColor) : ''
    }
    return {
      tui: colorOf('.island.term-island'),
      panel: colorOf('.island.wb-col:not(.off)'),
      // same probe trick as `litIsland`, and for the same reason
      accent: (() => {
        const probe = document.createElement('div')
        probe.style.borderTopColor = 'var(--accent-line)'
        probe.style.display = 'none'
        document.body.appendChild(probe)
        const v = flat(getComputedStyle(probe).borderTopColor)
        probe.remove()
        return v
      })()
    }
  })
}

// ---- sidebar fly-out menus -----------------------------------------------------------

/** §0 menu rule: e2e opens fly-outs by right-click (instant, no 350ms hover timing). */
export async function openMenu(page: Page, target: Locator): Promise<Locator> {
  await target.click({ button: 'right' })
  const menu = page.locator('.menu')
  await expect(menu).toBeVisible()
  return menu
}

/** Menu item texts (head excluded), whitespace-normalized for exact-set asserts. */
export async function menuItemTexts(page: Page): Promise<string[]> {
  const texts = await page.locator('.menu .mi:not(.head)').allTextContents()
  return texts.map((t) => t.replace(/\s+/g, ' ').trim())
}

export async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.locator('.menu')).toHaveCount(0)
}
