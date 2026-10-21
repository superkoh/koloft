# test/ — project-specific test facts

This file holds only what a new test has to know and cannot learn from the file it
is about to touch: the conventions of each layer, and the shared vocabulary the
specs are written in. A fact about one helper, seam or fixture lives in that file's
names and tests, in a contract ledger (`docs/*-contract.md`), or in an ADR it cites
— read the file you are about to use, not this one. General test methodology (what
earns a test, red-first, black-box boundaries) is deliberately not written down here.

## Commands

- `npm run test:unit`  — Vitest, plain Node (jsdom for component tests), no app; the
  fast layer.
- `npm run test:unit:changed` — the same, only the files reachable from what this
  branch changed against `main` (vitest `--changed`).
- `npm run test:e2e`   — Playwright drives the real built app. Needs
  `npm run build` first — Playwright never builds (root CLAUDE.md).
- `npm test`           — both.
- `node scripts/real-window-mac.mjs tart|here` — the real-window layer (below); never
  part of `npm test`.

## Unit layer (test/unit/)

- A component test is a `.test.tsx` whose first line is `// @vitest-environment jsdom`;
  it renders with `@testing-library/react` and calls `cleanup` in `afterEach` (vitest
  globals are off, so nothing cleans up for it) — sessionBackendIcon.test.tsx. Every
  other file runs in plain Node.
- There is no global `$HOME` sandbox (vitest has no setupFiles). Anything a module
  reads once as it loads — `HOME`, the session timing knobs (`KOLOFT_*_MS`, read through
  `envMs` in sessionRuntime.ts and sessionTracker.ts; an explicit 0 counts), `TZ` — is
  set *before dynamically importing* the module under test (pattern:
  sessionTracker.test.ts; schedule.test.ts simply sets `TZ` on its first line).
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
  an open Workbench (`workbench.defaultOpen`), and launches with Chromium's fake mic and
  camera, so a media request reaches the permission prompt on a machine without them
  (platform ledger §11). A case that needs the panel shut calls
  `seedWorkbenchDefault(env, false)`; a case about the shipped default deletes the
  block with the app down instead (workbench-layout
  `unseedWorkbenchDefaultWhileAppDown`) — a seeded `false` would pass against a build
  that still ships it open.
- The `app`/`page` fixtures launch before the test body runs. Main reads its launch
  env, its Chromium args and layout.json/userData once at startup, so a case that
  needs `env.launchEnv`, `env.extraArgs`, a seeder (`seedWorkbench*`, `seedJsonl`,
  `setupGitFixture`, `setGuestLimit`, …) or two launches on one home asks only for
  `env` and calls `launchApp` / `launchSettled` itself.
- The `app` fixture ends its app with `quitAndClose`. A plain `app.close()` hangs once
  any editor text is unsaved, because the renderer then holds the quit for the
  unsaved-changes question — so an app you launched yourself that may have unsaved text
  ends with `quitAndClose` (`closeDiscardingEdits` is the same call, named for that
  case).

### Sessions, terminals and the fake claude

