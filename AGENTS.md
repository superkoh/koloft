# AGENTS.md

Koloft is an Electron app that runs and manages Claude Code, Codex and Antigravity (the
`claude`, `codex` and `agy` command-line tools, via node-pty). The one core idea: the user picks a
**workspace** and starts or resumes **agent sessions** in it; Koloft lists
those sessions straight from each tool's own storage (`~/.claude/projects`; for Codex,
`thread/list` on each `CODEX_HOME`'s app-server, `docs/codex-cli-contract.md` §1, §15)
and hangs one helper panel — the Workbench: changed files, a file browser, web pages,
a shell — off each session, and one plain-text note
off each workspace (the Notes island under the sessions list).
Each session tab has its Workbench, keyed by the tab; each workspace row has one too —
Files of the workspace folder and web pages, no shell, and no agent drives it. The note
stays the workspace's, in the sidebar.
A session tab is not a session: the tab is the terminal the agent runs in, and
`/clear`, a resume or a restart swaps the session inside it while the tab stays —
the Workbench, its web pages and the shim's env are keyed by the tab.
Judge every trade-off against that one idea.
(Source and installers both live in `superkoh/koloft`, whose release list `install.sh`
and the in-app updater read; `superkoh/koloft-releases` is the bridge older apps update
through, and is never deleted — ADR-0037.)

How each feature behaves is not written here — the code and its tests are the source
of truth.

Every agent that works on this repo — Claude Code, Codex, Antigravity — reads this file;
`CLAUDE.md` and `test/CLAUDE.md` are symlinks to `AGENTS.md` and `test/AGENTS.md`, so
edit those. Read `test/AGENTS.md` before you change anything under `test/`. Where a rule
below names a tool only one agent has, use your own agent's from this table:

| To do this | Claude Code | Codex | Antigravity |
| --- | --- | --- | --- |
| Ask the owner one question | AskUserQuestion | `request_user_input` | `ask_question` |
| Hand a helper a search or a read | Agent, Workflow | `spawn_agent` | `invoke_subagent`, `run_workflow` |
| Work that needs its own worktree, or that the owner watches | `koloft session new` | `koloft session new` | `koloft session new` |
| The Fable check of what the owner decides on | Agent, `model: 'fable'` | `koloft session new --backend claude --model fable --effort high` | the same as Codex |
| Leave a worktree once its PR merged | ExitWorktree | not yourself: end the hand-back with "the worktree is still here — say close and I close it", then `koloft session close` as your very last step | the same as Codex |
| Wait for background work | Monitor | wait in the foreground (`gh pr checks <n> --watch`) | the same as Codex |
| The cleanup pass over a finished diff | `/simplify` | go over the diff for reuse, simpler code, speed, and whether each piece sits at the right level | the same as Codex |
| Scratch files | the scratchpad | the system temp folder | `brain/<conversation id>/scratch/` |

The `koloft` command exists only in a session Koloft started; in one started any other
way, do that step with your own agent's tools, or ask the owner.

A helper started with `-w` hands back its result and stays open; once its PR merged,
the session that started it closes it with `koloft session close <name or id>`, or says
in its hand-back that the worktree is still there when that is refused.

Working principles:

- Every reply the owner reads — the one-line progress notes between tool calls,
  questions, the hand-back — is in the language of the owner's last message. English
  tool output, an English agent report or this English file never switch it.
  Commits, PR bodies, issues and repo files stay in English.
