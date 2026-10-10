# CLAUDE.md

Koloft is an Electron app that runs and manages Claude Code and Codex (the `claude` and
`codex` command-line tools, via node-pty). The one core idea: the user picks a
**workspace** and starts or resumes **Claude Code or Codex sessions** in it; Koloft lists
those sessions straight from each tool's own storage (`~/.claude/projects`; for Codex,
`thread/list` on each `CODEX_HOME`'s app-server, `docs/codex-cli-contract.md` §1, §15)
and hangs one helper panel — the Workbench: changed files, a file browser, web pages,
a shell — off each session, and one plain-text note
off each workspace (the Notes island under the sessions list; the Workbench is the
session's, the note is the workspace's).
A session tab is not a session: the tab is the terminal `claude` or `codex` runs in, and
`/clear`, a resume or a restart swaps the session inside it while the tab stays —
the Workbench, its web pages and the shim's env are keyed by the tab.
Judge every trade-off against that one idea.
(Source lives in `superkoh/koloft`; installers in `superkoh/koloft-releases`, the list
`install.sh` and the in-app updater read.)

How each feature behaves is not written here — the code and its tests are the source
of truth.

Working principles:

- Every reply the owner reads — the one-line progress notes between tool calls,
  questions, the hand-back — is in the language of the owner's last message. English
  tool output, an English agent report or this English file never switch it.
  Commits, PR bodies, issues and repo files stay in English.
