# test/ — project-specific test facts

This file holds only what a NEW test has to know and cannot learn from the file it
is about to touch: the conventions of each layer, and the shared vocabulary the
specs are written in. A fact about one helper, seam or fixture lives in that file's
names and tests, in a contract ledger (`docs/*-contract.md`), or in an ADR it cites
— read the file you are about to use, not this one. General test methodology (what
earns a test, red-first, black-box boundaries) is deliberately not written down here.

## Commands

- `npm run test:unit`  — Vitest, pure Node, hermetic; the fast layer.
- `npm run test:unit:changed` — the same, only the files reachable from what this
  branch changed against `main` (vitest `--changed`).
- `npm run test:e2e`   — Playwright drives the real built app. Needs
  `npm run build` first (rebuild rules: root CLAUDE.md).
- `npm test`           — both.

## Unit layer (test/unit/)

- There is no global `$HOME` sandbox (vitest has no setupFiles). Anything a module
  reads once as it loads — `HOME`, the sessionTracker timing knobs (`KOLOFT_*_MS`; an
  explicit 0 counts), `TZ` — is set *before dynamically importing* the module under
  test (patterns: sessionTracker.test.ts, schedule.test.ts).
- Module-level state survives a store reset. The renderer store and editRegistry keep
  per-tab state, so give each case its own tab ids (restartSession.test.ts); a module
  with a one-shot latch is imported fresh per test with `vi.resetModules`
  (updater.test.ts).
- node-pty is built for Electron and cannot load under plain Node: `vi.mock('node-pty')`
  and check what reaches `spawn` (ptyManager.test.ts).
- A suite that covers a script Koloft writes to disk (`shim`, `openShim`, `hooks`)
  or a process it inspects (`claudeLiveness`) executes the real thing, with fake
  binaries on PATH recording argv. Never reimplement the script logic inside a test.
- A fake binary is an `sh` script with the real name, first on PATH — never a renamed
  copy of a signed system binary (platform ledger §3). It hands everything it does not
  fake to the real binary (a stray `exit 1` looks like a product bug), and hangs with
  `exec sleep`, since a bare `sleep` outlives it as an orphan.

## E2E layer (test/e2e/)

### Launching and ending

- One spec per user-visible flow. A spec starts a session the way the product does
  — `startSessionIn` / `openWorktreeSession` (helpers/p1.ts) — and reuses that
  file's helpers. Fixture workspaces live in helpers/env.ts.
- `setupE2EEnv` pins ws-a and ws-b (so ⌘N always shows the C10 picker) and turns on
  an open Workbench (`workbench.defaultOpen`). A case that needs the panel shut calls
  `seedWorkbenchDefault(env, false)`; a case about the shipped default deletes the
  block with the app down instead (workbench-layout
  `unseedWorkbenchDefaultWhileAppDown`) — a seeded `false` would pass against a build
  that still ships it open.
- The `app`/`page` fixtures launch before the test body runs. Main reads its launch
  env, its Chromium args and layout.json/userData ONCE at startup, so a case that
  needs `env.launchEnv`, `env.extraArgs`, a seeder (`seedWorkbench*`, `seedJsonl`,
  `setupGitFixture`, `setGuestLimit`, …) or two launches on one home asks only for
  `env` and calls `launchApp` / `launchSettled` itself.
- End every app you launched with `quitAndClose`; a case that leaves unsaved editor
  text ends with `closeDiscardingEdits`. A plain `app.close()` hangs on the
  unsaved-changes question.

### Sessions, terminals and the fake claude

- `fixtures/fake-claude.js` is the `claude` the shim runs. It stands in only for the
  LLM, and is steered by sentinel FILES under `<home>`, never env vars (Koloft spawns
  the pty itself, so a spec has no shell to export into). What it does:
  - flags: `-w <name>` makes a real `.claude/worktrees/<name>` on branch
    `worktree-<name>`; `-- <text>` types `<text>` first, in place of the canned
    startup turn (ADR-0020).
  - files: `fake-claude-delay` (ms before it binds), `-next-title` (title of the next
    fresh launch, used once), `-no-status` (binds but never reports a run-state),
    `-exit` (exits with that code, no hook), `-lazy` (no transcript until the first
    typed line), `-hang` (never binds, and has no signal handler, so the SIGHUP that
    closes its tab kills it).
  - typed lines: `/write <path>` (a Write, Stop 2.5 s later — the file on disk proves
    the transcript has it), `/busy` (a turn held open ~30 s), `/need-approval`,
    `/scratch <name>`, `/open <target>`, `/open-later <target>` (fires once
    `<home>/go-open` exists), `/clear`, `/compact`, `/resume <id>`, `/exit`,
    `/enter-worktree <name>`, `/exit-worktree`, `/bg-work`, `/bg-reported`,
    `/bg-monitor`, `/bg-shell`. Any other line is a prompt answered by a Read and a
    Stop.
  - every launch writes one line to `env.claudeCalls` (argv, cwd, session id,
    injected auth) before any delay.
  - its canned startup turn writes NOTES.md into its cwd, so a git fixture it runs in
    lists NOTES.md in the first commit's .gitignore.
  - its transcript lands a moment after it binds: before closing an app whose
    transcript a relaunch will read, wait for the turn's Stop.

  A session that never shows a title or usage most likely got a broken injected
  settings.json: the hooks are the only way a session binds.