- Write everything the simple way. All LLM output — session replies and every file
  it writes — must use plain, everyday words that even a five-year-old could follow,
  in whatever language it is writing; never pick a hard word where an easy one
  works. Tell a change or choice by its case first: who does what, what they see.
  A picture (mermaid or ASCII) beats a wall of text. The first time an
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
- Icons are Koloft's own, one style ("soft line"), all from `src/renderer/src/icons`.
  A new icon is never taken or copied from an icon library and never hand-drawn as
  SVG code: it is made with an image generation tool (Codex's `image_gen`), with
  `src/renderer/src/icons/sheet-1.png` given as the style reference image, as a new
  6 × 4 sheet of white glyphs on black, each glyph drawn from its purpose in the
  app. Every glyph is designed near-square and fills its square — no strip-shaped
  icon (a thin symbol such as a minus or an arrow sits inside a circle); the
  script sizes each glyph so its larger side is 22 of the 24 units and evens its
  line to 2 units. Commit the sheet next to the others, name its cells in
  `sheets.json` (`null` for a cell left unused), run `node scripts/trace-icons.mjs` to rewrite
  `paths.ts`, export the icon from `index.tsx`, and look at it at its real size.
  Only brand marks (Claude, Codex, Discord, GitHub) come from `react-icons/bs`;
  a brand it lacks (Antigravity) is that brand's own mark, its path copied from
  `@lobehub/icons-static-svg` (MIT) into react-icons' `GenIcon` — never a parent
  company's mark in its place.
- Every feature covers every kind of session tab: each agent in `SESSION_BACKENDS`,
  in a local workspace and in a remote one reached over SSH (Secure Shell).
  A plan, design or PR says what each kind does: the same thing, a named
  difference, or left out with the probe or missing data that forces it. A feature
  built and checked for local Claude Code alone is not done, and the e2e flows picked
  for a change include the other agents' and remote specs whenever the change reaches
  those tabs.
- Code outside an agent's own folder never names an agent (ADR-0054). Code about one
  agent goes in `src/agents/<id>/`; other code asks the agent list
  (`src/core/agent/registry.ts`). `npm run check:agent-words` (CI and the before-push
  hook) fails on every new line that names one — the words each agent lists in its
  `agent.ts` — and on a line of `scripts/agent-words-baseline.json` that is gone, so
  the baseline only shrinks. A line that truly must stay, and any new `allowed` entry,
  gets its reason in the PR body (`npm run check:agent-words -- --accept-new` takes new lines
  in and drops gone ones); removed lines leave with `-- --prune`.
- Who may import whom around `src/agents` is checked the same way (ADR-0054):
  `npm run check:agent-imports` (CI and the before-push hook).

  ```
  src/plugins, src/main, src/renderer,  ✗→ an agent's folder, src/agents/kit
  src/shared, src/core, src/preload
  src/plugins                           ✗→ a list of agents (read the registry in core)
  a list of agents                      ✓→ only each agent's entry: list.ts its agent.ts,
                                            starts.ts its main/start.ts, uis.ts its
                                            renderer/ui.tsx, usageWorkerScans.ts (the
                                            usage worker's) its main/usageWorkerScan.ts
  an agent's folder, and kit            ✗→ anything under src/plugins, a list of agents,
                                            another agent's folder, src/renderer,
                                            src/preload
  there, anything outside main/         ✗→ main-process code (src/main, the main/ of an
  (agent.ts, shared/, renderer/ …)          agent or of kit)
  its agent.ts, at run time             ✗→ a file that loads the list (use `import type`)
  its main/                             ✓→ a src/main module that names no agent, when
                                            no chain of src/main modules from it imports
                                            anything under src/plugins, a list of agents
                                            or another agent's folder
  ```

  An import counts both at the file it names and where the name is really declared, so
  a re-export, another name, `import type` or `import()` changes nothing. The same
  script fails on a new optional method on the run-time interfaces (`src/core/agent`
  but not `manifest.ts`, and `src/agents/kit/main`; a caller never picks an agent's way
  by whether a method is there) and on a new use of `messagingOf` outside the three
  agents' own folders. It fails too, with no baseline, on a flag in a manifest that is
  not yes-or-no (a field of `flags`: `boolean`, or one `boolean` each for `local` and
  `ssh`), and where common code, `kit` or a plugin compares a text from a manifest, or from a
  table built from one such as `BACKEND_LABEL`, with a text written in the code; and it
  prints each flag's answer for the six kinds of tab (`scripts/agent-facts.mjs`). A
  manifest field states the agent's own fact, never what Koloft does with it
  (`ownLogFolderNames`, not `folderNamesNotWatched`). The script's `RULES` table is the full wording. What exists today is in
  `scripts/agent-imports-baseline.json`, each entry with the step of issue #2410 that
  removes it; the baseline only shrinks. An entry that truly must be added gets its
  reason in the PR body (`npm run check:agent-imports -- --accept-new <step>`); removed
  ones leave with `-- --prune`. A PR of issue #2410 reports the numbers the script
  prints: what is left, by rule and by step.
- `npm run check:agent-removal` deletes each agent in turn from a copy of the repo (its
  folder and its entries in the list files) and runs the main-process and window
  typechecks (not the tests'); it prints, per agent, each check's files and errors, the
  files with an error by area, and the markers to its ledger left in `src` (`-- --files`
  lists the files). It only reports: it fails only when the
  copy with nothing deleted does not typecheck, and is not in CI or the before-push hook
  until issue #2410 ends with it at 0. A PR of issue #2410 reports its table.
- Comments: none. In `.ts/.tsx/.js/.mjs/.cjs/.css` — and in the `#` lines of a
  `#!/` script written as a template string — `npm run check:comments` (CI, an
  after-edit hook, and the before-push hook) rejects every comment except two kinds,
  each with nothing else in it:
  - a tool directive: `@ts-expect-error`, `prettier-ignore`, `@vite-ignore`,
    `#__PURE__`, `@vitest-environment <env>`, `/// <reference … />`;
  - a marker: `// ADR-0007`, `// AGY§4`, `// CC§9`, `// CODEX§5`, `// PLATFORM§3` — several may
    share one line;
    in CSS `/* ADR-0007 */`, in JSX `{/* ADR-0007 */}`. Each must resolve to a
    `docs/adr/` file or a `##` section of that contract ledger.

  Knowledge the code cannot carry goes to the first of these that fits:
  1. a name — rename, or extract a named constant or function (a magic number's
     reason lives in its name);
  2. a test whose title states the rule;
  3. a measured fact about an external system → its contract ledger, cited from the
     code with a marker: Claude Code `docs/claude-code-contract.md` (`CC§`), Codex
     `docs/codex-cli-contract.md` (`CODEX§`), Antigravity CLI `docs/antigravity-cli-contract.md` (`AGY§`), anything else — Electron, Node, macOS,
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
  written design rule names (V0 in `test/AGENTS.md`) is not arbitrary.
- Run only what the change can break, and say which ran and why those. Unit layer:
  `npm run test:unit:changed` picks the files by import graph. E2E layer: no tool
  picks, so the agent making the change picks the specs itself, never the owner.
  First choose candidates by flow name from `test/e2e` (spec names are flow names;
  its test titles say what it covers), then grep `test/e2e` for the
  identifiers you touched — component names, `.wb-*` selectors, IPC channel names —
  and for every string or constant value your diff removed or changed (a label, a
  refusal line, a launch flag), to catch the rest. A picked spec runs as a whole
  file, never one case of it. A spec file your diff edits is run too, whatever it
  needs — a real agent, the Docker lab; one you could not run goes under "did not
  run" with the command that failed. A change to a wide fan-out file (types.ts,
  store.ts, App.tsx, preload, main index.ts) is still picked by the flows whose
  state or IPC it touched, never by falling back to the whole suite. There is no
  full-suite gate:
  `npm test` runs only when someone asks for it, never as a reflex before a merge or
  after a rebase.
- A plan, design or audit report the owner will decide on — more than a screen, not
  the pick inside one question — goes to the owner only after an independent `fable`
  agent has checked it against the code and you have fixed what it found; the
  hand-back says it was checked. An agent that cannot launch agents says its report
  is unreviewed.
- Finish the code, then review, then test. While writing code, only the fast checks
  run (`format`, typecheck, `check:comments`, `check:agent-words`, `check:agent-imports`,
  `test:unit:changed`; there is no lint) — CI's first gate is `format:check`. No hook
  rewrites files: every agent's `git push` or `gh pr create` waits for `format:check`,
  `check:comments`, `check:agent-words`, `check:agent-imports` and typecheck
  (`scripts/push-checks.mjs`) and is stopped if one
  finds problems. Once the
  diff is final, commit it, `git fetch origin`, and start `node scripts/code-review.mjs`
  in the background: two reviews at once, up to about 15 minutes (ADR-0040); it runs
  Claude Code whichever agent you are, and on a machine with no signed-in `claude`,
  start one there with `koloft session new --backend claude` and have it review the diff
  in its own turn. While it runs,
  run `/simplify` over the whole diff and pick the e2e flows, but hold `/simplify`'s
  edits until the reviews are in. Merge the reports, fix what is real (a run that failed
  is rerun, or the what-ran table says how many of two came back). Once the fixes are
  committed, one second round may run on the new diff and its real findings are fixed
  too; there is never a third round — what is still open after two goes to `Out of
  scope`. Only then run the e2e flows, once — in a Workflow too, whose step agents run only the fast
  checks. A cleanup commit that lands after a test round throws that round away.
  Playwright never builds: after the last `src/` change or merge of `main`, `npm run
  build` first, or e2e tests the old `out/`.
- The PR title becomes `main`'s commit subject on squash, and the release notes and
  the site changelog sort by its type, so it reads `type(scope): what changed`, the
  change in the user's words: `feat`, `fix` or `perf` for what a user meets,
  `refactor`, `docs`, `test`, `chore`, `build` or `ci` for the rest. A plain-sentence
  title lands untyped in the changelog (v0.41.0 shipped four); the `PR title` check
  fails it.
- The PR (pull request) body is a report for the owner deciding whether to merge. It
  opens with six lines, in this order:
  - **What it does** — one sentence, in the user's words, before any mechanism.
  - **What a user sees change** — a table, one row per case, today against after;
    or "no user-visible change".
  - **Runtime code** — +N/−M lines under `src/`, tests, docs and fixtures not counted.
  - **How to see it in the shipped app** — what to click in an installed build, and
    for a changed screen or page a screenshot you took of it; or "no way from the app".
  - **Confidence to ship as-is** — high / medium / low, and the one fact that sets it,
    never a check you could still run. Below high, it is not offered for merge: do
    what makes it high first.
  - **Hand-test before merging** — no, or yes: the one step only a person can do, and
    why no suite, sandbox or dev build you drove could do it.

  Then a table of what ran (suite · result · why that one), what did not run and
  why, and `Out of scope`: each cut, and each claim still "inferred, not checked",
  one line apiece. Before `gh pr create`, `git fetch origin` and make sure the branch
  merges clean with `origin/main`; a conflict is resolved and the affected checks
  re-run first. Each PR hand-back, a sub-session's too, repeats the six lines and
  what ran: the owner reads it, not the PR.
- Carry agreed work through without asking: commit, push the branch, open the PR,
  file a GitHub issue for each leftover, and once it merges remove what it left —
  the local branch, the worktree (after leaving it), the ones your agents made, any
  dev build you started. Ask first only to merge, release, push to `main` or delete
  on GitHub; an audit or review round changes nothing until the owner says so. The
  go to merge is also the go to clean up: wait for the PR's CI
  (`gh pr checks <n> --watch`), then `gh pr merge <n> --squash --admin` — `main`
  takes a PR only with one approval and nobody can approve their own, so the
  owner's merge goes through the admin exemption (without `--admin` it is refused:
  "the base branch policy prohibits the merge"). `--admin` skips the checks too,
  so the wait before it is the only CI gate. The repo
  allows only squash and GitHub deletes the PR's branch on merge, so never ask
  about either; `--delete-branch` fails in a worktree. Then leave the worktree (the
  table at the top). Claude Code's ExitWorktree: `remove` deletes the worktree;
  `discard_changes: true`, as the squash on `main` holds the commits; despite its
  description it also removes a worktree the session was started in with `claude -w`.
  Never hand the owner a `git worktree remove` or `/exit` to run. A
  reply that ends a piece of work ends with what the owner must do next, or
  "nothing"; before going quiet on background work, say what runs and about how
  long. A Monitor fires only on failure or finish, and when the watched work ends,
  stop every Monitor and wake-up you armed, so the report stays the last message.
  Remove an agent's worktree with `git worktree remove -f -f <path>` (locked while
  its agent lives).
