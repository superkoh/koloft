# test/ — project-specific test facts

This file holds only what a NEW test has to know and cannot learn from the file it
is about to touch: the conventions of each layer, and the shared vocabulary the
specs are written in. A fact about one helper, seam or fixture lives in that file's
own header comment — read the file you are about to use, not this one. General
test methodology (what earns a test, red-first, black-box boundaries) is
deliberately not written down here.

## Commands

- `npm run test:unit`  — Vitest, pure Node, hermetic; the fast layer.
- `npm run test:unit:changed` — the same, only the files reachable from what this
  branch changed against `main` (vitest `--changed`).
- `npm run test:e2e`   — Playwright drives the real built app. Needs
  `npm run build` first (rebuild rules: root CLAUDE.md).
- `npm test`           — both.

## Unit layer (test/unit/)

- There is no global `$HOME` sandbox (vitest has no setupFiles). A suite that
  touches `~/.claude` repoints `process.env.HOME` to a temp dir *before dynamically
  importing* the module under test (pattern: sessionTracker.test.ts).
- A suite that covers a script Koloft writes to disk (`shim`, `openShim`, `hooks`)
  or a process it inspects (`claudeLiveness`) executes the real thing, with fake
  binaries on PATH recording argv. Never reimplement the script logic inside a test.

## E2E layer (test/e2e/)

- One spec per user-visible flow. A spec starts a session the way the product does
  — `startSessionIn` / `openWorktreeSession` (helpers/p1.ts) — and reuses that
  file's helpers. The app has no `data-testid`s: prefer role/text/stable-class
  selectors. Fixture workspaces live in helpers/env.ts.
- The only shell the product has is the SELECTED session's terminal tab
  (`openSessionTerminal` + `panelTerm`). It needs a bound, live session, and
  opening it EXPANDS the Workbench panel — a case that needs the panel shut fires
  its command behind a `sleep` and collapses inside that window (worked examples:
  workbench-tabs WB-T20, workbench-aux T-AUX-02).
- Never SIGKILL a remembered pid directly — go through `killSession(pid, env)`
  (helpers/p1.ts); its comment says why.
- Native menu accelerators are unreachable from Playwright's synthetic keys — send
  the IPC (`sendShortcut`) or click the menu item (`clickAppMenuItem`). Which island
  a key belongs to is decided by FOCUS, so click the target area first. Dialog-local
  keys (⏎/Esc/digits/arrows/typing inside C8/C9/C10) are renderer keydown — plain
  `page.keyboard`.
- Before writing a Workbench locator, read the header of helpers/workbench.ts: every
  `.wb-*` selector is a constant there, and the selector traps are listed.
- `fixtures/fake-claude.js` is the `claude` the shim execs. It emulates only the
  LLM, and is steered by sentinel FILES under `<home>`, never env vars (Koloft
  spawns the pty itself, so a spec has no shell to export into). Its own header is
  the canonical roster of what it can do.
- Test-only seams (`KOLOFT_DOM_RENDERER`, `KOLOFT_TEST_NO_ADOPT`,
  `KOLOFT_FILE_DIALOG_FILE`, `KOLOFT_CRON_BIND_DEADLINE_MS`, `KOLOFT_GITHUB_FIXTURE`,
  `window.__koloftTerms`, `installGitSpawnLog`) are each documented where they are read —
  grep the name.
  All are env-gated, inert in production, and add no test branch to product logic.

## Component & case numbers used in specs and comments

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