- Write everything the simple way. All LLM output — session replies and every file
  it writes — must use plain, everyday words that even a five-year-old could follow,
  in whatever language it is writing; never pick a hard word where an easy one
  works. When a picture says it better, draw one: a chart, diagram, or graph
  (mermaid or ASCII in markdown) beats a wall of text. The first time an
  abbreviation, shorthand or number (issue #N, step 4) appears in a reply or
  document, say what it means — e.g. "PR (pull request, a proposed code change)".
- Build the smallest thing that solves the problem at hand — in the design, the
  code, and the tests alike. A branch, guard, fallback, or abstraction for a case
  that is merely imaginable, and unlikely to ever happen, is cost with no payoff:
  leave it out, and add it the day the case shows up, evidence in hand. (A case
  that has been observed, or that the code's own invariants make likely, is not
  "imaginable" — handle it.) Smallest is about how, never about what the owner asked
  for: do not split an asked-for feature into a first and a second version, or leave
  part of it for later, unless a probe showed that part cannot be done — then name
  the probe.
- A guess is not a fact. A claim from a name, a sibling module, a doc, a reviewer
  or a past look at a tool, PR or agent stays a guess until one command proves it:
  say "inferred, not checked" where you state it, and check it before any code
  depends on it — everything built on a wrong premise goes when the premise does.
  Your own access too: run the command and read the error; never report a
  permission you have not tried. What a command can answer is never asked of the owner.
  Nothing is called impossible, unsupported or "works this way" — in a plan, a
  question or a PR — before a probe has run; until then it is "not probed yet".
- Extend the existing UI when adding a feature: reuse its components, layouts,
  interactions, state treatments and CSS classes exactly; never invent a parallel
  version or replace a screen for another session backend. A plan that changes a
  screen shows it as a local HTML mockup built from the app's CSS.
- Every feature covers every kind of session tab: Claude Code and Codex, each in a
  local workspace and in a remote one reached over SSH (Secure Shell) — four kinds.
  A plan, design or PR says what each of the four does: the same thing, a named
  difference, or left out with the probe or missing data that forces it. A feature
  built and checked for local Claude Code alone is not done, and the e2e flows picked
  for a change include the Codex and remote specs whenever the change reaches those
  tabs.
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
  4. an ADR (architecture decision record), `docs/adr/NNNN-slug.md` — only when all
     four hold: it cannot be read from the code (names, types, tests); a smart
     newcomer who reads and runs the code could not infer it; without it the next
     person would plausibly make a reasonable-looking wrong change; and no existing
     test or CI would catch that change. In practice: a rejected alternative, an
     outside constraint or policy the code cannot show, a counter-intuitive
     trade-off. One ADR per decision, cited by a marker at every site it governs.

  Never written down anywhere: what or how the code does, provenance, dates (git has
  them); a TODO is a GitHub issue. An ADR takes the number after the highest one in
  `docs/adr/` (a deleted ADR's number is never reused); before merging
  a branch that adds one, bring in the latest `main` and rerun the check — a
  duplicate number means renumber yours. An ADR no code cites fails the check, so it
  goes when its code goes.
- Tests follow behavior, not diffs: one change may need zero, one, or several. Before
  writing one, ask "if this behavior broke, which existing test would go red?" — if
  one would, change that test; only if none would, write a new one, and make it fail
  only when this behavior breaks. Do not write a test for a change with no behavior
  in it (refactor, rename, moved file), for a test that merely restates the
  implementation (mock everything, assert the mock was called), or to pin an
  arbitrary cosmetic value (a pixel size, a colour, a line of copy) — a value a
  written design rule names (V0 in `test/CLAUDE.md`) is not arbitrary.
- Run only what the change can break, and say which ran and why those. Unit layer:
  `npm run test:unit:changed` picks the files by import graph. E2E layer: no tool
  picks, so the agent making the change picks the specs itself, never the owner.
  First choose candidates by flow name from `test/e2e` (spec names are flow names;
  its test titles say what it covers), then grep `test/e2e` for the
  identifiers you touched — component names, `.wb-*` selectors, IPC channel names —
  to catch the rest. A change to a wide fan-out file (types.ts, store.ts, App.tsx,
  preload, main index.ts) is still picked by the flows whose state or IPC it
  touched, never by falling back to the whole suite. There is no full-suite gate:
  `npm test` runs only when someone asks for it, never as a reflex before a merge or
  after a rebase.
- A plan, design or audit report the owner will decide on — more than a screen, not
  the pick inside one question — goes to the owner only after an independent `fable`
  agent has checked it against the code and you have fixed what it found; the
  hand-back says it was checked. An agent that cannot launch agents says its report
  is unreviewed.
- Finish the code, then review, then test. While code is still being written, only
  the fast checks run (`format`, typecheck, `check:comments`, `test:unit:changed`) —
  CI's first gate is `format:check`, and no hook runs Prettier for you. Once the
  diff is final, commit it, `git fetch origin`, run `/code-review low
  origin/main...HEAD` and `/simplify` over the whole diff, fix what is real, and only
  then pick and run the e2e flows, once — in a Workflow too, whose step agents run
  only the fast checks. A cleanup commit that lands after a test round throws that
  round away. `/code-review low` skips test files: on a test-only diff the what-ran
  table says "did not apply", never "no findings". Playwright never builds: after the
  last `src/` change or merge of `main`, `npm run build` first, or e2e tests the old
  `out/`.
- The PR (pull request) body is a report for the owner deciding whether to merge. It
  opens with six lines, in this order:
  - **What it does** — one sentence, in the user's words, before any mechanism.
  - **What a user sees change** — a table, one row per case, today against after;
    or "no user-visible change".
  - **Runtime code** — +N/−M lines under `src/`, tests, docs and fixtures not counted.
  - **How to see it in the shipped app** — what to click in an installed build, or
    "no way from the app".
  - **Confidence to ship as-is** — high / medium / low, and the one fact that sets it,
    never a check you could still run.
  - **Hand-test before merging** — no, or yes: what to try, and why no suite or dev
    build you drove could answer it.

  Then a table of what ran (suite · result · why that one), what did not run and
  why, and `Out of scope`: each cut, and each claim still "inferred, not checked",
  one line apiece. Before `gh pr create`, `git fetch origin` and make sure the branch
  merges clean with `origin/main`; a conflict is resolved and the affected checks
  re-run first. The reply that hands the PR back repeats the six lines and what
  ran — the owner reads the reply, not the PR.
- Carry agreed work through without asking: commit, push the branch, open the PR,
  file a GitHub issue for each leftover, and once it merges remove what it left —
  the local branch, the worktree (after leaving it), the ones your agents made, any
  dev build you started. Ask first only to merge, release, push to `main` or delete
  on GitHub; an audit or review round changes nothing until the owner says so. The
  go to merge is also the go to clean up: wait for the PR's CI
  (`gh pr checks <n> --watch`), then plain `gh pr merge <n> --squash` (squash folds
  the branch's commits into one) — the repo allows only squash and GitHub deletes the
  PR's branch on merge, so never ask about either; `--delete-branch` fails in a
  worktree (`'main' is already used by worktree`). Then call ExitWorktree (`remove`
  deletes the worktree; `discard_changes: true`, as the squash
  on `main` holds the commits). Despite its description it also removes a worktree
  the session was started in with `claude -w` (seen three times);
  never hand the owner a `git worktree remove` or `/exit` to run. A
  reply that ends a piece of work ends with what the owner must do next, or
  "nothing"; before going quiet on background work, say what runs and about how
  long. A Monitor fires only on failure or finish, and when the watched work ends,
  stop every Monitor and wake-up you armed, so the report stays the last message.
  Remove an agent's worktree with `git worktree remove -f -f <path>` (locked while
  its agent lives).
- When work is split across agents or a Workflow: steps that only write code or run
  tests go to `model: 'opus'`, the rest (design, review, judgment, what the owner
  reads) to `model: 'fable'`. Fan out by slices of work, never one agent per
  finding — a handful per phase — and say how many before launching. Every brief and
  every Workflow step prompt starts with the shell-rule block below, word for word:
  an Explore agent never sees this file, and agents whose brief lacked the block
  were refused 2–3 times as often (211 agent transcripts). An agent
  writes only patches or code, in a scratchpad folder of its own.
- Hand-testing on a real machine is driven one case at a time through
  AskUserQuestion, never as a wall of text. The steps to carry out go inside the
  question; the options are the outcomes to choose between (what passed, what broke,
  and the specific wrong thing worth naming). Ask the next case only after the last
  one is answered, and keep a running tally so nothing is silently skipped. Never
  paste a numbered list of cases and leave the person to work through it — they are
  at the keyboard, reading a plan costs them the attention the test needs, and a
  pasted list comes back as "some passed" with no record of which. Decisions go the
  same way: one per question, your pick first, what each choice costs inside the
  question — never a list of open questions at the end of a report. Automate every
  check you can — a suite, a dev build you drive; the owner hand-tests only a case
  that matters and truly cannot be automated (name it and say why), or a round the
  owner asks for. One dev build at a time: stop every older one first, its Electron
  main process too (killing `electron-vite` alone leaves the window up). A dev build
  has its own profile (`koloft-dev`), so the installed Koloft, where these sessions
  run, stays open.
- Three setup steps, each with a silent failure mode:
  - `npm run rebuild` before the first run, and again after any change to the Electron
    or node-pty version — otherwise the app crashes on launch with an ABI mismatch.
  - A fresh git worktree has no `node_modules` of its own and Node silently resolves up
    to the parent checkout's. A SessionStart hook (`scripts/worktree-deps.mjs`) runs
    `npm ci`, `npm run rebuild` and the Electron download in the background the first
    time a session starts in a worktree without `node_modules`, and wakes Claude only
    if a step fails. When a worktree is entered mid-session no session starts, so run
    those three by hand there.
  - `npm ci` and `npm install` do not fetch the Electron binary — run
    `node node_modules/electron/install.js` once, or the first (possibly headless e2e)
    launch stalls on a silent download.
- Shell in a worktree stays plain. The worktree isolation guard refuses any Bash
  call it cannot prove stays inside this worktree, not only git ones. This block
  binds you too, its last line aside — that one is for agents; your long text for
  `gh` goes in a file (`--body-file`):

  ```
  Shell rules — a guard refuses the rest; each refusal is a lost turn:
  - One plain command per Bash call, absolute paths. No loop, $(…) or shell
    variable whose value lands in a command's arguments; no env -u.
  - Create or change every file, scratch scripts too, with Write/Edit, even when
    told to prefer Bash; run a script as node/python3/sh <file>. No heredoc,
    sed -i, perl -pi or cat >.
  - Quote every glob, a URL's ? too: --include='*.ts', 'a?n=1'. Unquoted,
    zsh prints "no matches found", the command never runs; the tool may
    still report success.
  - Never git -C another checkout: diff origin/<branch>, or gh pr diff <n>.
  - Read stops at 25,000 tokens: read a big file or diff ~1,000 lines at a time.
  - Findings go in your final message; the harness refuses report files.
  ```

  Also refused: a path outside the worktree inside a chain, a `cd` outside followed
  by `git`, a bare shell name or builtin as an argument (`grep -n "source" f`,
  `bash --version`), and `python3 -` or `sh <file>` whose text names git (a `.github`
  path counts). An edit made through the shell also slips past the comment hook.
- Auth comes from Koloft's own multi-account balancer (Settings ▸ Accounts): the claude
  shim injects the picked account per launch; the probe/header contract is
  `docs/claude-code-contract.md` §7. A Codex account is its own `CODEX_HOME`, picked per
  launch (`docs/codex-cli-contract.md` §15).
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