- When work is split across agents or a Workflow: every step goes to the "normal"
  model (Claude Code `model: 'opus'`; Codex and Antigravity as `koloft help` names it) —
  writing code, running tests, reading and searching code,
  design drafts, review along the way. Only the independent check of what the owner
  will decide on (the plan, design or audit report above) goes to Claude's `fable`
  (the table at the top): a Fable agent costs about 2.5 times an Opus one. In Claude
  Code its brief opens with the line
  `Never consult the advisor tool.`, before the shell-rule block: a helper inherits
  the session's advisor, which is Fable too, so asking it re-reads the whole check at
  full Fable price; without the line 3 of 3 Fable checks asked it, with it 0 of 3.
  Fan out by slices of work, never one agent per
  finding — a handful per phase — and say how many before launching. In Claude Code,
  every brief and every Workflow step prompt starts with the shell-rule block below,
  word for word (a Fable check's right after its advisor line):
  an Explore agent never sees this file, and agents whose brief lacked the block
  were refused 2–3 times as often. An agent
  writes only patches or code, in a scratch folder of its own.
- Hand-testing on a real machine is driven one case at a time through
  your question tool (the table at the top), never as a wall of text. The steps to carry out go inside the
  question; the options are the outcomes to choose between (what passed, what broke,
  and the specific wrong thing worth naming). Ask the next case only after the last
  one is answered, and keep a running tally so nothing is silently skipped. Never
  paste a numbered list of cases and leave the person to work through it — they are
  at the keyboard, reading a plan costs them the attention the test needs, and a
  pasted list comes back as "some passed" with no record of which. Decisions go the
  same way: one per question, your pick first, each one's cost inside the
  question — never a list; once the owner is back, ask them one by one. Automate every
  check you can — a suite, a dev build you drive; the owner hand-tests only a case
  that matters and truly cannot be automated (name it and say why), or a round the
  owner asks for. Even then the AI does every step of the case the ladder in
  `test/AGENTS.md` (Hand tests) lets it do, asks the owner only for the step that
  needs a person, and checks that step itself afterwards in a log or file. One dev build at a time: stop every older one first, its Electron
  main process too (killing `electron-vite` alone leaves the window up). A dev build
  has its own profile (`koloft-dev`), so an installed Koloft on the same machine stays
  open.
- Four setup steps, each with a silent failure mode:
  - `npm run rebuild` before the first run, and again after any change to the Electron
    or node-pty version — otherwise the app crashes on launch with an ABI mismatch.
  - A fresh git worktree has no `node_modules` of its own and Node silently resolves up
    to the parent checkout's. Each agent's SessionStart hook (`scripts/worktree-deps.mjs`)
    runs `npm ci`, `npm run rebuild`, the Electron download and the `vendor/` download in
    the background the first time a session starts in a worktree without
    `node_modules`. A failed step wakes Claude Code; for every agent it stops each push
    until a later session start or `node scripts/worktree-deps.mjs --here` installs it,
    and so does an install still running. When a worktree is entered mid-session no
    session starts, so run `node scripts/worktree-deps.mjs --here` there.
  - `npm ci` and `npm install` do not fetch the Electron binary — run
    `node node_modules/electron/install.js` once, or the first launch stalls on a
    silent download.
  - `vendor/` (the git, gh and Git Credential Manager Koloft ships) is only downloaded
    when the app is packed — run `node scripts/fetch-vendor.cjs` once, or a dev build
    quietly ships none of them and `bundled-git-gh.spec.ts` fails.
- The repo's hooks are Claude Code's `.claude/settings.json`, Codex's
  `.codex/config.toml` and Antigravity's `.agents/hooks.json` (ADR-0053). Codex runs a
  hook only once its line is trusted in that machine's Codex config, and skips an
  untrusted one without a word: after a change to those lines merges, and on a machine
  Codex has not run this repo on, run `node scripts/trust-codex-hooks.mjs` there.
  `test/unit/devRules.test.ts` pins those lines and these files' shape; it is not
  reachable by import, so `test:unit:changed` never picks it — run it by name when you
  change `AGENTS.md`, `test/AGENTS.md`, `.codex/config.toml` or `.agents/hooks.json`.
  A skill for this repo goes in `.agents/skills/<name>/SKILL.md`, which Codex and
  Antigravity read; Claude Code reads only `.claude/skills`, so the day the first one
  lands, probe whether a symlink there reaches it.
- Shell in a Claude Code worktree stays plain. The isolation guard refuses any Bash call it
  cannot prove stays inside this worktree. This block binds you too, its last
  line aside; long text for `gh` goes in a `--body-file`:

  ```
  Shell rules — a guard refuses the rest; each refusal is a lost turn:
  - One plain command per Bash call, absolute paths. No loop, $(…), any ` or shell
    variable whose value lands in an argument; no env -u or HOME=.
  - Also refused: a path outside the worktree inside a chain, a cd outside then
    git, a shell name or builtin as an argument (grep -n "source" f, bash
    --version, docker … sh -c), python3 - or sh <file> whose text names git
    (a .github path counts).
  - Create or change every file, scratch scripts too, with Write/Edit, even when
    told to prefer Bash; run a script as node/python3/sh <file>. No heredoc,
    node -e, sed -i, perl -pi or cat >.
  - Quote every glob, ? and sed ;: --include='*.ts', 'a?n=1', '1,8p;9,20p'.
    Unquoted, it never runs (zsh: "no matches found"); the tool may still
    report success.
  - Quote a spaced path: '/a b', never /a\ b.
  - Never git -C another checkout: diff origin/<branch>; gh pr diff <n> takes no path.
  - A path no tool printed is a guess: grep -rl 'word' src.
  - No gh api -o or --comments with --json; strings -o is offsets: use > file.
  - Read ends at 25,000 tokens (~50KB), not lines: wc -c, offset+limit.
  - {0,N} spans: /usr/bin/grep -o -E, never bare grep (ugrep); N ≤ 255.
  - Findings go in your final message; the harness refuses report files.
  ```
- Auth comes from Koloft's own multi-account balancer (Settings ▸ Accounts): the claude
  shim injects the picked account per launch; the probe/header contract is
  `docs/claude-code-contract.md` §7. A Codex account is its own `CODEX_HOME`, picked per
  launch (`docs/codex-cli-contract.md` §15).
- Any browser automation here stays headless — never pass `--headed` unless asked to
  watch. The automation may run on the machine a person is working at, so a browser window
  that takes focus, or merely covers a fullscreen Space, interrupts whatever is being
  typed at that moment. The app's own e2e suite obeys the same rule by launching
  hidden and never showing itself.
- `README.md` is the human-facing product page (install, packaging). Don't
  read it for context — the code is the source of truth; read it only when the task is
  editing the README itself. Test-layer seams and conventions live in `test/AGENTS.md`.
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
  contract ledgers, the ADRs, the roadmap, and the plugin format reference
  `docs/plugin-format.md`),
  never a shipped feature's design doc.
- The roadmap is `docs/roadmap.md`: the tiered checklist, the explicit not-doing list,
  and how much to trust the order. Start any "what's next" discussion from it rather
  than re-deriving one, and edit it there when a decision changes.