- A row without `.cold` may still be pending. The bind barrier is a run-state class
  (`st-working` / `st-waiting`) or `waitPanelAttached` — a resumed session binds a
  moment after its row reads running (`startSessionIn` already waits). A SIGKILL then
  resume in the same run never binds, so a real before-bind window needs an app
  restart.
- Start worktree sessions in one repo one at a time: `git worktree add`s running at
  once race each other.
- Never SIGKILL a remembered pid directly — go through `killSession(pid, env)`
  (helpers/p1.ts). It kills only if the pid's command line still names this env's
  home, because pids are reused within one run (platform ledger §3) and a blind kill
  can hit another worker's session.
- The only shell the product has is the SELECTED session's terminal tab
  (`openSessionTerminal` + `panelTerm`). It needs a bound, live session, and
  opening it EXPANDS the Workbench panel — a case that needs the panel shut fires
  its command behind a `sleep` and collapses inside that window (worked examples:
  workbench-tabs WB-T20, workbench-aux T-AUX-02). It waits for the screen to go quiet
  and types nothing: an `echo <marker>` readiness probe, typed across the shell's
  PATH setup line, garbled the shell and broke four later cases. Read terminal text through
  `window.__koloftTerms`, never the DOM. To type into a session that is not on screen,
  call `window.api.terminal.write(tabId, line + '\r')`.
- A session pty is a login shell, so the real `/usr/bin` tools beat the suite's
  recording fakes (platform ledger §2). Reach a fake through the agent, or re-export
  PATH in the shell first (browser-routing BB-C11).
- Remote workspaces: the other machine is helpers/remote.ts + fixtures/fake-ssh.js,
  with nothing in the product stubbed. A remote row's state arrives one mirror pull
  late, so drive working → waiting with `/busy`, not a short turn.

### Keys, focus and the hidden window

- Native menu accelerators are unreachable from Playwright's synthetic keys — send
  the IPC (`sendShortcut`) or click the menu item (`clickAppMenuItem`). Which island
  a key belongs to is decided by FOCUS, so click the target area first. Dialog-local
  keys (⏎/Esc/digits/arrows/typing inside C8/C9/C10) are renderer keydown — plain
  `page.keyboard`. The app drops a shortcut sent before its first rows push, on
  purpose: send one only after `waitSettled` / `launchSettled` (`clickAppMenuItem`
  waits for the shortcut listeners, not for the first rows push). Find a dialog by
  its visible title.
- The test window never has OS focus. Read focus from `focusOwner` /
  `document.activeElement`, never `document.hasFocus()` (platform ledger §10). For the
  same reason no tab is ever "watched": every finished turn leaves an attention mark,
  seen only through `pendingAttention(page)`, and main's `__koloftOsNotifCount` must
  stay 0.
- Never reach real OS UI or the developer's own state. No native dialog: stub and count
  it (restart-session `countConfirmationsInsteadOfShowingThem`). File pickers answer
  from a queue (`answerFileDialog`; an empty queue means "cancelled"); add workspaces
  with `addWorkspace`. No real clipboard: stub `navigator.clipboard` or main's
  `clipboard` (browser-nfr BB-N05). OS hand-offs launch nothing and land in
  `<home>/external-opens.txt`. Never click "Download & Restart".
- A hint card closes on any mousedown outside it, so while one is up change the UI
  through `clickAppMenuItem`. A second session in one workspace raises the "worktree"
  hint over the rows: dismiss it before clicking a row.

### Waiting

- Every "nothing happened" check follows a positive barrier — the product's own "No
  matches" line, a file fake-claude wrote, a saved stamp. Where none can exist, wait a
  named settle constant, never a bare number. `toHaveCount(0)` is true before the work
  starts, and true again once a 4 s toast has gone: to prove no toast, sample across a
  window (cron-edge `expectNoToastAtAnyMomentOfAWindow`). For the same 4 s, check a
  toast that should be there before any slower wait — a session bind alone outlives
  it (git-pull-start).
- Wait on what the product shows or writes, never on the send: IPC posts such as
  `sendSave` return before the work is done, and fake-claude's echoes wrap at 80
  columns.
- After a click on a session row, the Workbench still shows the old session for two
  frames (ADR-0011): poll, don't read once.

### Selectors

