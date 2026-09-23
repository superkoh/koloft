# CLAUDE.md

Koloft is an Electron app that runs and manages Claude Code (the `claude` command-line
tool, via node-pty). The one core idea: the user picks a **workspace** and starts
or resumes **Claude sessions** in it; Koloft lists those sessions straight from
Claude's own storage (`~/.claude/projects`) and hangs one helper panel — the
Workbench: changed files, a file browser, web pages, a shell — off each session,
and one plain-text note off each workspace (the Notes island under the sessions
list; the Workbench is the session's, the note is the workspace's).
Judge every trade-off against that one idea.
(Source lives in `superkoh/koloft`; installers in `superkoh/koloft-releases`, the list
`install.sh` and the in-app updater read.)

How each feature behaves is NOT written here — the code and its tests are the source
of truth.

Working principles:

- Write everything the simple way. All LLM output — session replies and every file
  it writes — must use plain, everyday words that even a five-year-old could follow,
  in whatever language it is writing; never pick a hard word where an easy one
  works. When a picture says it better, draw one: a chart, diagram, or graph
  (mermaid or ASCII in markdown) beats a wall of text. The first time an
  abbreviation or shorthand appears in a document or in a session reply, spell it
  out and say what it means — e.g. "PR (pull request, a proposed code change)".
- Build the smallest thing that solves the problem at hand — in the design, the
  code, and the tests alike. A branch, guard, fallback, or abstraction for a case
  that is merely imaginable, and unlikely to ever happen, is cost with no payoff:
  leave it out, and add it the day the case shows up, evidence in hand. (A case
  that has been observed, or that the code's own invariants make likely, is not
  "imaginable" — handle it.)
- A guess is not a fact. A limit read off a name, a sibling module, a doc or an
  outside tool's past behavior stays a guess until one command proves it: say
  "inferred, not checked" where you state it, and check it before any code depends
  on it — everything built on a wrong premise goes when the premise does. The same
  goes for your own access: run the command and read the error; never report a
  permission you have not tried. What a command can answer is never asked of the owner.
- Extend the existing UI when adding a feature. Reuse its components, layouts,
  interactions, state treatments and CSS classes. When the app already has a style
  or state for the same purpose, use it exactly; do not invent a parallel version
  or replace the existing screen to add another session backend.
- Comments: none. In `.ts/.tsx/.js/.mjs/.cjs/.css` — and in the `#` lines of a
  `#!/` script written as a template string — `npm run check:comments` (CI, plus an
  after-edit hook) rejects every comment except two kinds, each with nothing else in it:
  - a tool directive: `@ts-expect-error`, `prettier-ignore`, `@vite-ignore`,
    `#__PURE__`, `@vitest-environment <env>`, `/// <reference … />`;
  - a marker: `// ADR-0007`, `// CC§9`, `// CODEX§5`, `// PLATFORM§3` — several may
    share one line;
    in CSS `/* ADR-0007 */`, in JSX `{/* ADR-0007 */}`. Each must resolve to a
    `docs/adr/` file or a `##` section of that contract ledger.

  Knowledge the code cannot carry goes to the first of these that fits:
  1. a name — rename, or extract a named constant or function (a magic number's
     reason lives in its name);
  2. a test whose title states the rule;
  3. a measured fact about an external system → its contract ledger, cited from the
     code with a marker: Claude Code `docs/claude-code-contract.md` (`CC§`), Codex
     `docs/codex-cli-contract.md` (`CODEX§`), anything else — Electron, Node, macOS,
     git, GitHub — `docs/platform-contract.md` (`PLATFORM§`);
  4. an ADR (architecture decision record), `docs/adr/NNNN-slug.md` — only when ALL
     four hold: it cannot be read from the code (names, types, tests); a smart
     newcomer who reads and runs the code could not infer it; without it the next
     person would plausibly make a reasonable-looking wrong change; and no existing
     test or CI would catch that change. In practice: a rejected alternative, an
     outside constraint or policy the code cannot show, a counter-intuitive
     trade-off. One ADR per decision, cited by a marker at every site it governs.

  Never written down anywhere: what or how the code does, provenance, dates (git has
  them); a TODO is a GitHub issue. An ADR takes the next free number; before merging
  a branch that adds one, bring in the latest `main` and rerun the check — a
  duplicate number means renumber yours. An ADR no code cites fails the check, so it
  goes when its code goes.
- Tests follow behavior, not diffs: one change may need zero, one, or several. Before
  writing one, ask "if this behavior broke, which existing test would go red?" — if
  one would, change that test; only if none would, write a new one, and make it fail
  only when this behavior breaks. Do not write a test for a change with no behavior
  in it (refactor, rename, moved file), for a test that merely restates the
  implementation (mock everything, assert the mock was called), or to pin an
  arbitrary cosmetic value (a pixel size, a colour, a line of copy).
- Run only what the change can break, and say which ran and why those. Unit layer:
  `npm run test:unit:changed` picks the files by import graph. E2E layer: you pick.
  First choose candidates by flow name from `test/e2e` (spec names are flow names;
  its test titles say what it covers), then grep `test/e2e` for the
  identifiers you touched — component names, `.wb-*` selectors, IPC channel names —
  to catch the rest. A change to a wide fan-out file (types.ts, store.ts, App.tsx,
  preload, main index.ts) is still picked by the flows whose state or IPC it
  touched, never by falling back to the whole suite. There is no full-suite gate:
  `npm test` runs only when someone asks for it, never as a reflex before a merge.