- `fixtures/fake-claude.js` is the `claude` the shim runs. It stands in only for the
  LLM. Its `KOLOFT_FAKE_*` env inputs come from `env.launchEnv`, so they hold for every
  launch in one app run; to steer one launch or one moment, it reads sentinel files under
  `<home>`, which a spec may write at any time (Koloft spawns the pty itself, so a spec
  has no shell to export into). What it does:
  - flags: `-w <name>` makes a real `.claude/worktrees/<name>` on branch
    `worktree-<name>`; `-- <text>` types `<text>` first, in place of the canned
    startup turn (ADR-0020); `setup-token` prints a login token the way the real one
    does (`KOLOFT_FAKE_SETUP_TOKEN`, `KOLOFT_FAKE_SETUP_URL`); `--version` prints a
    version above any minimum, so the shim's version check never updates it.
  - files: `fake-claude-delay` (ms before it binds), `-next-title` (title of the next
    fresh launch outside the butler's folder, used once), `-no-status` (binds but never reports a run-state),
    `-exit` (exits with that code, no hook), `-lazy` (no transcript until the first
    typed line), `-hang` (never binds, and has no signal handler, so the SIGHUP that
    closes its tab kills it), `-bg-ms` (how long `/bg-reported`'s background work runs,
    5 s when absent), `-remove-ms` (how long removing a worktree at `/exit` takes; a
    SIGHUP meanwhile leaves it unremoved), `-remove-fails` (that removal prints CC's
    failure line and leaves the worktree).
  - typed lines: `/write <path>` (a Write, Stop 2.5 s later — the file on disk proves
    the transcript has it), `/answer <text>` (`<text>` as the prompt, `Answer to: <text>`
    as the reply's text, then Stop), `[Discord] <text>` (answered like `/answer` with the
    whole line), `/long <n>` (a
    reply of `line 1` … `line <n>`), `/ask <question>|<option>|…` and `/bash <command>`
    (fire PermissionRequest without blocking, and reply `Picked: <answer>` / `Ran: <command>`
    on allow, `Denied: <message>` on deny; a hook that answers nothing — every remote tab's —
    leaves the dialog on screen: it fires a permission Notification and takes one key, a
    digit picks that option and `1` runs the command), `/busy` (a turn held open ~30 s), `/need-approval`,
    `/scratch <name>`, `/move-to-background` (a start for a session that never writes a
    transcript, then `continued-in` to a new id whose Stop follows), `/open <target>`, `/open-later <target>` (fires once
    `<home>/go-open` exists), `/koloft <args>` (runs the agent command, then prints its
    output and `koloft exit=<code>`, with no hook and no transcript line), `/sh <command>`
    (the same for any shell command, as Claude's Bash tool would run it with the
    session's env, ending `sh exit=<code>`), `/clear`,
    `/compact` (PreCompact, a compact SessionStart, then the "Compacted" line Claude
    writes), `/compact-while-idle` (Claude compacting a finished session on its own:
    the `idle_prompt` Notification, then an `auto` PreCompact and a compact
    SessionStart, with no prompt and no Stop around them), `/context` (the two records Claude writes for it), `/resume <id>`, `/exit` (also
    `exit` and `/quit`; in a `-w` worktree with uncommitted files it first asks keep or
    remove, and a typed `2` removes; a removal prints what CC prints, CC§4),
    `/enter-worktree <name>`, `/exit-worktree`, `/bg-work`, `/bg-reported`,
    `/bg-monitor`, `/bg-shell`. Any other line is a prompt answered by a Read and a
    Stop, its UserPromptSubmit hook given the line as `prompt`. Esc keystrokes are dropped from a typed line (its pty hands over whole lines,
    so an Esc Koloft presses lands inside the next one). A bracketed paste
    (`ESC[200~` … `ESC[201~`) waits, as in the real input box, until the Enter after
    it, and is then one prompt together with what was typed after it; fake-codex
    keeps one in its composer the same way.
  - every launch writes one line to `env.claudeCalls` (argv, cwd, session id,
    injected auth) before any delay — except a `-p` Koloft runs itself (the title
    call, task piped on stdin; the remote launch's first-run warm-up, output sent to
    /dev/null), which prints `<first line of the task> (titled)` and exits unlogged; a
    `-p` typed in a terminal is logged like any launch. Asked which docs are for the
    reader, it picks every written file whose name does not start with `draft-`, plus
    every absolute `.md`/`.html` path in the reply. While `<home>/fake-claude-assist-reply`
    exists, every such `-p` instead prints that file as Assist's answer (after
    `fake-claude-assist-ms` ms, when that file exists) and appends what it was asked to
    `fake-claude-assist-asked.txt`.
  - like the real one, it lists itself in `<home>/.claude/sessions/<pid>.json` with a
    message socket (CC§11); each line written there is appended raw to
    `<home>/fake-claude-peer.jsonl` and taken as a peer message (its UserPromptSubmit hook
    gets the content as `prompt`, and any `additionalContext` the hook prints lands in the
    transcript as a `hook_additional_context` record; reply `Peer said: <content>`, then
    Stop). A `--name` shows as its registry name.
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
- The only shell the product has is the selected session's terminal tab
  (`openSessionTerminal` + `panelTerm`). It needs a bound, live session, and
  opening it expands the Workbench panel — a case that needs the panel shut fires
  its command behind a `sleep` and collapses inside that window (worked examples:
  workbench-tabs WB-T20, workbench-aux T-AUX-02). It waits for the screen to go quiet
  and types nothing: an `echo <marker>` readiness probe typed too early can land on
  the shell's PATH setup line and garble it (it once broke four later cases). Read
  terminal text through
  `window.__koloftTerms`, never the DOM. To type into a session that is not on screen,
  call `window.api.terminal.write(tabId, line + '\r')`.
- A session pty is a login shell, so the real `/usr/bin` tools beat the suite's
  recording fakes (platform ledger §2). Reach a fake through the agent, or re-export
  PATH in the shell first (browser-routing BB-C11).
- Remote workspaces: the other machine is helpers/remote.ts + fixtures/fake-ssh.js
  (with fake-tmux.js and fake-rsync.js), with nothing in the product stubbed. A remote row's state arrives one mirror pull
  late, so drive working → waiting with `/busy`, not a short turn.
- Codex sessions: the `codex` is fixtures/fake-codex.js, installed per case by
  `installCodex` (helpers/env.ts) (it sets `KOLOFT_CODEX_CMD` and `CODEX_HOME`).
  Without it, `KOLOFT_CODEX_CMD` is a bare name, not a path, so Codex reads as not
  installed whatever the developer's own login shell has. A Codex tab on the fake remote
  needs `installCodexOnFakeRemote` (helpers/remote.ts), which also puts fake-codex on
  the machine and gives the Mac account a token; what the machine's app-server did lands
  in the machine home's `fake-codex-*.jsonl` (`machineCodexLog`).
- Muse sessions: the `muse` is fixtures/fake-muse.js, installed per case by `installMuse`
  (helpers/env.ts, sets `KOLOFT_MUSE_CMD`); without it `KOLOFT_MUSE_CMD` is a bare name, so
  Muse reads as not installed. It asks Muse's trust question unless `trust.json` under
  `<home>/.config/muse` trusts the folder or it got `--trust-workspace`.
- Antigravity sessions: the `agy` is fixtures/fake-agy.js, installed per case by
  `installAgy` (helpers/env.ts, sets `KOLOFT_AGY_CMD` and adds an API-key account);
  without it agy reads as not installed. It asks agy's trust question unless the owner's
  `~/.gemini` settings trust the folder (`trustInAgy`), logs every launch to
  `<home>/fake-agy-calls.jsonl` (the account probe's `-p /usage` and `--version` too),
  and serves agy's local API. On the fake remote machine `installRemoteAgy`
  (helpers/remote.ts) puts it at `.local/bin/agy` and trusts the remote folder.

### Keys, focus and the hidden window

- Native menu accelerators are unreachable from Playwright's synthetic keys — send
  the IPC (`sendShortcut`) or click the menu item (`clickAppMenuItem`); a case about the
  key itself belongs in the real-window layer. Which island
  a key belongs to is decided by focus, so click the target area first. Dialog-local
  keys (⏎/Esc/digits/arrows/typing inside C8/C9/C10) are renderer keydown — plain
  `page.keyboard`. The app drops a shortcut sent before its first rows push, on
  purpose: send one only after `waitBooted` (helpers/p1.ts) or `launchSettled`
  (helpers/blackbox.ts); `clickAppMenuItem` waits for the shortcut listeners, not for
  the first rows push. Find a dialog by its visible title.
- The test window never has OS focus. Read focus from `focusOwner` /
  `document.activeElement`, never `document.hasFocus()` (platform ledger §10). Every
  finished turn leaves an attention mark, seen through `pendingAttention(page)`, and
  only the session working again clears it — looking at the tab clears only a mark that
  is only news (`fyi`). No OS
  notification or Dock badge is ever shown; what one would have said is recorded
  instead and read with `osOutlets(app)` (helpers/app.ts). A case about what a user
  watching the tab is spared (the sound, the notification) calls
  `pretendWindowFocused(app)`: main then reads its window as focused.
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
  window (`expectNoToastAtAnyMomentOfAWindow`, helpers/app.ts). For the same 4 s, check a
  toast that should be there before any slower wait — a session bind alone outlives
  it (git-pull-start).
- Wait on what the product shows or writes, never on the send: IPC posts such as
  `sendSave` return before the work is done, and fake-claude's echoes wrap at 80
  columns.
- After a click on a session row, the Workbench still shows the old session for two
  frames (T-SWITCH-04): poll, don't read once. Its file tabs mount again only then
  (ADR-0016): wait for the remount before touching one.

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
    `notesIsland(page)` / `notesArea(page)`. `.ft-node` is both a Browse and a
    Changes row: find a Browse row with `browseRow(page, path, section)` or
    `WORKBENCH.browseRows` (one file can show in the tree, Bookmarks and Recents at
    once). A bare `.ft-chip` also matches the Filter menu: use `[data-chip=…]`.
  - The file-row context menu is portalled to `body` (ADR-0013): reach it with
    `rowMenu(page)` / `rowMenuItems(page)`.
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
- While Koloft's own tooltip shows (the mouse rests 600 ms on a titled element,
  `titleTips.ts`), that element's `title` reads `''` until the mouse leaves: read or
  select by `title` before hovering, or move the mouse away first. A click hides the
  tip and puts the title back at once.

### Test-only seams

- `KOLOFT_TEST_BACKGROUND=1` is the one switch that means "a test is driving the
  app" (`window.api.testMode` in the renderer); the few product branches for tests
  sit behind it. Every other seam is an env var read in one place — main, or
  `src/preload/index.ts` for the renderer — so grep its name. All are inert in
  production.
- Always on (set by `helpers/env.ts`): `KOLOFT_TEST_BACKGROUND`, `KOLOFT_DOM_RENDERER`,
  `KOLOFT_CLAUDE_CMD`, `KOLOFT_CODEX_CMD`, `KOLOFT_MUSE_CMD`, `KOLOFT_AGY_CMD`, `KOLOFT_KEYCHAIN_FILE`, `KOLOFT_SCRATCHPAD_BASE`,
  `KOLOFT_SUPPRESS_OS_OPEN`, `KOLOFT_EXTERNAL_OPENS_FILE`, `KOLOFT_DOWNLOAD_DIR`,
  `KOLOFT_CDP_LOG`, `KOLOFT_FILE_DIALOG_FILE`.
- Per spec, read once at startup, so set in `env.launchEnv` before launching by hand:
  `KOLOFT_BROWSER_TAB_CAP`, `KOLOFT_BROWSER_GUEST_LIMIT`, `KOLOFT_GITHUB_FIXTURE`,
  `KOLOFT_EXT_INSTALL_DIRS`, `KOLOFT_TEST_NO_ADOPT`, `KOLOFT_TEST_CLAUDE_PROBE`,
  `KOLOFT_TEST_TOOL_INSTALLER` (fixtures/fake-tool-installer.js), `KOLOFT_TEST_CLT`,
  `KOLOFT_PROBE_BASE_URL`, `KOLOFT_UPDATE_FIXTURE`, `KOLOFT_RELEASES_URL`,
  `KOLOFT_DISCORD_API_URL` (set by `startFakeDiscord`, helpers/fakeDiscord.ts),
  `KOLOFT_CRON_BIND_DEADLINE_MS`, `KOLOFT_GIT_TIMEOUT_MS`, `KOLOFT_TEST_REAL_WINDOW`
  (real-window layer), `KOLOFT_TEST_MACHINE_FILE` (JSON `{pressure, load1,
  backgroundWork}` read in place of the Mac's own numbers), the session timing knobs
  (`KOLOFT_*_MS`, see Unit layer), and the fakes' `KOLOFT_FAKE_*` inputs. The files behind
  `KOLOFT_FILE_DIALOG_FILE`, `KOLOFT_UPDATE_FIXTURE` and `KOLOFT_TEST_MACHINE_FILE` are
  read on every use, so a spec may rewrite them after launch.
- Not env vars: `window.__koloftTerms` (terminal text), `__koloftShortcutsReady` /
  `__koloftRowsReady` (the renderer is ready for keys), main's
  `globalThis.__koloftOsOutlets` (read through `osOutlets`), and `installGitSpawnLog`
  (the git the app runs).
  When a CDP relay test waits for a message that never comes, read
  `<home>/cdp-log.txt`: it holds the relay's whole conversation.

## Hand tests

A hand test is a case no suite answers. Split it into steps, and give each step to the
first of these that can do it; only a step none of them can do goes to the owner:

1. The hand-test sandbox, `npm run handtest` (test/handtest/sandbox.ts; its usage text
   says how). It lends a Claude account from the installed Koloft: the token goes into
   a 0600 file in the sandbox's home, is never printed, and goes with `stop`. Local
   Claude and local Codex tabs run there, a remote Claude tab with `--remote`; a remote
   Codex tab there is not set up, as the lab machine has no CA certificates, so Codex on
   it cannot reach OpenAI (CODEX§16). `--discord` puts it on the real Discord as the dev
   build's test bot, so the owner's only step is a press on the phone. Drive it with
   `playwright-cli attach --cdp=<cdp>` and screenshots; check results in transcripts,
   files and `<home>/koloft.log`.
2. A fake server: helpers/fakeDiscord.ts, the GitHub fixture, the fake `gh`.
3. The real binary in a temp HOME (claude, codex, gh) — a temp HOME does not hide the
   login Keychain, so a probe that signs in runs in Docker.
4. The Docker SSH lab, for anything about a remote machine.
5. A Mac with a real window, for what the sandbox cannot see (below).
6. The owner, only for: a captcha, their own Discord account or phone, a first sign-in
   with their own account, a matter of taste, or an effect that takes days to show.

The sandbox is launched like an e2e app, so "Keys, focus and the hidden window" and
"Test-only seams" above hold for it too: no Dock, badge or OS notification is shown
(main records what it would have said in `__koloftOsOutlets`), no real ⌘ key or mouse, a file picker that answers from `<home>/file-dialog-answers`, OS
hand-offs in `<home>/external-opens.txt`. Beyond those, its terminal draws with DOM
(not WebGL), and the lab machine has no UTF-8 locale, so a remote Claude draws `_` for
its symbols.

The owner's step goes through AskUserQuestion, one case at a time: the steps inside
the question, the outcomes as options. Only the butler's own question reaches the
owner's Discord, as a card in its channel (discord-flow); a session's question shows
only at the Mac. The card carries text only, so name what to look at, or have the
butler send a picture first (`koloft discord send` or `koloft discord shot`). After the
owner answers, check their step in a log or file yourself.

## Real-window layer (test/real-window/)

- For what only macOS itself delivers or draws: menu keys, the mouse on the window
  frame, the Dock, banners, a real input method. It reuses the e2e fixtures and
  launches with `KOLOFT_TEST_REAL_WINDOW=1` on top of the test seams, so the window,
  Dock icon, badge and banners are real; input goes through `helpers/macInput.ts`
  (CGEvent and Accessibility, platform ledger §52). The hidden-window rules above
  about focus and `osOutlets` turn around here: notifications and the badge are really
  shown, and `osOutlets` records nothing.
- Every case skips unless `KOLOFT_REAL_WINDOW=1`, which only `scripts/real-window-mac.mjs`
  sets: in a throwaway tart VM (`tart`), or on a Mac nobody is using (`here`, which the
  GitHub workflow `real-window.yml` runs). One worker, no retries.

## Component & case numbers used in specs and test titles

Specs and test titles name parts of the app by number: C2 sessions island (sidebar
rows) · C8 New Worktree Session dialog · C9 Restore session dialog · C10 mini workspace
picker (list + gate forms) · V0 the icon/type/color ladder (pinned by
`styleVars.test.ts` + `spec.spec.ts`). No other C-number is in use.
T-* and BB-* are case ids: the spec carrying an id is its contract — report a wrong
case, don't rewrite it in place.