- The app has no `data-testid`s: prefer role/text/stable-class selectors. Workbench,
  Browser and edit-pane selectors are constants — `WORKBENCH` (helpers/workbench.ts),
  `BROWSER` (helpers/browser.ts), `EDIT` (helpers/editPane.ts). Their traps:
  - The pinned `files` tab is always in the strip, so a tab count is off by one: count
    `BROWSER.tabOpen` / `openTabs()`.
  - Hidden things stay mounted: an inactive tab's body is `visibility: hidden`, every
    visited file tab keeps a hidden `.wb-artifact`, and every live session's terminals
    stay mounted. Use `artifactBody()` / `panelTerm()`, never the bare class, and click
    `WORKBENCH.tabFiles` before touching rows in the Files tab.
  - Shared classes: `.wb-bar` + `.wb-title` is both the reading-area header and a file
    tab's bar (`readingTitle`, `EDIT.tabEdit` / `EDIT.readEdit` say which). The Notes
    island reuses `.ed-area`, `.wb-bar`, `.wb-title`, `.icobtn` and the edit pane, so
    root Workbench selectors at `.wb-panel` / `.wb-col` and the note's at
    `notesIsland(page)`. `.ft-node` is both a Browse and a Changes row: scope Browse
    by `.bv-body` or `.bv-sec[data-section]` (one file can show in the tree,
    Bookmarks and Recents at once). A bare `.ft-chip` also matches the Filter menu:
    use `[data-chip=…]`.
  - The file-row context menu is portalled to `body` (ADR-0013): root it at the page.
  - `showBrowse()` opens a shut panel first, so it cannot drive a case about "this
    gesture opens the panel".
  - Find a web guest by URL (`guestByUrl`), never by index.
- Playwright traps: `hasText` with a string is a case-insensitive substring — use a
  regex (the word "notes" also hits NOTES.md and ws-a's notes.xyz; pick the Notes
  island by `.isl-notes`). A `page.evaluate` callback is serialized, so it cannot use
  `WORKBENCH` or any outer constant, and `:visible` is a syntax error inside it.
  `toBeVisible` ignores scroll clipping: compare bounding rects. A click scrolls its
  target into view first, so read a scroll offset after the click. A chained selector
  resolves under its parent: `tabCloseIn` under a tab, `tabClose` only from the page.

### Test-only seams

- `KOLOFT_TEST_BACKGROUND=1` is the one switch that means "a test is driving the
  app" (`window.api.testMode` in the renderer); the few product branches for tests
  sit behind it. Every other seam is an env var read in one place — main, or
  `src/preload/index.ts` for the renderer — so grep its name. All are inert in
  production.
- Always on (set by `helpers/env.ts`): `KOLOFT_TEST_BACKGROUND`, `KOLOFT_DOM_RENDERER`,
  `KOLOFT_CLAUDE_CMD`, `KOLOFT_KEYCHAIN_FILE`, `KOLOFT_SCRATCHPAD_BASE`,
  `KOLOFT_SUPPRESS_OS_OPEN`, `KOLOFT_EXTERNAL_OPENS_FILE`, `KOLOFT_DOWNLOAD_DIR`,
  `KOLOFT_CDP_LOG`, `KOLOFT_FILE_DIALOG_FILE`.
- Per spec, read once at startup, so set in `env.launchEnv` before launching by hand:
  `KOLOFT_BROWSER_TAB_CAP`, `KOLOFT_BROWSER_GUEST_LIMIT`, `KOLOFT_GITHUB_FIXTURE`,
  `KOLOFT_EXT_INSTALL_DIRS`, `KOLOFT_TEST_NO_ADOPT`, `KOLOFT_TEST_CLAUDE_PROBE`,
  `KOLOFT_PROBE_BASE_URL`, `KOLOFT_UPDATE_FIXTURE`, `KOLOFT_RELEASES_URL`,
  `KOLOFT_CRON_BIND_DEADLINE_MS`, `KOLOFT_GIT_TIMEOUT_MS`, the sessionTracker
  `KOLOFT_*_MS` knobs, and the fakes' `KOLOFT_FAKE_*` inputs. The files behind
  `KOLOFT_FILE_DIALOG_FILE` and `KOLOFT_UPDATE_FIXTURE` are read on every use, so a
  spec may rewrite them after launch.
- Not env vars: `window.__koloftTerms` (terminal text), `__koloftShortcutsReady` /
  `__koloftRowsReady` (the renderer is ready for keys), main's
  `globalThis.__koloftOsNotifCount`, and `installGitSpawnLog` (the git the app runs).
  When a CDP relay test waits for a message that never comes, read
  `<home>/cdp-log.txt`: it holds the relay's whole conversation.

## Component & case numbers used in specs and test titles

C-numbers come from the original design and live on as
shared vocabulary: C1 titlebar · C2 sessions island (sidebar rows) · C3 files
island · C4 TUI island (its header band is retired) · C5 aux Preview · C6 aux
Terminal (retired — the global terminal island took over, and was itself retired in
turn: a shell is a `terminal` tab inside the session's Workbench panel) · C7 the old
new-session dialog · C8 New Worktree Session dialog · C9 Restore
session dialog · C10 mini workspace picker (list + gate forms). S1–S4 were its
composed screens; V0 its icon/type/color ladder (pinned by `styleVars.test.ts` +
`spec.spec.ts`). T-* and BB-* case ids come from the original test plan and black-box
case files — the spec carrying an id IS its contract now: report a wrong case, don't
rewrite it in place.