- Finish the code, then review, then test. While code is still being written, only
  the fast checks run (typecheck, `check:comments`, `test:unit:changed`). Once the
  diff is final, run `/code-review low` and `/simplify` over the whole diff, fix what
  is real, and only then pick and run the e2e flows — a cleanup commit that lands
  after a test round throws that round away.
- The PR (pull request) body is a report for the owner deciding whether to merge. It
  opens with six lines, in this order:
  - **What it does** — one sentence, in the user's words, before any mechanism.
  - **What a user sees change** — a table, one row per case, today against after;
    or "no user-visible change".
  - **Runtime code** — +N/−M lines under `src/`, tests, docs and fixtures not counted.
  - **How to see it in the shipped app** — what to click in an installed build, or
    "no way from the app".
  - **Confidence to ship as-is** — high / medium / low, and the one fact that sets it.
  - **Hand-test before merging** — no, or yes: what to try and why no suite can
    answer it.

  Then a table of what ran (suite · result · why that one), what did not run and
  why, and `Out of scope`: each cut, and each claim still "inferred, not checked",
  one line apiece. Before `gh pr create`, `git fetch origin` and make sure the branch
  merges clean with `origin/main`; a conflict is resolved and the affected checks
  re-run first. The reply that hands the PR back repeats the six lines and what
  ran — the owner reads the reply, not the PR.
- Hand-testing on a real machine is driven ONE CASE AT A TIME through
  AskUserQuestion, never as a wall of text. The steps to carry out go INSIDE the
  question; the options are the outcomes to choose between (what passed, what broke,
  and the specific wrong thing worth naming). Ask the next case only after the last
  one is answered, and keep a running tally so nothing is silently skipped. Never
  paste a numbered list of cases and leave the person to work through it — they are
  at the keyboard, reading a plan costs them the attention the test needs, and a
  pasted list comes back as "some passed" with no record of which.
- Three setup steps, each with a silent failure mode:
  - `npm run rebuild` before the first run, and again after any change to the Electron
    or node-pty version — otherwise the app crashes on launch with an ABI mismatch.
  - A fresh git worktree has no `node_modules` of its own and Node silently resolves up
    to the parent checkout's. A SessionStart hook (`scripts/worktree-deps.mjs`) runs
    `npm ci`, `npm run rebuild` and the Electron download in the background the first
    time a session starts in a worktree without `node_modules`, and wakes Claude only
    if a step fails. When a worktree is entered mid-session no session starts, so run
    those three by hand there.
  - Since Electron ≥42 the binary is no longer fetched at install time — run
    `node node_modules/electron/install.js` once, or the first (possibly headless e2e)
    launch stalls on a silent download.
- Shell in a worktree stays plain. The worktree isolation guard refuses a Bash call
  that names git and that it cannot prove stays inside this worktree — a `.github` in
  a path counts as naming git. Refused: a shell variable in such a line, and a `cd`
  outside the worktree followed by a `git` command. Each refusal is a wasted turn: one
  plain command per call, absolute paths. zsh trap: an unquoted glob that matches
  nothing (`--include=*.md`) aborts the whole call — quote it.
- Auth comes from Koloft's own multi-account balancer (Settings ▸ Accounts): the claude
  shim injects the picked account per launch; the probe/header contract is
  `docs/claude-code-contract.md` §7. With the mode off, a session runs bare `claude` on
  whatever the machine's own `/login` state is.
- Any browser automation here stays headless — never pass `--headed` unless asked to
  watch. Koloft is developed on the same Mac the automation runs on, so a browser window
  that takes focus, or merely covers a fullscreen Space, interrupts whatever is being
  typed at that moment. The app's own e2e suite obeys the same rule by launching
  hidden and never showing itself (`KOLOFT_TEST_BACKGROUND=1` in
  `test/e2e/helpers/env.ts`, pinned by `test/e2e/background-launch.spec.ts`).
- `README.md` is the human-facing product page (install, packaging, Gatekeeper). Don't
  read it for context — the code is the source of truth; read it only when the task is
  editing the README itself. Test-layer seams and conventions live in `test/CLAUDE.md`.
- No per-feature document survives its feature shipping — anywhere in the repo.
  While a feature is in flight its artifacts (design, spec, cases, status, review,
  punchlist) live in and die with the PR that ships it. On retirement, content
  disperses to wherever it can stay true: behavioral claims are test assertions;
  rationale that passes the ADR bar (see Comments) is an ADR; measured facts about an
  outside system — things reading Koloft's code cannot reveal, which drift when that
  system upgrades — go to its contract ledger (see Comments) with date, version, and
  how they were established; cross-cutting doctrine goes in this file; leftover work
  → GitHub issues. Everything else is git history — deletion loses nothing, while a
  stale doc actively misleads whoever greps it. `docs/` therefore holds only
  documents organized around a subject that outlives any one feature (today: the
  Claude Code, Codex and platform contract ledgers, the ADRs, and the roadmap),
  never a shipped feature's design doc.
- The roadmap is `docs/roadmap.md`: the tiered checklist, the explicit not-doing list,
  and how much to trust the order. Start any "what's next" discussion from it rather
  than re-deriving one, and edit it there when a decision changes.
