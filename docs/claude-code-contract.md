# Claude Code contract ledger

Measured facts about Claude Code (CC below) that Koloft depends on and that **reading
Koloft's own code cannot reveal**. Every entry carries its observation date, CC version,
and how it was established; any entry can drift when CC upgrades — the canary run
(below) watches for structural drift, and a disproven entry is corrected in place,
never kept for history. This file records only observations of the
external system; Koloft's own mechanism rationale lives in ADRs (`docs/adr/`) and behavioral
claims live in tests (doctrine: the document-retirement rule in CLAUDE.md). An entry
with no date, version or method is marked "inferred, not checked".

**Canary run** — the opt-in e2e specs against a real `claude`, run after each CC
release on a copy of the new binary downloaded to a scratch folder (never the installed
one, and never `claude update`): `agent-tools-real-smoke.spec.ts`,
`cron-real-smoke.spec.ts`, `conductor-ssh-lab.spec.ts` and `remote-ssh-lab.spec.ts`,
`--workers=1`, with `KOLOFT_SMOKE_CLAUDE` / `KOLOFT_SMOKE_CLAUDE_LINUX` pointing at that
copy (the other `KOLOFT_SMOKE_*` variables are read at the top of each spec). It is not
a gate. `test/e2e/helpers/env.ts` pins `KOLOFT_CLAUDE_CMD: 'claude'` after spreading
`process.env` and builds PATH itself, so an exported env var never reaches the app —
override `launchEnv` in code instead (pattern: restart-session.spec.ts). Viable because
specs assert structure, never model prose. A case that fails is re-run on the oldest
version Koloft supports (`MIN_CLAUDE_VERSION`) before it is called the new release's.

## §1 Hook event vocabulary (SessionStart / SessionEnd)

- **SessionEnd is NOT a "deliberate exit" signal — SIGHUP fires it too.** Controlled
  experiment (E6): `kill -HUP` on a real session (the same signal ⌘W / host quit
  delivers) still fires SessionEnd, with reason=`other`. So the *presence* of a
  SessionEnd can never be the eviction criterion — only a reason whitelist can.
- **Observed reason mappings** (all measured on a real claude):
  - `/exit`, Ctrl+D, worktree-session exit (either Keep/Remove choice) →
    `prompt_input_exit` (3/3 repeats, E1/E2/E8); Ctrl+C twice at an idle prompt too,
    and both `/exit` and that Ctrl+C exit with code 0 (2026-10-06, CC 2.1.291, a pty;
    SIGHUP gave 129). A hook still running can make an `/exit` fire no SessionEnd at
    all (§14).
  - `logout` → `logout`
  - SIGHUP → `other` (E6); a finishing `claude -p` run → `other`
  - `/clear` → `clear` (process stays alive; a new-id SessionStart with
    source=`clear` follows on the same tab)
  - in-TUI `/resume` switch → `other` (process stays alive; new-id SessionStart with
    source=`resume` follows, E3)
- **Full enums** (read from CC 2.1.238 source, 2026-08-22): SessionEnd reason =
  `clear / resume / logout / prompt_input_exit / other`; SessionStart source =
  `startup / resume / clear / compact / fork`. A `compact` SessionStart can fire
  **mid-turn**, while the model is still working. The bullets above are observed
  mappings; the enums are the value space.
- **auto-compact restarts in place with the SAME session id** (E1 could not produce an
  id change).
- **A manual `/compact` fires PreCompact, then SessionStart `compact`, and no
  UserPromptSubmit or Stop** (2026-10-04/05, CC 2.1.289 and 2.1.290, interactive pty,
  hooks logging their payloads). PreCompact carries `trigger: "manual"` and
  `custom_instructions` (the text after `/compact`, or null) about 0.03 s after Enter;
  SessionStart `compact` comes when the summary is done, 4–15 s later, same session id.
  Typed while a turn runs, it waits for the turn: Stop, then PreCompact. The plain
  `user` record `"/compact"` (no `origin`) is on disk at once; the `<command-name>` and
  `<local-command-stdout>Compacted …</local-command-stdout>` records only land when it
  ends, though they carry the Enter-time timestamp. Esc during it cancels it (no
  SessionStart) and puts `/compact ` back in the input box. So the session is busy from
  PreCompact to SessionStart `compact`, and no other hook says so.
  **No SessionEnd fires around it**, measured 2026-10-24 on CC 2.1.310 (interactive pty,
  model haiku, every hook event logging its payload; two runs, the same both times):
  SessionStart `startup`, UserPromptSubmit, Stop, PreCompact `manual`, SubagentStop (the
  summary writer, `agent_type: ""`), SessionStart `compact`, PostCompact `manual`, all one
  session id; the only SessionEnd was `prompt_input_exit` at the `/exit` typed afterwards.
- **An automatic compaction fires the same two hooks, with `trigger: "auto"`, inside the
  turn it interrupts** (2026-10-09, CC 2.1.295, interactive pty,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW=50000`, model haiku, hooks logging their payloads; two
  runs). Mid-turn: UserPromptSubmit, tool calls, PreCompact, SessionStart `compact`,
  PostCompact, more tool calls, Stop. At the start of a prompt: UserPromptSubmit, then
  PreCompact, SessionStart `compact`, PostCompact, the reply, Stop. Every hook carries the
  turn's `prompt_id`, and the turn's own Stop ends it.
- **Claude also compacts while idle, with no prompt and no Stop around it.** Seen in two
  real sessions (2026-10-08/09, CC 2.1.29x, Koloft's hook log and the transcript): Stop,
  the `idle_prompt` Notification, then about 55 minutes later PreCompact and SessionStart
  `compact`; the transcript gets `compact_boundary` (`trigger: "auto"`), the summary
  record below, and a `system`/`informational` record "Compacted while idle, before the
  prompt cache expired". **Its PreCompact payload carries `trigger: "auto"`**, measured
  2026-10-20 on CC 2.1.305: a real interactive session in Koloft's hand-test sandbox,
  context past `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS=100000`, left alone after one turn;
  53 minutes later Koloft's hook logged the PreCompact with that trigger, then the
  compact SessionStart, with nothing else between them. When it fires is read from the binaries, not probed (2.1.293,
  2.1.296 and 2.1.299 carry the same code; `strings`, 2026-10-14, correcting a 2.1.295
  reading that took the floor for the default): a server-side flag
  (`tengu_sunny_locket`; with none the mode is `off`), a conversation of at least
  **200 000** context tokens by default — `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` sets
  another minimum, never below 100 000 — armed only while the last request's prompt
  cache TTL is `1h`, fired at a fraction of that hour counted from the last activity
  (0.5–0.95, default 0.9, so about 54 minutes), skipped when the timer wakes more than
  60 s late or the person typed within the last 60 s, and `"idleCompaction": false` in a
  settings file turns it off (`true` turns nothing on). The 2.1.299 changelog announces
  it with these numbers and says the setting needs 2.1.290 or later. The same two
  binaries from 2.1.296 on also hold a second idle path behind `CLAUDE_CODE_SLEEP_COMPACT`
  (default 150 000 tokens, floor 60 000) — a pointer only. The same key, flag and
  numbers in 2.1.302 (`strings`, 2026-10-17); since 2.1.302 the `informational` record
  reads `Compacted while idle, before the prompt cache expired · turn off with
  "idleCompaction": false in settings.json` (the tail is new, joined with a no-break
  space), and `/config` gets an `Idle compaction` row (read, not run). Koloft shows that
  record's text as a notice without matching on it (`commandOutputOf`), so only the
  words a user sees change.
- **Every compaction ends by writing a summary record**, at about the moment SessionStart
  `compact` fires (2026-10-09, CC 2.1.295, manual and automatic): `type: "user"`, string
  content "This session is being continued from a previous conversation that ran out of
  context. …", `isCompactSummary: true`, `isVisibleInTranscriptOnly: true`, no `origin`,
  no `isMeta`. It is not something anyone typed. Koloft reads hooks at once but the
  transcript on a 500 ms poll, so the summary is usually read after the compaction has
  ended: two dev-build runs of `/compact` with the real binary, read before this rule,
  both showed the row go back to working about 0.5 s after it went back to waiting.
- **On exit CC prints a resume hint, and since 2.1.299 it names the session by its id,
  never by its `--name`**: `Resume this session with:` / `claude --resume <id>`, named or
  not; after a keep-the-worktree exit `claude --worktree "<worktree>" --resume <id>`
  (the worktree name quoted, the id bare); when that line does not fit the terminal,
  `claude -w "<worktree>" -r <id>`; when neither fits, three rows above it (`This
  session ran in a worktree` / `In its folder, run the command below to resume in it` /
  `To find that folder, try git worktree list`) and then the bare `claude --resume
  <id>`. Through 2.1.296 it quoted the name instead: `claude --resume "<name>"` once the
  session had a `--name`, and `claude --worktree <name> --resume "<name>"` after a
  keep-the-worktree exit (measured 2026-09-03 on 2.1.259 and again 2026-10-14 on
  2.1.296, §4). **A session that never took a message prints no hint at all** (both
  versions). Measured 2026-10-14 on 2.1.296 and 2.1.299, python pty 120, 60 and 50
  columns, scratch `HOME`, no login (one `hello` typed first), named and unnamed, plain
  folder and a `-w` keep exit; the lines come dim right after the screen reset, since the
  default (not fullscreen) mode uses no alternate screen. Koloft reads this hint only to
  see past it to a worktree removal's first line (§4).
- **A resumed session's SessionStart hook reports the LAUNCH directory as cwd, not the
  worktree** — the re-enter happens after the hook (E8). Seen again 2026-10-09 on CC
  2.1.295, real sessions on the dev Mac that Koloft resumed from the repo root after a
  restart: one's SessionStart record (`source: resume`) named the root while it worked in
  its worktree; another, a `-w` session whose transcript sat in the root's slug, went on
  writing records whose `cwd` and `worktree-state` named the worktree, with no
  `relocated` record and no transcript move until it left, so only those records said
  it was back in the worktree.
- **A running SessionStart hook is visible and can be cut short** (changelog, read
  2026-09-18, not measured): 2.1.268 — `--continue`/`--resume` show the conversation at
  once instead of waiting for SessionStart hooks; 2.1.271 — the spinner names the
  running hook with elapsed time, and Esc cancels a prompt waiting on one. So a hook
  that does slow work before its report may never report.
- **A hard exit fires no SessionEnd.** Only a clean exit (`/exit`, Ctrl+D, `logout`,
  and SIGHUP above) fires it; a kill by Ctrl+C, a crash or `kill -9` fires none, so
  only a liveness check notices. **SIGTERM counts as a clean exit**: it fires
  SessionEnd reason=`other`, then claude exits with code 143 (2026-09-29, CC 2.1.284:
  an idle interactive `claude` in a pty with SessionStart/SessionEnd hooks that log
  their payloads, sent `kill -TERM`). **claude waits for its
  own SessionEnd hook to finish before it exits**, so when the session pty dies the
  hook's report file is already whole. (Both inferred, not checked.)
- **`/exit` while a background shell command still runs draws a dialog, not an exit.**
  Titled "Background work is running", it lists what will stop ("The following will
  stop when you exit: shell · sleep 300") and offers `1. Exit and stop tasks` (preselected),
  `2. Move to background and exit`, `3. Stay`, "Enter to confirm · Esc to cancel". Left
  alone for 40 s nothing happened: no SessionEnd, the process and the `sleep` alive. Enter
  then fired SessionEnd `prompt_input_exit`, killed the `sleep` and exited with code 0
  about 1.1 s later. The same on 2.1.299 and 2.1.300 (2026-10-15, python pty, scratch
  `HOME`, haiku, `--dangerously-skip-permissions`, a `run_in_background` Bash `sleep`
  from the model, one run each). Koloft itself never types `/exit`; a person or an agent
  that does, with a background command running, leaves the session on this dialog.
- **Every hook payload carries `session_id`**, run-state events (UserPromptSubmit,
  Stop, Notification) included, not only SessionStart/SessionEnd. (Inferred, not
  checked.)
- **A hook's env has the running claude's version only inside `AI_AGENT`, which ends
  in `_harness` there and in `_agent` in the Bash tool's shell.** Inside a Bash tool call `CLAUDE_CODE_EXECPATH` is the binary
  (on a native install inside `…/versions/<version>`, so its basename is the version)
  and `AI_AGENT=claude-code_X-Y-Z_agent`. Seen 2026-09-24 on CC 2.1.281 with `env`
  inside a Bash tool call: `CLAUDE_CODE_EXECPATH=/Users/…/.local/share/claude/versions/2.1.281`,
  `AI_AGENT=claude-code_2-1-281_agent`. A hook gets no `CLAUDE_CODE_EXECPATH` and
  `AI_AGENT=claude-code_X-Y-Z_harness`: measured 2026-10-28 on 2.1.311 and 2.1.312 with
  a command hook that logs its env, in an interactive pty run (6 runs); the binary sets
  `_harness` for its own process and `_agent` only for children it starts as the agent.
- **A brand-new claude prints its login and onboarding links before its SessionStart
  hook fires**, so a user can click a link before the session is bound. (Inferred, not
  checked.)
- **Since 2.1.312 at most 24 hooks of `type` `prompt` or `agent` run at a time per
  session, sub-agents included, plus at most 12 that have waited past their event's
  timeout; a `timeout` under 1 s counts as 1 s** (the changelog line; `strings`,
  2026-10-28, darwin-arm64 and linux-arm64, not run: the constants 24 and 12 beside the
  same type filter, the labels `model hooks` and `overdue model hooks`, and
  `Math.max(timeout, 1) * 1000`). From 2.1.302 to 2.1.311 the limit was 12 hooks of one
  event (`strings`, 2026-10-17, not run: a limit constant of 12 and a filter on those two
  types, absent from 2.1.301). Every hook Koloft writes is `type: "command"` with a
  `timeout` of 3600 s or none (`src/main/hooks.ts`, local and SSH tabs alike), so none
  of them queues or is raised to 1 s. The hook event list is the same 33
  names on 2.1.301 and 2.1.302 (`strings`, 2026-10-17), on 2.1.303 (`strings`,
  2026-10-19: the same array, the same limit constant and type filter) and on 2.1.304
  (`strings`, 2026-10-20: the same again), and on 2.1.306, darwin-arm64 and linux-arm64
  (`strings`, 2026-10-21: the same array, constant and filter, and the skill-hook
  constants below), and on 2.1.308, darwin-arm64 and linux-arm64 (`strings`,
  2026-10-22: the same again), and on 2.1.309, darwin-arm64 and linux-arm64 (`strings`,
  2026-10-23: the same array, the limit `12` beside the `prompt`/`agent` type filter,
  and the skill-hook constants `1024` and `16384`), and on 2.1.310, darwin-arm64 and
  linux-arm64 (`strings`, 2026-10-25: the same again), and on 2.1.311, darwin-arm64 and
  linux-arm64 (`strings`, 2026-10-27: the same 33 names in the same order), and on
  2.1.312, darwin-arm64 and linux-arm64 (`strings`, 2026-10-28: the same 33 names in the
  same order).
- **Since 2.1.304 the hooks a skill declares in its `SKILL.md` front matter register
  only while the skills of one source stay within 1,024 hooks and 16,384 matcher
  characters per session**; past that, none of that skill's hooks register and its
  `allowed-tools` are not granted (the changelog line; `strings`, 2026-10-20, not run:
  two new constants 1024 and 16384 on the skill-hook path). Hooks from a settings file
  are not counted; Koloft's hooks all come from `--settings` and its `SKILL.md` declares
  none.
- **A session's SessionStart hook has exited before its first UserPromptSubmit hook
  starts, even when the prompt was given or typed earlier.** So a hook that appends both
  to one file writes the start first. Measured 2026-10-22 on CC 2.1.308 linux-arm64 in a
  Docker container with no network (a fake key from `apiKeyHelper`, so the prompt hook
  fires and the request then fails), four busy loops beside it, a SessionStart hook that
  sleeps 1 s and hooks that log their entry and exit: 40 runs each of `claude -p`, an
  interactive `claude -- <prompt>`, an interactive `claude` with the prompt typed and
  Enter pressed 0.5 s after spawn (before the hook ended), and `--resume <id>` typed the
  same way, plus 20 of `/clear` followed 0.1 s later by a typed prompt. No prompt hook
  ever began before the start hook's exit; in the 100 runs that counted it (the second
  20 of each kind and the `/clear` ones), it fired in 99 (one `--resume` run sent no
  prompt). After `/clear`, SessionEnd `clear` had also
  exited before SessionStart `clear` began. Not probed: the in-TUI `/resume` switch, and
  `compact` (it can fire mid-turn, with no prompt after it).

Evidence: live experiments E1–E8, 2026-08-10, claude 2.1.227; enums read from CC 2.1.238 source on 2026-08-22. Koloft dependents: the `EVICTING_END_REASONS` whitelist
in `src/main/backends/claude.ts` (marked `CC§1`); `sessionTracker.bindSession` (it takes
the hook's `cwd` — the launch-directory entry above) and `followWorktreeState` (which
then moves the root to the worktree the last `worktree-state` names); the start line in
the status log (`HOOK_SCRIPT` in `src/main/hooks.ts`), which `ClaudeBackend` applies in
order with the turns and holds back until the tab's shim registration;
`test/e2e/fixtures/fake-claude.js`
mimics this section (SessionEnd `other` on SIGTERM too, like the real one).

## §2 Transcript on disk

- **Lazy write: the jsonl is only created at the first user message**, while
  SessionStart fires with the jsonl path already filled in — a non-empty path ≠ an
  existing file (a 77s gap was measured between bind and first write). **Exception:
  `/clear` writes the new id's jsonl immediately**, so the "after /clear, before the
  first prompt" window does not actually exist. (Verified live 2026-08-24; CC version
  not recorded.)
- **A `-w` session's transcript sits in the WORKTREE's slug while the session is alive,
  and a clean `/exit` moves it to the root checkout's slug**, leaving the worktree slug
  directory empty (§4). A session that was killed never moves. (Measured 2026-09-03,
  2.1.259.) So the slug alone does not say whether a session is bound to a worktree:
  of 535 transcripts (2026-08-10, CC 2.1.220–227), 116 carry a worktree-state record —
  90 in the repo-root slug, 26 in the worktree's own slug. Two independent axes: the
  slug the transcript lives in decides the resume starting directory; the presence of
  worktree-state decides whether the re-enter applies. That the 90-vs-26 split is
  exited runs versus killed ones is inferred, not checked.
- **worktree-state record shape**:
  `{"type":"worktree-state","worktreeSession":{originalCwd, preEnterOriginalCwd, worktreePath, worktreeName, worktreeBranch, originalBranch, originalHeadCommit, sessionId}}`.
  Position census: 86/116 on line 4, 23 on lines 2–3, deepest at line 236; 2/535 sit
  beyond the 256KB head-scan window (treated as unbound — accepted fallback).
  **`worktreeSession.sessionId` differs from the file's own id in 14/116 samples**
  (the binding is inherited from a predecessor session). The record also carries a
  top-level `sessionId` (seen 2026-09-24, CC 2.1.281, one transcript).
- **CC keeps re-writing `worktree-state` through the run, so the LAST one sits near the
  end of the file** and says where the session is now; the first one only says where
  it started. Census 2026-09-23, CC ≤2.1.281, 313 transcripts carrying one: the last
  record sat at most 49KB from the end (p90 27KB).
  241 ended on `worktreeSession: null` (left the worktree), all in the root checkout's
  slug; 70 ended bound, all in a worktree's slug; 2 ended bound in the root slug.
  Measured by reading every `~/.claude/projects/*/*.jsonl` on the dev Mac.
  **The re-write does not come every turn, so no fixed tail size is enough.** Measured
  2026-10-15 (python pty, scratch `HOME`, haiku, a throwaway one-commit repo, one run per
  binary): a session that entered a worktree with `EnterWorktree` and left it with
  `ExitWorktree` in its first turn, then took two more turns (a Bash `echo` and a plain
  reply), ended with its last `relocated` + `worktree-state: null` pair 25 KB from the
  end on 2.1.300 (the two turns added 13 KB and 7 KB, no new pair) and 6 KB from the end
  on 2.1.299 (its Bash turn wrote a fresh pair, the plain turn added 6 KB; what triggers
  a re-write is not probed). In a `-w` session on 2.1.300 the pair was re-written twice
  inside the first turn (before and after the API call) and not at all in the second.
  Since 2.1.300 a tool result is on disk twice (the `api-request` records, below), so a
  few turns after a move can push the last pair past any fixed window; Koloft's rescan
  in `workspaces.ts` reads the tail in doubling chunks until one holds a
  `worktree-state` or `relocated` line.
- **Auto-memory lives beside the transcripts, in `~/.claude/projects/<slug>/memory/`**
  (`MEMORY.md` plus one `.md` per memory), and CC writes it with the ordinary
  Write/Edit tools, so memory files land in the transcript's file writes like any
  other. A sweep on 2026-10-01 (CC up to 2.1.287) of the 398 transcripts touched in the
  last 30 days found 927 Write/Edit calls on files under such a `memory/` folder.
- **A plan-mode plan is a file in `~/.claude/plans/<slug>.md`, written with the ordinary
  Write tool**, after which CC calls `ExitPlanMode` with input `{plan, planFilePath}`;
  `plan` is the file's text. So a plan file lands in the transcript's file writes like
  any other. Seen in a real plan turn (CC 2.1.286, transcript re-read 2026-10-09); the
  2.1.288 binary's strings agree and also hold a `plansDirectory` setting and a
  `<slug>.workshop.md` name, neither seen in use.

- **Message-line field vocabulary**: jsonl message lines carry
  `cwd / gitBranch / timestamp / sessionId / version`; a `summary` record is NOT
  guaranteed to exist. **`gitBranch` can lag** — a worktree session was measured
  recording `main` — so the field does not say which checkout the file belongs to.
  (V1, CC 2.1.225.) A sweep on 2026-09-24 of all 210 transcripts then on disk (CC up to
  2.1.281) found 0 with a `summary` record and 78 with an `ai-title`.
- **The slug is built from the PHYSICAL directory, with every symlink resolved.**
  Started through a symlinked path, CC files the transcript under the real path's slug
  and records the real path as `cwd`; the typed path's slug is never created. Measured
  2026-09-10 on CC 2.1.267: a real folder `/private/tmp/slugprobe/real` with a symlink
  `link` beside it, `sh -c 'cd …/link && claude -p "say hi" --session-id …'` (the shell
  kept the logical path — `pwd` said `link`, `pwd -P` said `real`); the only new
  directory was `~/.claude/projects/-private-tmp-slugprobe-real`, and every `cwd` in the
  jsonl read `/private/tmp/slugprobe/real`. So anything that guesses a slug from a path
  a person typed has to resolve it first (Koloft dependent: a remote workspace's mirror,
  `src/main/remote/` — the heartbeat asks the machine for `pwd -P`).
- **Over-long cwds get a truncated slug plus a 6-char suffix** (measured
  `…-sequential-bak-ezjn6r`) — `encodeCwd` direct concatenation can miss; matching
  needs a prefix match plus a read-back of the jsonl's first `cwd`. (2026-08-08.)
- **Per-session scratchpad on disk**:
  `<resolved /tmp>/claude-<uid>/<slug>/<sessionId>/scratchpad` (lazily created —
  usually absent at bind time). **The slug is not always the jsonl's**: `scratchpad/`
  sits under the slug of the folder the claude process was started in, while the
  transcript and `tasks/` sit under the slug of the folder the session is in now. So a
  `claude -w` started in the main checkout, or a session that entered a worktree with
  the EnterWorktree tool, keeps `scratchpad/` under `<main checkout slug>` and `tasks/`
  under `<worktree slug>`; a claude started inside the worktree keeps both under
  `<worktree slug>`. Measured 2026-09-29 on CC 2.1.284: an interactive `claude` started
  in a worktree folder named `/private/tmp/claude-501/<worktree slug>/<id>/scratchpad`
  as its scratchpad when asked; on disk, a `-w` session and an EnterWorktree session
  (CC 2.1.283–2.1.284) had `scratchpad/` under the main checkout and `tasks/` under the
  worktree, and a `-w` session with 96 `worktree-state` records (so, inferred, resumed
  many times from inside the worktree) had both under the worktree. (`claude -p` names
  no scratchpad at all.) Older versions not checked. `tasks/` holds full subagent
  transcripts (single files reach MBs).
  **On CC 2.1.295 an EnterWorktree session keeps `tasks/` under `<main checkout slug>`
  too**, while a `-w` session still keeps it under `<worktree slug>`. Measured
  2026-10-08: a session started in the main checkout that called EnterWorktree, then ran
  two `run_in_background` Bash calls 2 s and 66 min later, had both
  `<id>.output` files (and its subagents' `.output` links) under
  `/private/tmp/claude-501/<main checkout slug>/<id>/tasks/`, with `lsof` showing the
  live shell's fd 1 there, and no `<worktree slug>/<id>` folder at all; a `claude -w`
  session started from the main checkout, with its scratchpad under the main checkout,
  was told by its own Bash tool that a background command wrote to
  `<worktree slug>/<id>/tasks/<task>.output`. So which slug holds `tasks/` cannot be read
  from the transcript's folder or the launch folder; only the `<sessionId>/tasks/` end of
  the path is fixed.
  The per-user folder is `realpath(<base>/claude-<uid>)` (mode 0700). `<base>` differs by
  OS. macOS build: `$CLAUDE_CODE_TMPDIR`, else a fixed `/tmp` — `$TMPDIR` is ignored
  (CC 2.1.286 and 2.1.287 macOS binaries:
  `function NS(){let e=a.CLAUDE_CODE_TMPDIR;if(e)return e;return"/tmp"}`; a session
  started with `TMPDIR=/var/folders/…` still used `/private/tmp/claude-501`). Linux build:
  `$CLAUDE_CODE_TMPDIR`, else Node's `os.tmpdir()`, which follows `$TMPDIR` (2026-10-01,
  CC 2.1.287 linux-arm64 in an `ubuntu:24.04` container, uid 1234, not logged in:
  `function Lb(){let e=a.CLAUDE_CODE_TMPDIR;if(e)return e;return g()}` with `g` =
  `tmpdir`; an interactive session made `/tmp/claude-1234`, with `TMPDIR=/var/tmp/x` it
  made `/var/tmp/x/claude-1234` and nothing under `/tmp`, with `CLAUDE_CODE_TMPDIR` set it
  used that). Under it sits `<slug>/<session id>/scratchpad`, `<slug>` being the
  transcript's project folder name (seen the same day in the same build, turns run against
  a stand-in Messages API through `ANTHROPIC_BASE_URL` + `apiKeyHelper`: default,
  `TMPDIR` set, a symlinked `TMPDIR` (resolved), `CLAUDE_CODE_TMPDIR` set, and a cwd with
  a space and a dot all wrote there). The path reaches the model in the first user
  message's system reminder (`Scratchpad directory: …`), not in `system`. The scratchpad
  exists only while the `tengu_scratch` feature flag is on (2.1.287: `Fw()` =
  `tengu_scratch || isArtifactToolEligible()`); with it off, claude names and makes none,
  which is why an idle, logged-out session showed only the empty per-user folder. The
  remote heartbeat asks the machine for this base and its uid (Koloft dependent:
  `src/main/remote/install.ts`); through the docker ssh lab a real Linux claude's
  scratchpad, with and without `TMPDIR` from pam_env, was the folder Koloft's Browse
  listed. Koloft does not follow `CLAUDE_CODE_TMPDIR` on this Mac.
- **A live session can move to another checkout, and the transcript moves with it.** The
  `EnterWorktree` / `ExitWorktree` tools relocate a session mid-conversation; on disk that
  is ONE `rename` of the jsonl into the destination directory's slug — **the inode is
  preserved** (measured: 89888511 → 89888511; a file rebuilt under the same name gets a
  new one), and **no hook fires at all**, so the SessionStart path that is Koloft's only
  other source of a transcript path never runs. Census: 191/965 transcripts carry a
  `relocated` record, 652 records in all — 267 naming a worktree, 385 naming a root
  checkout. The session's own directory is no guide: one real session hopped between a
  workspace and three vendored clones 11 times with a plain `cd`, and its transcript
  never moved.
- **`relocated` record shape**: `{"type":"relocated","sessionId":…,"relocatedCwd":"<dir>"}`
  — the field is `relocatedCwd`, there is no `cwd`, no timestamp, and the record is
  usually written two or three times per move. It is the only reliable statement of where
  a move landed, and the records come in pairs with a `worktree-state` (payload `null` on
  the way out).
- **Occasionally a stub is left behind at the old path** instead of nothing: 1/965, same
  session id, 2,831,347 bytes / 994 lines at the new path versus 1,363 bytes / 7 lines
  (an `ai-title` and a `worktree-state`) at the old one. A reader that keeps watching the
  old path does not freeze in that shape — it re-reads a shorter file and zeroes the
  session's spend.
- **A subagent cannot enter a worktree** (2 probe runs): asking it to create one is
  refused — "EnterWorktree from a session with a pinned working directory requires
  `path`" — and entering an existing one by path failed too; the parent transcripts
  carried 0 `worktree-state`, 0 `relocated` and 0 sidechain records. So a session move is
  always the main loop's own doing. **This is the entry most likely to drift.**
- **Tool file paths are all but always absolute**: 17 relative out of 18,035 (0.094%),
  every one a `Read`, all in a single repository. A relative one means a file under the
  directory CC stood in on that line, so it has to be resolved as it is read, once.
- **A message typed while claude is busy writes no `user` record.** Measured 2026-10-02,
  CC 2.1.288, interactive session in a scratch `HOME`: a line typed during a running
  `Bash` call left a `queue-operation` record `{operation:"enqueue", content:<text>}`,
  then `{operation:"remove", reason:"absorbed_mid_turn"}`, then an `attachment` record
  `{type:"queued_command", prompt:<text>, commandMode:"prompt", origin:{kind:"human"},
  humanTurn:true}`; the reply came later in the same turn, before one Stop. A line typed
  while idle is a plain `user` record with `origin: {kind:"human"}`. Other `user` records
  carry `origin.kind` `task-notification` (`isMeta` false) or `channel`, and older ones no
  `origin` at all. A sweep of 80 recent transcripts on this Mac (CC 2.1.285–2.1.288,
  2026-10-03): `queued_command` attachments were 9 `prompt`/`human`, 2 `prompt`/`peer`
  (§13), 3 `prompt`/`channel`, 89 `task-notification`; `user` records 261 `human`, 193
  `task-notification`, 7 `channel` and 4 `peer`; every assistant record held at most one
  `text` block, and no `(message.id, text)` pair repeated.
- **Not every non-meta `user` record with no `origin` was typed by a person.** A sweep of
  the 487 main transcripts on this Mac (2026-10-09) found, among those, one opening with
  `<system-reminder>` and three with `<teammate-message teammate_id=…>` (all CC 2.1.111);
  no `<task-notification>` text came without its `origin`.
- **CC deletes transcripts itself**: `claude project purge [path]` — "Delete all Claude
  Code state for a project (transcripts, tasks, file history, config entry)"
  (`claude project --help`, 2.1.281, 2026-09-24).
- **Concurrent sessions do not revert each other's `~/.claude.json` writes from 2.1.259
  on** (changelog: "workspace trust no longer resets"; read 2026-09-18, not measured).
  Before that, a workspace's trust answer (the key is in §9) could be reset.
- **Since 2.1.300 the transcript also records every API request: three new record
  types, and a bigger file.** Measured 2026-10-15, one `claude -p` run of the same
  two-request prompt (a Bash `echo`, then a reply; haiku, scratch `HOME`) on each
  binary: 2.1.299 wrote 25 records, 99,337 bytes; 2.1.300 wrote 33 records, 154,524
  bytes. The extra records: one `api-request-shape` (`{type, shapeHash, shape}`, 39 KB
  here, 83–85 KB in an interactive session — the tool definitions; written once per
  distinct shape), one `api-request-blob` per message sent (`{type, hash, message}` — a
  copy of that user or assistant message, so a tool result is on disk twice), and one
  `api-request` per request (`{type, id, querySource, shapeHash, params, base, keep,
  tail, cacheControl, requestDigest}`, about 1.5 KB). The `assistant` record gained a
  `requestRef`. The `prompt_snapshot` attachment (`systemPrompt`, `tools`, …; 56 KB in
  `-p`, 115–127 KB interactive) is older — 2.1.299 writes it too. Both it and
  `api-request-shape` hold every tool's definition as `{"name":"<Tool>",…}`, so from a
  session's first turn its transcript matches `"name":"AskUserQuestion"` before any call
  (2026-10-20, linux-arm64 2.1.303 and 2.1.304 in the Docker SSH lab, sonnet: a grep of
  the transcript for that string, sampled every 0.3 s, matched after the first turn and
  before the prompt asking for the tool was typed; the call's PermissionRequest came
  ~10 s later). None of the three
  carries `cwd`; the shape and `api-request` records carry `sessionId`, `timestamp` and
  `version`, the blob only `sessionId`. Every Koloft reader that parses records picks
  them by `type` (`extractJsonlMeta`, `extractJsonlTail`, `lastTurnsOfLines`, the usage
  reader, `transcriptSearch`), so they read the same values as before; only the byte
  counts grew (the `worktree-state` tail bullet above). The same three records, with the
  same keys and no `cwd`, on 2.1.301 (2026-10-16, one `-p` run of the same prompt, sonnet,
  the real `HOME` with a scratch `CLAUDE_CONFIG_DIR`: 31 records, 145,974 bytes, one
  36.6 KB `api-request-shape`; that run also wrote `cost-state` and `atis-latch` records,
  which both binaries name — not new, and no Koloft reader picks them). On 2.1.302
  (2026-10-17, seven `-p` runs, haiku, a scratch `CLAUDE_CONFIG_DIR`, `--output-format
  json` or `stream-json`): each transcript held 2 `api-request`, 1 `api-request-shape`,
  3 `api-request-blob`, 1 `cost-state` and 3 `atis-latch` records, 31–32 records and
  150–164 KB in all; 2.1.301 run the same way wrote the same census.

Unless a bullet below says more, it is inferred, not checked.

- **The transcript is append-only.** Once the head of a file has been read to its end
  (or to the scan cap), later writes never change what that head says; a file that
  shrinks was rewritten by someone else. **The one CC path that shrinks a transcript
  is off unless asked for, and never runs in an interactive session**: read from the
  2.1.296 binary (`strings`, 2026-10-11), `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` is read
  from the environment only (a settings file's copy is dropped with a warning), is off
  when unset, and turns the compaction on only for a `-p` run that is not remote and
  has no SDK url (a cloud worker path falls back to a server flag, also off). When on,
  a file over 5 MiB that gained 20 MiB since the last pass is rewritten into
  `<file>.compact.tmp.<hex>` and renamed over the original, so its inode changes and
  it gets shorter. The same gate in 2.1.299 (`strings`, 2026-10-14); the binary's own
  changelog adds that since 2.1.296 a file is left alone when the rewrite would free
  under 10 % of it, and a managed-policy settings tier may be allowed to set the
  variable (a set naming it next to `policySettings`; not resolved).
- **`ai-title` records repeat.** CC writes the session's `ai-title` again every few
  turns with the same value, so the first one is enough (one 2.1.281 transcript,
  2026-09-24: 56 `ai-title` records).
- **Streaming repeats the usage record.** The same assistant usage object is written
  several times — 3 times in real transcripts, with the same `message.id` and
  `requestId`. Some records carry neither id and each must count; records with model
  `<synthetic>` carry no real spend.
- **Up to 2.1.306, in a sub-agent transcript the repeats are not the same: they grow.**
  Swept 2026-10-16 on this Mac, every `*.jsonl` under `~/.claude/projects` (3825 files, CC
  2.1.111–2.1.301, field names and numbers only): in main transcripts all 52,548
  `message.id` + `requestId` keys repeat the same usage object; in the
  `<session>/subagents/**` transcripts 32,181 of 44,412 keys have lines with different
  usage, the later ones holding the larger `output_tokens` (a streamed-so-far count),
  in every CC version present. Summing the largest value per key gives 71.3 M output
  tokens across both kinds; summing the first line gives 37.8 M. On 2.1.306 the first
  line of a repeated sub-agent key holds a placeholder `output_tokens` (6–7) and
  `stop_reason: null`; the later line holds the real count and `end_turn`; the other
  usage fields do not change. **From 2.1.307 on the sub-agent repeats are the same, as
  in the main transcript**: the first line already holds the final usage and
  `stop_reason` (the 2.1.307 changelog's "placeholder token usage and an empty stop
  reason" fix; 2.1.308 holds sub-agent assistant lines back from the file until the
  stream ends, `flushHeld` in its strings, read, not run). Measured 2026-10-22, three `claude -p` runs
  per build on 2.1.306 and 2.1.308 (haiku, scratch `HOME` and `CLAUDE_CONFIG_DIR`, one
  Agent call whose sub-agent did a Read and wrote ~300 words): 2.1.306 had 3 growing and
  0 equal repeated sub-agent keys, 2.1.308 0 growing and 3 equal; no key shrank on
  either; the record, `message` and `usage` key sets are the same on both. Taking the
  largest value per key gives the last line's sum on both builds, and older transcripts
  on disk still grow, so that is the rule that counts both. Only short thinking + text
  replies were measured; a long multi-block reply is not probed.
- **A sub-agent transcript names its parent.** Every usage line of
  `<slug>/<sessionId>/subagents/**/*.jsonl` carries the parent's `sessionId` (5042 of
  5042 lines, 2026-10-16), and every main transcript's lines carry its file name's id
  (10867 of 10867).
- **Some CC versions mix subagent turns (`isSidechain: true`) into the main jsonl**,
  their usage records and Esc interrupts included; their spend is the session's, their
  context window and model are not. Which versions was not recorded.
- **An Esc interrupt is a plain user record** whose only text is exactly
  `[Request interrupted by user]`, or `[Request interrupted by user for tool use]` when a
  tool was running, with no `isMeta` (26 of 210 transcripts carry one, sweep
  2026-09-24, CC up to 2.1.281); **no Stop hook fires for an interrupted turn**. Esc
  stops only the main loop; background tasks keep running.
- **A pasted image appears in the text as the TUI placeholder** `[Image #1]`,
  `[Image #2]` or a bare `[Image]`, also inside `<command-args>` (from a user bug
  report: `/goal <pasted image>`). **A paste that is only an image path still becomes
  `[Image #1]`; up to 2.1.310 a paste that ended with an image path did too and lost
  the path.** On 2.1.310, `look at <png>` became the text block `[Image #1]look at` plus
  an `image` block and `imagePasteIds: [1]`, with a separate `isMeta` user record
  `[Image: source: <png>]`; `! ls <png>` became `[Image #1]! ls` and never reached shell
  mode. A path in the middle (`look at <png> please`) stayed as typed on both builds.
  From 2.1.311 the path stays: `! ls <png>` is recorded as `<bash-input>`. Measured
  2026-10-27, CC 2.1.310 and 2.1.311, interactive haiku in a python pty read with
  `pyte`, one single-line bracketed paste each, Enter 2 s later, a real 8×8 PNG
  outside the cwd. Text Koloft pastes in for the owner (`bracketedPaste` in
  `src/main/typeKeys.ts`) that ends with an image path therefore reaches the model as
  typed on 2.1.311, and as an attached image on 2.1.310 (inferred from this probe, not
  run through Koloft).
- **2.1.311 adds a `tools-used` record** `{type: "tools-used", tools, sessionId}` with no
  `uuid`, `timestamp` or `cwd`, written once before the first assistant line; 2.1.310's
  binary names only `tools-used-before-summary`. Measured 2026-10-27, `claude -p --model
  haiku --output-format stream-json --verbose` with three Bash calls in a row (41
  records on 2.1.310, 42 on 2.1.311) and three in parallel plus one (3 runs per build).
  On both builds every record's `parentUuid` named a record earlier in the file, and
  parallel tool results each hang off their own `tool_use` record in the order they
  finished, so only the last is on the leaf's chain. The changelog's "saving transcript
  messages out of order or keeping messages that were taken back" case (an interrupt, a
  denied call) was not run. No reader in `src/` names `tools-used`; each picks records
  by `type`. 2.1.312 writes it too (2026-10-28, interactive pty runs: one per launch
  that ran a tool).
- **A Bash tool call that writes files leaves no file record**; the file-history
  snapshot stays empty for it and the command text is the only trace.
- **The `relocated` record is written before the transcript rename as often as after
  it**, and a resumed session replays its old `relocated` records.
- **Moves come in bursts**: 4 moves in 34 seconds were seen, two of them about 100 ms
  apart (enter A, enter B, leave, enter A again); only the last move of a burst matters.
- **Claude 4.0-generation transcripts record the dated model id** in `message.model`
  (`claude-opus-4-20250514`, `claude-sonnet-4-20250514`).
- **The Stop hook can fire a moment before the turn's assistant record is flushed** to
  the jsonl (seen live on 2.1.263), so a reader that trusts Stop has to poll for it.
- **A typed `/koloft <args>` runs Koloft's plugin skill `koloft:koloft` as a model turn,
  whose only typed record is a `<command-message>` one** (2026-10-20, CC 2.1.304, the butler's claude
  in Koloft, e2e temp HOME, `/koloft session list` sent from the fake Discord, so typed,
  Esc, Enter; 3 runs). The screen showed `❯ /koloft:koloft session list`. The turn's
  records: a `user` record (`origin.kind` `human`) whose string content is
  `<command-message>koloft:koloft</command-message>\n<command-name>/koloft:koloft</command-name>\n<command-args>session list</command-args>`,
  the skill body as an `isMeta` user record whose content is an array, the hooks'
  attachments, a Bash `tool_use`, its result, the reply text, `stop_hook_summary`. No
  `<local-command-stdout>` is written. UserPromptSubmit fired for it, as for a custom
  command (§17): Koloft saw the session go to working, and the hook's
  `hook_additional_context` attachment is in the turn.
- **A command that runs the model writes its record starting `<command-message>`; a
  built-in one starts `<command-name>`.** Every such record in this Mac's own
  transcripts for the koloft repo (2026-10-20, CC 2.1.29x–2.1.304): the skills
  `claude-api`, `deep-research` and `koloft:koloft` began `<command-message>…`, each
  followed by its body as an `isMeta` record and a model turn; `/goal`, `/model`,
  `/effort`, `/advisor` and `/compact` began `<command-name>…`.
- **What a slash command leaves in the jsonl** (2026-10-04/05, CC 2.1.289 and 2.1.290,
  every record of the runs read):
  - Its output is the text inside `<local-command-stdout>…</local-command-stdout>`, in
    a `system`/`local_command` record (`/context`, `/model`, a closed picker) or in a
    `user` record's string content (`/compact`, `/model haiku`, `/mcp`); it keeps
    the screen's colour codes. After `/compact` it also holds one line per hook that
    ran, `PreCompact [<the hook's command>] completed successfully` (seen with Koloft's
    own hook on the Linux build over SSH, CC 2.1.289). A `<command-name>` record names the command, and a
    `user` `isMeta` record holds `<local-command-caveat>`.
  - `/context` also adds a `user` `isMeta` record whose content is the same report as
    clean markdown ("## Context Usage …").
  - An unknown command writes one `system`/`informational` record, `level: "warning"`,
    content "Unknown command: /x. Did you mean /y?", and nothing else.
  - `/compact` first writes a plain `user` record whose content is `"/compact"` with no
    `origin` (a typed prompt has `origin: {kind: "human"}`), then the summary and its
    output records at the end (§1).
  - A `~/.claude/commands/<n>.md` command writes a `<command-message>` user record and
    its body as a `user` `isMeta` record, then a normal turn.
  - `/clear` writes its `<command-name>` record and an empty stdout into the new id's
    file.
- **A tool the person turns down still has its `tool_use`.** The `assistant` record with
  the `tool_use` is written before the permission dialog shows, so it is in the file
  whether or not the tool runs. When the person says No, its `tool_result` has
  `is_error: true` and a `content` that begins "The user doesn't want to proceed with
  this tool use.", and the record's `toolUseResult` is the string "User rejected tool
  use". A command that ran and failed has `is_error: true` too, with its own output. So
  "the tool ran" is a `tool_result` that is not that rejection. Checked 2026-10-28: the
  sentence is in the CC 2.1.312 binary (`grep -a`), and a real transcript from
  2026-10-20 holds such a rejected `tool_result`.

Evidence: full census of 535 on-disk transcripts, 2026-08-10 (CC 2.1.220–227), plus
controlled experiment E2; lazy write verified live 2026-08-24. The five mid-conversation
move entries: full sweep of all 965 on-disk transcripts plus live probes, 2026-09-10, CC
2.1.267. Koloft dependents: `sessionAggregate.extractJsonlMeta`; the
`sessions:transcriptExists` probe (the ⇧⌘R transcript gate,
`restart-transcript-gate.spec.ts`); `sessionTracker.followRelocation` and the
`session-follows-worktree.spec.ts` flow.

## §3 Native resume behavior

- **Resume by explicit id is a global lookup, across projects**: `claude --resume <id>`
  from an unrelated directory successfully continues a session living elsewhere, same
  id, no fork (E3). Rechecked 2026-10-08, CC 2.1.294, `claude -p` through Koloft's shim:
  a session started in folder A, resumed with `--resume <id>` from folder B, kept its id
  and said back a word only folder A's turn held. Rechecked 2026-10-28 on CC 2.1.311 and
  2.1.312 (interactive pty, haiku, 3 runs each: start, resume, resume again, one prompt
  each): the id stayed the same, all three replies were in the transcript on the
  leaf's `parentUuid` chain, and the first `user` record after a resume hung off the
  last turn's `system/turn_duration`; the same 16 record types on both builds. The
  2.1.312 changelog's "first reply after resuming … could be missing" case did not
  happen on 2.1.311 in those runs.
- **A resume can ask "Resume this conversation?", but not in a tab Koloft starts.** The
  2.1.304 changelog's new warning is in the 2.1.303 binary too, with the same text
  (`strings`, 2026-10-20): `This conversation has been inactive for <t> and is <N> tokens
  long. Resuming it will use about <P>% of your 5-hour usage limit.`, options `Resume`
  (focused) and `Start a new conversation` (which runs `/clear`; focused instead under the
  server flag `tengu_stateful_mitten`). It is read on `--resume`/`--continue` with no
  first prompt and on `/resume`, when the prompt cache is cold or the model changed, and
  needs both the server config `tengu_amber_tally` and a known rate-limit tier; 2.1.304
  adds a skip while the account is already past its limit. A Max account got
  `tengu_amber_tally` on 2026-10-20 with `minPercent` 5 and five-hour credits for
  `default_claude_max_5x` and `default_claude_max_20x` only. With `CLAUDE_CODE_OAUTH_TOKEN`
  in the env the tier comes only from `CLAUDE_CODE_RATE_LIMIT_TIER` and the server's tier
  is skipped, so with Koloft's shim (which exports the token and no tier) the tier is null
  and the dialog cannot show: measured 2026-10-20 on 2.1.304, a 3-hour-old 150k-token
  session resumed interactively with `--resume <id>` showed none. The dialog was never
  seen live, even with the tier variable set, so its screen, what Enter does and whether
  `-p` skips it are read, not run.
- **`--resume <id> -w <name>` compose**: CC creates (or enters) the named worktree and
  resumes there with full history (E4); an existing name is entered and used as-is.
- **Resume with a binding, worktree present** → CC re-enters it; **worktree missing** →
  resumes in the current directory without isolation and clears the binding; **belongs
  to another repo** → refused; poisoned → refused. **There is no auto-rebuild path**
  (CC 2.1.227 binary evidence).
- **Re-entering never loses work** (CC 2.1.285, 2026-09-30). The one `reset --hard` on
  this path (the binary's "fast-resume reset", logged as `reset resumed worktree … its
  previous work was fully upstream`) runs only when ALL hold: the checkout is still on
  `worktree-<name>`, `status` is empty, no commit is missing from upstream, and
  `origin/<default>` exists and differs from HEAD. It then moves the worktree to
  `origin/<default>`, not to the recorded baseline, so what it drops is already upstream.
  Live runs in a throwaway repo, each session killed with SIGHUP the way a Koloft quit
  ends it, then resumed:
  - on another branch with one commit and uncommitted edits, `--resume` from inside the
    worktree and from the repo root: branch, commit and edits all kept;
  - a same-named NEW worktree with a tracked edit and a new file, `--resume` from both
    places: kept (that repo had no `origin`, so the reset path could not run);
  - with an `origin`, `-w <name>` into a clean CC-made worktree on its own branch whose
    work was all upstream: reset fired and fast-forwarded it; the same after switching
    to another branch: not reset; back on `worktree-<name>` with one unpushed commit:
    not reset.
  A plain `--resume` (no `-w`) reaching the reset was never seen live: in these runs it
  fired only on the `-w` entry. The older E8 run agrees: a dirty same-branch worktree
  re-enters silently and its files survive.
- **A same-named old-vs-new worktree cannot be told apart from disk**: the branch name
  is derived from the worktree name (`worktree-<name>`), so a reused name reuses the
  branch, and the disk carries no ownership trace.

- **`-w <name>` creation semantics** (CC 2.1.226, temp-repo runs 2026-08-08):
  creates `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>` and
  `git worktree lock`s it immediately; CC locks every worktree it runs in
  (`git worktree remove` needs an unlock first — the user's/CC's business). Same
  name again = silent reuse, exit 0. **Reuse recognizes ONLY the
  `.claude/worktrees/` namespace**: handing `-w` the name of a worktree living at
  any other path mis-creates a same-named NEW worktree — so "open an existing
  worktree" must cd into its checkout and run bare `claude`, never `-w`. A bare
  `-w` with no name invents a random three-word name.
- **`-w` copies the files `.worktreeinclude` names into a NEW worktree; nothing else
  does.** The file sits at the repo root and holds `.gitignore`-style patterns (blank
  lines and `#` lines skipped); a file is copied only when it matches a pattern AND git
  ignores it (`git ls-files --others --ignored --exclude-standard`). A symbolic link is
  skipped ("Skipping symlink in .worktreeinclude"). Read 2026-10-08 from the claude
  2.1.294 binary (`strings`, the function that reads `.worktreeinclude`). That an
  existing worktree entered with `-w` is reused as-is, so a worktree rebuilt by someone
  else's `git worktree add` gets no copy, comes from the #5 probe on 2.1.287 (binary
  strings + docs). The Linux build copies too, so a `-w` Koloft runs on another machine
  needs no copy from Koloft: 2026-10-27, claude 2.1.311 linux-arm64 in a Docker
  container with no network and no login, `claude -p -w viap hi` in a repo whose
  `.worktreeinclude` lists the ignored `.env` made `.claude/worktrees/viap` with that
  `.env` in it, then printed "Not logged in". The interactive `claude -w viatui`, with
  onboarding marked done, the folder trusted and a dummy `ANTHROPIC_API_KEY`, did the
  same: `.claude/worktrees/viatui/.env` was there while its screen still asked "Do you
  want to use this API key?". Without those three it made no worktree in 20 s (its
  screen was not read).
- **A `WorktreeCreate` hook is not a setup step: it REPLACES `git worktree add`.** It is
  meant for other version-control systems; the hook must make the folder and print its
  path, and with the hook set the `.worktreeinclude` copy does not run. Setup work in a
  new worktree belongs in a `SessionStart` hook. Probed for #5 on claude 2.1.287 (binary
  strings + docs). The 2.1.294 strings agree that the hook makes the worktree
  ("configure WorktreeCreate and WorktreeRemove hooks in settings.json for another
  version-control system"; "Provides the absolute path to the created worktree
  directory"); that the copy is then off was not re-read there. Since 2.1.301 the quit
  prompt of such a worktree says "A WorktreeCreate hook made this worktree, so Claude
  Code can't tell whether it has unpushed commits" and asks before removing it (the
  changelog's fix; `strings`, 2026-10-16, not run — Koloft's `-w` worktrees are made by
  CC itself, so the §4 exit facts above are the ones that apply). 2.1.302 adds, for the
  changelog's "worktree isolation refusing to create or resume worktrees under git 2.56
  or later when a stray `.git` file points at a directory that doesn't exist": the error
  `gitfile does not point to a valid repository` is now read as "not a repository", and
  its git calls carry `-c init.defaultRefFormat=files` with `GIT_DEFAULT_REF_FORMAT=files`
  (`strings`, 2026-10-17; pointers, not run).
- **A `-w` session's Bash tool has an isolation guard that refuses a command it cannot
  prove stays inside the worktree**, awk programs included: it already refused
  `system(`, a `| "cmd"`, `| getline`, `@load`/`@include` and `/inet/`; 2.1.299 also
  refuses a `|` after `print`/`printf` or before `getline` anywhere in the program, a
  regex or string included ("runs … inside a construct too complex to verify, so what it
  runs cannot be shown not to be git"), behind `tengu_rustling_lighthouse`, on by
  default (read from the 2.1.296 and 2.1.299 binaries, `strings`, 2026-10-14; not run).
- **The same guard refuses git aimed at the main checkout, but lets `koloft` through; a
  typed `!` command was reported refused too.** In a `-w` session the Bash tool's
  `git -C <main checkout> log -1` came back with `This session is isolated in the worktree
  <worktree>, but this command redirects git to the shared checkout via -C. Refusing to
  run it — a worktree-isolated session's git operations must target its own worktree.
  Run the equivalent from <worktree> without the redirect.`, and the command did not run;
  `koloft session list` from the same tool ran and answered. The message is in the
  binary's strings. Measured 2026-10-25 on CC 2.1.310, macOS, a real Koloft worktree
  session. Not measured, from a person's report on 2026-10-22 (local, the version not
  written down; 2.1.308 or 2.1.309 by the install dates, inferred): a merge into the main
  checkout asked of such a session (`git -C <main> merge …`), and the same command typed
  by the person with `!` in front, were refused the same way ("This session is isolated
  in the worktree …"), and a new session started in the main checkout merged it at once.
  Other forms (`cd <main> && git …`, `--git-dir=`) were not tried; on a remote (SSH)
  machine, inferred, not checked. So Koloft's agent guide sends a worktree session whose
  merge is refused to a new session in the main checkout (`koloft session new` without
  `-w`).
- **CC's Bash tool runs its commands with the env `claude` was started with**, so a
  variable set on the launch reaches the model's shell in a `-w` worktree session:
  `KOLOFT_PORT_OFFSET` set in the pty env on this Mac, and exported by the remote tab
  script right before `exec claude` inside tmux on a Linux machine over ssh. In both, the
  model ran `echo "$KOLOFT_PORT_OFFSET"`, the tool result held the worktree name's
  offset, and the model replied with it. Measured 2026-10-08 with claude 2.1.294 (macOS,
  and Linux in the Docker ssh lab, Debian bookworm's tmux), real model turns; established
  by `agent-tools-real-smoke.spec.ts` › "a real Claude Code in a worktree session echoes,
  with its Bash tool, the port offset of that worktree’s name" and
  `remote-ssh-lab.spec.ts` › "E-SSH-11: a REAL claude on the machine, in a worktree
  session made there through ssh and tmux, echoes with its Bash tool the port offset of
  that worktree’s name (opt-in, spends real money)". Both passed again on 2.1.296
  (2026-10-11), 2.1.299 (2026-10-14), 2.1.300 (2026-10-15), 2.1.301 (2026-10-16),
  2.1.302 (2026-10-17), 2.1.303 (2026-10-19) and 2.1.304 (2026-10-20), as did E-SSH-15
  (`koloft help` and `koloft note append` from the Bash tool on the machine) and
  E-SSH-C2 (a conductor's typed message answered, its question answered by `koloft
  session answer`). E-SSH-11 and E-SSH-15 passed again on 2.1.306 (2026-10-21) and on
  2.1.308 (2026-10-22).
- **CC's background retention sweep leaves hand-made worktrees under
  `.claude/worktrees/` alone from 2.1.246 on** (changelog, read 2026-09-18, not
  measured). Before that it could remove them.
- **`-w <name>` re-enters a `.claude/worktrees/<name>` that someone else made on another
  branch, but writes down the wrong branch, and a clean `/exit` removes the folder.**
  Koloft-style setup: `git worktree add .claude/worktrees/pr-329 fix/pr-branch`, then
  `claude -w pr-329` from the repo root. The session started in that folder (the
  SessionStart hook's `cwd`), the checkout stayed on `fix/pr-branch`, no
  `worktree-pr-329` branch was made, and the tree was locked. But `~/.claude.json`'s
  `activeWorktreeSession` and the transcript's `worktree-state` both say
  `"worktreeBranch":"worktree-pr-329"` (with `"resumedExisting":true`). A first message
  after `--` still arrived as the first turn. `/exit` with no changes printed "Worktree
  removed (no changes)": the folder and its registration were gone, `fix/pr-branch` was
  kept. On 2.1.304 the folder still goes without a question, and the line reads
  `Worktree removed. Branch fix/pr-branch is kept.` (2026-10-20, the same recipe on
  2.1.303 and 2.1.304 side by side). So a worktree on a branch of its own name (a pull request's branch) is opened by
  starting bare `claude` inside it, never with `-w`, as for any existing worktree.
  Measured 2026-10-09, claude 2.1.295 (the real binary, not the shim), a throwaway
  one-commit repo with no `origin`, a scratch `HOME` whose `~/.claude.json` trusted the
  repo, no login (the worktree step runs before any model call), driven in a python pty
  with a `--settings` SessionStart hook, then `git worktree list` and `git branch`.
- **A new `-w` worktree starts from `origin/<default>`, else from local HEAD.** When
  `refs/remotes/origin/<default>` exists CC uses it, first fetching when `FETCH_HEAD` is
  more than 24 hours old (a 5 s timeout); otherwise it fetches `origin <default>`, and if
  that fails it logs `[worktree] fetch of origin/<b> failed — basing worktree on local
  HEAD` and uses HEAD. 2.1.306 (the 2.1.305 changelog's bare-repository fix) also finds
  the git dir of a bare repository, resolves the base as the exact ref
  `refs/remotes/origin/<default>` and hands `git worktree add` a `<sha>^{commit}` rather
  than a ref name; for a normal checkout the start point is the same as on 2.1.304. Read
  from the strings of 2.1.304 and 2.1.306, 2026-10-21, not run.
- **A worktree name whose folder is gone but whose branch is left is not refused once git
  has forgotten the folder: `-w` makes the folder again and resets the branch to the
  start point, so the branch's own commits drop off it.** With `.claude/worktrees/<n>`
  deleted, `git worktree prune` run and `worktree-<n>` kept, `claude -w <n>` started the
  session in a new `.claude/worktrees/<n>` (the SessionStart hook's `cwd`), locked it, and
  left `worktree-<n>` at the start point: local HEAD in a repo with no `origin`, and
  `origin/main` (a commit local HEAD did not have) in a repo whose `origin` was ahead.
  When the branch held a commit of its own, its reflog then read
  `branch: Reset to <sha>^{commit}` and the commit was reachable from no branch
  (`git fsck --lost-found` listed it as dangling); nothing on the screen said so. When the
  branch had no commit of its own, the result looked the same as a fresh `-w <n>`.
  **While git still lists the deleted folder (no prune), `-w <n>` refuses and exits 1**,
  printing `Error creating worktree: branch "worktree-<n>" for worktree "<n>" is already
  checked out elsewhere in this repository. Pass a different --worktree name.`; the branch
  and its commit stay. Measured 2026-10-26, claude 2.1.310 (the real binary, not the
  shim), a throwaway one-commit repo (with and without a bare `origin`), a scratch `HOME`
  whose `~/.claude.json` trusted the repo, no login, driven in a python pty with a
  `--settings` SessionStart hook, then `git worktree list`, `git branch -v`, `git reflog`
  and `git fsck`.

Evidence: experiments E3/E4/E8, 2026-08-10, plus `strings` analysis of the claude
2.1.227 binary. Koloft dependents: the resume decision tree in `src/main/resumePlan.ts`
(behind `sessions:resumePlan`); `claudeArgv` in `src/main/claudeArgs.ts`, which composes
`--resume`/`-w`; `copyWorktreeIncludes` in `src/main/sessionWorktrees.ts`, which copies
the same files into a worktree Koloft makes or rebuilds itself; `worktreeNameFor` and
`CronRunner.taken` in `src/main/cronRunner.ts`, which count a left `worktree-<n>` branch
as a taken name so a scheduled run never hands `-w` such a name.

## §4 Worktree session exit

- **`/exit` from an UNCHANGED worktree removes it silently — no Keep/Remove page**: dir
  and branch gone, transcript moved to the root slug (with messages) or never written
  (none). Measured 2026-09-08 on 2.1.265, Linux, over Koloft's remote path; that macOS
  behaves the same on 2.1.265 and later is inferred, not checked.
- **`/exit` from a DIRTY worktree asks.** The screen is titled "Exiting worktree
  session", its second line reads `You have N uncommitted files. These will be lost if
  you remove the worktree.`, and the options are `1. Keep worktree — Stays at <path>`
  and `2. Remove worktree — All changes and commits will be lost.` **Keep is option 1
  and pre-selected**, so a run nobody answers keeps its worktree. Choosing Remove
  deletes the directory, the git registration and the branch `worktree-<name>` — dirty
  files included. (Measured 2026-09-03 on 2.1.259.) A `--tmux` session adds "Keep
  worktree and tmux session" / "Keep worktree, end tmux session" (binary strings, CC
  2.1.263, 2026-09-06).
- **Since 2.1.304 a clean `/exit` also asks when commits would be lost off the
  worktree's own branch.** With one commit on `worktree-<n>` and then `git switch -c
  other main`, 2.1.304 asks (`You have 1 commit on worktree-x that branch other doesn't
  have. Branch worktree-x will be deleted if you remove the worktree. The worktree is now
  on branch other, which is kept either way.`; Remove: `Commits only on worktree-x will be
  lost.`); after `git checkout --detach main` it asks with `You have 1 commit on
  worktree-x or at the detached HEAD. It may be lost if you remove the worktree.` 2.1.303
  removed both silently with "Worktree removed (no changes)" and the commit went with the
  branch. Keep is still option 1 and pre-selected; Enter prints `Keeping worktree…` and
  exits 0. A clean tree on another branch with nothing at stake is still removed without
  a question, now with `Worktree removed. Branch <b> is kept.` (the branch it was on
  stays, `worktree-<n>` goes); a detached one prints "Worktree removed (no changes)" as
  before. After a chosen Remove the lines are `Worktree removed. 1 commit on worktree-x
  was discarded.`, `Worktree removed. 1 commit was discarded.` or `Worktree removed.`.
  One more success line exists in both builds: `Worktree and branch worktree-<n>
  removed.`, printed when the session's `worktree-state` has no `originalHeadCommit`;
  it was produced only by deleting that field from a transcript by hand and resuming
  with a bare `--resume <id>` (`-w` always reads HEAD again), so whether a real
  transcript lacks it is inferred, not checked. Measured 2026-10-20 on 2.1.303 and
  2.1.304 side by side: a throwaway one-commit repo with no `origin`, a scratch `HOME`,
  no login, a python pty, then `git worktree list` and `git branch`.
- **Exit means exit — there is no "respawn in place"**: whichever choice is taken, the
  process simply exits with reason=`prompt_input_exit` (E2/E8; re-verified 2026-09-03 on
  2.1.259 for Keep, Remove and dirty-Remove).
- **A clean exit UNLOCKS the worktree.** CC locks every worktree it runs in (§3), but
  after a Keep or a Remove the lock is gone, so a later `git worktree remove` needs no
  `unlock` first. A worktree whose session was killed instead stays locked.
- **The transcript SURVIVES either choice — it is moved to the ROOT checkout's slug**
  (the `relocateSessionTranscript` rename of §5): full content, the `custom-title`
  record intact, while the worktree's own slug directory is left behind **empty**. A
  killed (never exited) session's transcript stays in the worktree slug.
- SIGHUP is the opposite of an exit: worktree directory kept (still locked), branch
  kept, transcript left in the worktree slug, SessionEnd reason=`other`, exit code 129
  (2026-09-03, 2.1.259 — confirms §1).
- **After a session LEAVES a worktree, read where it landed from the `relocated` record
  (§2), not from later `cwd` fields.** 195/195 on-disk sessions whose last
  `worktree-state` was `null` (2026-09-10, CC 2.1.267) had not one record with a `cwd`
  past that emptying `worktree-state`. A re-scan on 2026-09-26 (324 transcripts, 66 with a
  `null` `worktree-state`) found none that entered a worktree again, but 4 of them, on CC
  2.1.281–2.1.283, do carry records with a `cwd` (the root checkout) after the `null` —
  all four are sessions that left through the ExitWorktree tool and kept talking, so
  "no directory ever again" no longer holds. A session that leaves
  and then enters a worktree again mid-conversation (§2) is outside both sets.

- **Removing happens before the exit, in the open, and can take seconds.** After a Remove
  (or a silent clean removal) CC leaves its screen, writes `ESC ] 0 ; BEL` (an empty
  window title), then the line `Removing worktree…` (U+2026), deletes the folder, deletes
  the branch `worktree-<name>`, prints one result line, runs the SessionEnd hooks and
  only then exits. The line follows the title at once only while the session has no
  message; once it has one, the two dim lines `Resume this session with:` and `claude
  --resume <id>` (§1) come between them, and nothing else does: 119 bytes with a session
  id and their colour codes, on both builds. The TUI's own
  `⏳ Removing worktree…` is drawn before the empty title. (Measured 2026-10-20 on CC
  2.1.303 and 2.1.304: a `-w` session with one turn, in fullscreen and with
  `CLAUDE_CODE_NO_FLICKER=0`, a python pty, the raw bytes saved.) Success lines start with `Worktree removed`
  (`Worktree removed (no changes)`, `Worktree removed.`, `Worktree removed. Uncommitted
  changes were discarded.`); the others name the trouble (`Could not finish removing the
  worktree at …`, `Removing the worktree at … did not finish within …`, `Stopped waiting
  for the removal of the worktree at …`, `Worktree could not be removed — kept at …`).
  CC waits at most 10 minutes. Time grows with the files in the folder: 27k files (a
  Koloft worktree with `node_modules`) took 3.5 s from `/exit` to exit, 2.6 s of it the
  delete, under the owner's own settings (fullscreen, Koloft's hooks and plugin);
  250k files took 9.5 s. The same title-then-line bytes came in normal and fullscreen
  mode. Through Koloft's remote tmux (3.3a) the title code is not passed on, and the
  line arrives as a redrawn screen row (`ESC[H` … `ESC[K`), like any other.
- **The folder goes first, the branch 60–140 ms later, and the process exits last.**
  Measured 2026-10-11 on CC 2.1.293 and 2.1.296 (two runs each; a `-w` session in a
  throwaway one-commit repo driven in a python pty, no login, `/exit` with no turn and
  3,000 ignored files in the worktree, polled every 50 ms from the Enter): the folder
  was gone at 0.52–0.58 s, `worktree-<name>` at 0.63–0.66 s, the process at
  0.78–1.14 s (exit 0, "Worktree removed (no changes)"), same order and timing on both.
  So a check that reads the branch the moment the folder is gone can still see it; the
  real-binary e2e case polls the branch until it goes.
- **A SIGHUP during the delete cuts it off half way.** CC stops waiting and exits; the
  folder keeps what was not deleted yet (213,696 of 250,000 files), the worktree stays
  in `git worktree list` and its branch stays. `git worktree remove --force --force`
  and `git branch -D worktree-<name>` finish the job.
- Measured 2026-10-09 on CC 2.1.295 (strings and code of the binary, a pty-driven `-w`
  session in a throwaway repo, `--debug-file` timings, the raw pty bytes); the tmux row
  in the e2e SSH lab image. Rechecked 2026-10-21 on CC 2.1.306 beside 2.1.304 (python
  pty 120×40, a scratch `HOME`, Koloft's hook shape in `--settings`, `--model haiku`;
  four `-w` sessions with one turn and an untracked file, `/exit` then `2`, and four
  clean ones with no turn): the bytes from the empty title to the result line are the
  same on both builds apart from the session id — with no message nothing comes between
  the title and `Removing worktree…`, with one the two dim resume-hint lines of §1 do
  (119 bytes) — and the same in default and fullscreen mode; the worktree and its branch
  were gone afterwards. The key `2` alone picks Remove, with no Enter.
- Rechecked 2026-10-23 on CC 2.1.309 beside 2.1.308 (`strings`, darwin-arm64 and
  linux-arm64, not run): the code that removes a worktree at exit is the same once
  minified names are evened out, and every exit line above is unchanged. 2.1.309
  changes the creating side: CC's git children get `LC_ALL=C` and `LANGUAGE=C` unless a
  call asks for the user's locale, so a git error inside one of the failure lines is
  now English; and `-w` creation and reuse run with `GIT_NO_LAZY_FETCH=1` after a
  partial clone's missing objects are fetched ahead (inferred from the code). Koloft
  matches only the start and `Worktree removed` lines, so neither change reaches it.

Evidence: experiments E2/E8, 2026-08-10, claude 2.1.227; four live worktree exits on
2026-09-03, claude 2.1.259 (`-w n5/n6/n7/n8/n9` in a throwaway repo, driven in a pty,
checked with `git worktree list`, `git branch` and `ls ~/.claude/projects/<slug>`); the
unchanged-tree removal on 2026-09-08, claude 2.1.265.
Koloft dependents: the §1 whitelist eviction path; `fake-claude.js`'s dirty-tree exit
prompt and removal emulation; `src/main/claudeWorktreeExit.ts`, which hides a local tab
the moment its CC starts removing and finishes the removal if Koloft quits first.

## §5 fork and background sessions (claude daemon)

- **`/fork` = "Copy this conversation into a new background session and keep working
  here"** (official description, CC 2.1.238): a brand-new session id plus a full
  transcript copy (3.0 MB measured); the title inherits the parent's plus a `⑂`
  suffix. **Hosted by CC's resident process (claude daemon), it does NOT die with the
  window** (measured alive nearly two days, waiting for an answer).
- **The copy inherits the parent tab's hook settings**, so every report it sends claims
  the parent tab's identity; its SessionStart carries `source=fork` (2026-08-20; again
  on the `/background` move below, and 3 of 3 `/fork` runs on 2.1.311); **its self-stop fires SessionEnd reason=`prompt_input_exit`**
  (the job_stop_self path, read from CC source) — the same reason a person's `/exit`
  gives.

- **State & enumeration**: `~/.claude/jobs/<short-id>/state.json` + `timeline.jsonl`
  (carrying `forkParentSessionId`, `needs`, `state`, tokens). **state.json's `state`
  is a frozen snapshot — file content ≠ process liveness, and a non-growing transcript
  ≠ an exited session**. The only reliable liveness sources are
  `claude agents --json` (official scripting interface; supports `--cwd` filtering and
  `--all` — `claude agents --help`, 2.1.281, 2026-09-24) plus `ps -p <pid>`. ⚠️
  Measured: `claude agents --json` stdout is polluted by statusline output ahead of the
  JSON — parse from the first `[`. On 2026-09-24 (CC 2.1.281) `~/.claude/jobs/` did not
  exist on the dev Mac; where 2.1.281 keeps this state is not measured. On 2.1.311 a
  `/fork` makes `~/.claude/jobs/<jobId>/` again, and `timeline.jsonl` only appears after
  the copy's first turn (next block but one).
- **One-step attach exists: `claude attach <id>`** (added in 2.1.251 per the changelog,
  alongside `logs / stop / respawn / rm` in `claude --help`). Measured on this Mac,
  2026-09-18, CC 2.1.276, and unchanged on 2.1.281 (2026-09-24) — `claude attach --help`
  prints: `Usage: claude attach <id> /
  Open the background session in this terminal. ← returns to agent view, Ctrl+Z drops
  back to your shell. The session keeps running either way.` The changelog also says a
  direct `--resume` of a running background session is refused with a message naming
  `claude attach <id>` (the version it names is not recorded here; never measured); on
  2.1.311 it is not refused but turned into an attach (next block). `claude --resume <id> --fork-session` still makes ANOTHER copy, it is not a
  takeover.
- **What a `/fork` copy looks like from outside** (2026-10-27, CC 2.1.311, 3 runs:
  a throwaway `HOME`, a local fake Messages API behind `ANTHROPIC_BASE_URL` and a
  fake key from `apiKeyHelper`, the interactive TUI driven in a python pty, a logging
  hook on SessionStart / UserPromptSubmit / Stop / SessionEnd in user settings):
  - Typing `/fork` after one finished turn prints `session waiting for a prompt ·
    <first 8 hex of the new id>`; the window keeps the original session.
  - The copy gets its own registry file at once: `kind: "bg"`, plus a `jobId` (those
    same 8 hex), its own `pid`, `procStart` and `messagingSocketPath`; `name` starts as
    the first prompt's text. The window's entry stays `kind: "interactive"`.
  - `~/.claude/jobs/<jobId>/` appears with `state.json`, `parent-transcript.jsonl` and
    `tmp/` (`timeline.jsonl` only after the copy's first turn); its transcript is a
    normal `~/.claude/projects/<cwd slug>/<new id>.jsonl`.
  - Its SessionStart carries `source: "fork"` with the new id and the extra keys
    `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`,
    `estimated_cache_write_usd` (3 of 3 runs).
  - `claude agents --json` (no TTY, exit 0, ~1 s) lists **both** the window's session
    and the copy. Keys: `pid, cwd, kind, startedAt, sessionId, name, status`, and on
    the copy also `id` (= `jobId`) and `state`. `kind` is `"interactive"` for the
    window and `"background"` for the copy; the copy's `state` read `blocked` while it
    waited for its first prompt and `working` after a turn had finished, with `status:
    "idle"` both times — so `state` did not follow the finished turn, and `status` is
    the busy / idle reading. `--cwd <dir>` and `--all` gave the same two rows here (nothing
    had finished). No statusline was configured, so no text came before the `[`.
  - `claude attach <jobId>` in a second pty shows the copy's conversation full screen;
    a prompt typed there runs in the copy (its hooks fire under the copy's id, its
    registry `name` follows). No new registry file appears for the attach. Closing that
    pty (SIGHUP) leaves the copy running and listed.
  - **`claude --resume <copy's full id>` while the copy runs becomes the attach**: the
    process's command line reads `claude attach <jobId>` within 12 s, no second
    registry entry appears, and a prompt typed there runs in the copy.
  - The copy is hosted by a transient daemon (`daemon.log`: `origin=transient`, `bg
    claimed-spare <jobId> (slash)`), whose control socket is
    `/tmp/cc-daemon-<uid>/<hash>/control.sock`, one per `HOME`. `claude daemon stop
    --any` ended it and the copy (`bg settled <jobId> (killed)`).
- **A fork's transcript repeats the parent's usage lines word for word** (2026-10-24,
  CC 2.1.310, `claude -p --resume <id> --fork-session` on a two-request session): the
  new file starts with every parent line, same `uuid`, `timestamp`, `message.id`,
  `requestId` and `usage`, only `sessionId` rewritten to the new id; then its own lines.
  Its `total_cost_usd` (0.022033) is the parent's (0.0201139) plus its own one request,
  so the copied history counts toward CC's own figure too; a plain `--resume` of the
  parent reports its history in `total_cost_usd` the same way (`cost-state` line). Even
  `promptId` is rewritten, so only the copy's `message.id` + `requestId` tie it to the
  original in the other file. Which file is the parent: on `-p --fork-session` and the
  TUI `/fork` (2026-10-24, CC 2.1.310, typed in a pty in a throwaway home; it starts
  `claude daemon run`, writes the copy to a new transcript and the window keeps the
  original), the fork's first line with a top-level `timestamp` is a `queue-operation`
  at fork time, later than the parent's first. A `/background` move does not do that:
  a `sessionKind: "bg"` transcript on the dev Mac (CC 2.1.283) opens with the copied
  lines at their original times, so both files start at the same moment. On this
  Mac's 4,914 transcripts (2026-10-24, ids hashed, no content read), 230 of 147,698
  calls sit in two files: that bg move and sub-agent files sharing calls. Rechecked
  with a parent, its fork and the parent resumed after: the three runs' own requests
  cost $0.031692, and Koloft's Usage rows add up to that.
- **Interactive sessions have NO re-entry guard**: resuming an already-running normal
  session is not blocked — the same session can be written by two processes at once
  (measured loss, 2026-08-20). The "already running … split-brain" refusal belongs to
  claude remote-control, not to resume. This is about a session open in a window; a
  running background copy is attached instead on 2.1.311 (above). Resuming a session
  that is open in another window was not measured again on 2.1.311.
- **On a cwd change CC relocates the transcript wholesale**:
  `relocateSessionTranscript` → `fs.rename` (with `{replace:true}` in newer storage);
  the old file keeps a `relocated` record (§2). On 2.1.238 **an existing target was
  silently overwritten** (~1700 records lost, 2026-08-20); the 2.1.251 changelog says
  fixed ("session transcripts being silently overwritten when a directory change
  relocated a session onto an existing same-ID transcript"; not measured).

- **`/background` ("Send this session to the background and free the terminal") moves
  the conversation out of the window** (measured 2026-09-26, CC 2.1.283, one
  interactive haiku session in a pty with a logging hook on every event):
  - The window's claude fires SessionEnd `reason=prompt_input_exit` and exits.
  - A process claude daemon started in advance (`claude bg-spare --bg-spare
    <…/spare/<id>.claim.sock>`, living under a `bg-pty-host`) takes the job. It fires
    SessionStart `source=fork` under a new `session_id`, with the window's hook
    settings.
  - The daemon keeps one such spare ready, and starts another when one is used.
- **A conversation can also move to a new id while the window's claude stays up**
  (seen once, live, 2026-09-26, CC 2.1.283, in a Koloft worktree tab, around the
  moment `/goal` was set; the trigger is not probed yet):
  - The old transcript's last record is `{"type":"continued-in",
    "continuedInSessionId":<new>}`.
  - The conversation goes on in a daemon-hosted process: `--session-id <new>
    --fork-session --resume <old transcript> --settings <the tab's file>`, registered in
    `~/.claude/sessions/` with `kind: "bg"`.
  - The window's claude stays alive and `interactive`, still registered under the old
    id.
  - The tab's hooks got a SessionStart `source=startup` carrying a third
    `session_id`, which never wrote a transcript, at the same second. Every later
    Stop / UserPromptSubmit carried the new id.
- **Fork subagents (`subagent_type: "fork"`) in a `-p` run: off on 2.1.301, gated since
  2.1.302.** `strings`, 2026-10-17, not run: 2.1.301 returns `"disabled"` for every
  non-interactive run; 2.1.302 does so only when `CLAUDE_CODE_FORK_SUBAGENT` is not set
  to true and the server flag `tengu_federated_ullman` is on (default off) — the
  changelog's "fork subagents … on by default in `claude -p`". Koloft's `-p` calls pass
  `--tools ''`, so no Agent tool exists there to fork.

Evidence: on-machine diagnosis 2026-08-22 (CC 2.1.238) and CC source reading; the two
background-move bullets and the `/fork` copy probe (2026-10-27, CC 2.1.311) as dated
above. Koloft dependents: the fork gate and session_id
extraction in `src/main/hooks.ts`'s injected script (marked `CC§5`);
`src/main/hookRouting.ts`, where a tab follows `continued-in` or leaves a start that
never wrote a transcript.

## §6 Settings precedence & the statusLine protocol

- **`--settings <file>` sits at the CLI-args tier and out-ranks user / project / local
  settings, merging per key** — source order `userSettings < projectSettings <
  localSettings < flagSettings` (verified in the installed 2.1.224 binary, confirmed by
  the CLI reference, 2026-08-07). The one tier above it: **managed (enterprise)
  settings out-rank `--settings`**.
- **Hooks from `--settings` are ADDED to the user's own hooks for the same event**, not
  swapped in: "merging per key" above does not say that hook arrays are joined. The
  user's own hooks (for example a Stop hook that writes `<id>.title`) keep running next
  to the `--settings` ones. (Inferred, not checked.)
- **The `statusLine.command` string is shell-interpreted by CC** (paths need quoting),
  and **CC ≥2.1.153 exports `COLUMNS` before running it**. CC pipes its status JSON to
  the command's stdin and **treats stdout-pipe EOF as "render done"** — any orphaned
  process holding the pipe's write end delays the visible render for its full lifetime
  (measured: 10.06 s → 0.83 s cold / 0.18 s warm once no orphan held the pipe).
- statusLine (like hooks) only runs after the workspace trust dialog is accepted, and
  `disableAllHooks: true` turns off both statusLine and hooks.
- CC also supports `subagentStatusLine` (the key is in the 2.1.281 binary, `strings`,
  2026-09-24).
- **An `env` entry in `--settings` beats the same entry in `~/.claude/settings.json`, and
  an empty string turns agent teams off.** 2026-10-11, CC 2.1.296, two interactive
  sessions in a pty, model haiku, with the user settings holding
  `"env": {"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "true"}`; each was asked to call the
  Agent tool once with a `name`. Without a `--settings` file the Agent ack read
  `status: "teammate_spawned"`; with `--settings '{"env":
  {"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": ""}}'` it read `status: "async_launched"`,
  `isAsync: true` — an ordinary background subagent. The binary's teams gate is a
  plain truthiness test (`if(!a.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS&&!t())return!1`, read
  with `strings`; the same test in 2.1.309, minified names aside, 2026-10-23), so `"0"`
  would leave teams on; only `""` was run.
- **The status JSON carries `effort: { level }`** (the session's thinking effort:
  low / medium / high / xhigh / max; Ultracode reports as xhigh). Read from the
  status-object builder in the installed 2.1.263 binary via `strings`, 2026-09-06.
- **The status JSON also carries `rate_limits` and `prompt_cache`** (read from the
  statusLine JSON doc block in the 2.1.276 binary with `strings`, 2026-09-18; not yet
  seen live): `rate_limits: { five_hour | seven_day | spend_limit: { used_percentage,
  resets_at } }` and `prompt_cache: { warm, caching_observed, ttl: '5m' | '1h',
  expires_at, requests, misses, expected_rebuilds, hit_ratio, cache_write_tokens,
  miss_recache_tokens, last_miss_at, last_miss_cause: { causes: [] } }`.

Evidence: binary reading, the CLI reference and two local experiments, 2026-08-07, CC
2.1.224; render latency measured in live testing (date and CC version not recorded).
Koloft dependents: `src/main/statusline.ts` (its wrapper script is marked `CC§6`; the
ccstatusline side is platform ledger §36), `writeTabHookSettings` in
`src/main/hooks.ts`, `test/e2e/statusline.spec.ts`.

## §7 Anthropic API: usage headers, auth env, model fallback

- **Probe contract**: a `max_tokens: 1` POST to `/v1/messages` returns
  `anthropic-ratelimit-unified-*` response headers carrying the server's exact
  per-bucket usage: `anthropic-ratelimit-unified-<bucket>-utilization`, `-status` and
  `-reset` for the buckets `5h`, `7d` and `7d_oi` (fable), plus a bucket-less
  `anthropic-ratelimit-unified-overage-status` — all from the same header group, no
  extra request. **The Claude Code system prompt is REQUIRED for an OAuth token to be
  accepted at all**; its text is `You are Claude Code, Anthropic's official CLI for
  Claude.` (present in the 2.1.281 binary, `strings`, 2026-09-24). Only per-bucket
  status is trustworthy: the top-level
  unified-status follows the 7d_oi bucket under a fable probe and would misreport a
  fable-full account as fully unavailable.
- **Header edge behavior** (real curl runs, 2026-08-17): non-2xx responses
  carry NO unified headers ⇒ parse headers before looking at the status code;
  zero-utilization buckets still return status headers (the group is atomic — no
  "utilization present, status missing"); **utilization can exceed 1** (overage);
  no header field reveals plan/quota size — only percentages, so any cross-account
  aggregation can only weight accounts equally. Other headers seen live:
  `overage-disabled-reason`, `representative-claim`, and one logged
  as `fallback-percentage` on 2026-08-17 — the CC 2.1.263 binary knows only
  `anthropic-ratelimit-unified-fallback`, so that name is unconfirmed until the next
  live curl. The same binary also names header families this ledger has never seen
  live (`grace-*`, `slow-*`, `overage-period-*`, `upgrade-paths`; strings read
  2026-09-06) — recorded here as a pointer, not as a contract. The 2.1.276 binary also
  reads plan usage from `/api/oauth/usage` (fields seen in `strings`, 2026-09-18:
  `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`,
  `seven_day_overage_included`, each with `utilization` and `resets_at`); the live
  response shape is unmeasured — a pointer only.
- **fable capability detection**: only fable-model probes return the 7d_oi bucket;
  an account without fable answers a fable probe with 400, 403 or 404, while 408 and a
  headerless 429 are passing failures that say nothing about fable (inferred, not
  checked). A claude-fable-5 probe takes 4.0–5.1 s
  (n=8, three accounts; network floor 80–180 ms — the model itself is the cost);
  a probe consumes ~23 input tokens.
- **Auth env vocabulary**: `CLAUDE_CODE_OAUTH_TOKEN` (subscription OAuth),
  `ANTHROPIC_API_KEY` (x-api-key; API keys have no windowed quota buckets), and
  custom Anthropic-compatible endpoints via `ANTHROPIC_BASE_URL` +
  `ANTHROPIC_AUTH_TOKEN` — where all six model slots (`ANTHROPIC_MODEL`,
  `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`)
  must be pinned to the endpoint's model, or the CLI requests `claude-*` models the
  endpoint cannot serve. The roster grows when CC adds a model tier (FABLE, on CC
  2.1.267, 2026-09-10) or changes a slot's rank: per the changelog (read 2026-09-18, not
  measured), 2.1.251 made `CLAUDE_CODE_SUBAGENT_MODEL` a default that an agent's own
  `model:` beats, and 2.1.257 added `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` — a flag, not
  a model slot — that makes it a hard pin again. The same changelog says 2.1.236 added
  `ANTHROPIC_DEFAULT_MODEL`; what it out-ranks is unmeasured.
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, `ANTHROPIC_DEFAULT_MODEL` and
  `ANTHROPIC_DEFAULT_FABLE_MODEL` are all in the 2.1.281 binary (`strings`, 2026-09-24).
  **2.1.296 added `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`, and the six slots still
  cover a Workflow agent**: read from the 2.1.296 binary (`strings`, 2026-10-11), a
  workflow agent's model falls back explicit `model` → that variable →
  `CLAUDE_CODE_SUBAGENT_MODEL` → the main loop's model, and with
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` set the script's own `model` is dropped
  ("Workflow agent model … ignored") and the new variable counts only when the
  managed-policy tier set it, so one a person exports is ignored. The same binary also
  names `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_AUTO_MODE_MODEL` and
  `CLAUDE_CODE_BG_CLASSIFIER_MODEL` — pointers only; the diff of `*_MODEL` names
  between 2.1.293 and 2.1.296 is the one workflow variable, and between 2.1.296 and
  2.1.299 it is empty (`strings`, 2026-10-14; no `ANTHROPIC_*` name changed either),
  as between 2.1.299 and 2.1.300 (`strings`, 2026-10-15; every `CLAUDE_CODE_*` and
  `ANTHROPIC_*` name Koloft's shim sets is still in the 2.1.300 binary) and between
  2.1.300 and 2.1.301 (`strings`, 2026-10-16: the same 15 `*_MODEL` and 74 `ANTHROPIC_*`
  names, every name `src/` uses still there), and between 2.1.301 and 2.1.302
  (`strings -n 6`, 2026-10-17: the `*_MODEL` and `ANTHROPIC_*` sets are identical on both
  binaries — 14 and 76 with `grep -o -E '[A-Z0-9_]+_MODEL\b'` and `'ANTHROPIC_[A-Z0-9_]+'`,
  the earlier 15/74 came from another pattern — and the `CLAUDE_CODE_*` set gains
  `ALLOW_OTHER_MODELS` (pairs with a hidden `--allow-other-models`),
  `DESKTOP_SKILLS_PLUGIN_DIR` and `MCP_SERVE_WORKSPACE_ROOT`, loses none), and between
  2.1.302 and 2.1.303 (`strings -n 6`, 2026-10-19: the `CLAUDE_CODE_*`, `ANTHROPIC_*`,
  `*_MODEL` and `tengu_*` sets are identical — 778, 76, 14 and 3131 names, none added
  or removed), and between 2.1.303 and 2.1.304 (`strings -n 6`, 2026-10-20: `ANTHROPIC_*`
  and `*_MODEL` identical at 76 and 14; `CLAUDE_CODE_*` gains 11 and loses none, among
  them `WARN_DISK_FREE_GIB`, `WARN_MEMORY_FREE_GIB` and `SKIP_PLUGIN_LOCAL_MCP_SERVERS`,
  none of which `src/` sets; `tengu_*` gains 35 and loses 5), and between 2.1.304 and
  2.1.306 (`strings -n 6`, 2026-10-21: `ANTHROPIC_*` and `*_MODEL` identical at 76 and
  14; `CLAUDE_CODE_*` gains 7 — among them `RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS` (§9)
  and `ENTRYPOINT_ON_REQUESTS` — and loses `SETTLE_TOUCHED_FILES`; `tengu_*` gains 28
  and loses 4; all 15 `CLAUDE_CODE_*`/`ANTHROPIC_*` names `src/` uses are still there),
  and between 2.1.306 and 2.1.308 (`strings -n 6`, 2026-10-22, darwin-arm64 and
  linux-arm64: `ANTHROPIC_*` and `*_MODEL` identical at 76 and 14; `CLAUDE_CODE_*` gains 7
  and loses `ADOPT_UNDERIVABLE_PARKED_PERMISSION`, a `-p` stream-json switch Koloft never
  sets; `tengu_*` gains 35 and loses 4; all 15 names `src/` uses are still there). Among
  the 7, `IGNORE_PERSISTED_TRUST` is set by CC's self-hosted runner at `--trust-workspace
  false`; Koloft does not set it, so the folder trust Koloft writes before each launch
  still counts. The new `launcher-host-login` path (a process an organization's launcher
  started borrows the desktop app's login) acts only with
  `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` and `CLAUDE_CODE_HOST_AUTH_ENV_VAR` set, which
  Koloft does not set, so the shim's `CLAUDE_CODE_OAUTH_TOKEN` takes the same path as
  before. Both read, not run. Between 2.1.309 and 2.1.310 (`strings -n 6`, 2026-10-25,
  darwin-arm64 and linux-arm64): `ANTHROPIC_*` and `*_MODEL` identical at 77 and 14;
  `CLAUDE_CODE_*` gains 4 (`ARTIFACT_ASK_FIRST`, `DESKTOP_CONNECTOR_NAMES`,
  `RETRY_WATCHDOG_SCOPE`, `TOOL_CONTAINER_PLUGINS_NAMED`), none of which `src/` sets, and
  loses none; `tengu_*` gains 22 and loses 2 (one is `tengu_amber_sentinel`, §8); all 15
  names `src/` uses are still there. Between 2.1.310 and 2.1.311 (`strings -n 6`,
  2026-10-27, darwin-arm64 and linux-arm64): `ANTHROPIC_*` and `*_MODEL` identical at 77
  and 14; `CLAUDE_CODE_*` gains 18 (among them `DISABLE_QUIET_BACKGROUND_WAIT`, §8,
  `EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS`, which only stops the dangerous-`rm` prompt
  under skipped permissions, and `EMIT_USER_PROMPT_SUBMIT_HOOK_EVENTS`, which only adds
  SDK stream events), none of which `src/` sets, and loses `TOOL_CONTAINER_PLUGINS_NAMED`
  again; `tengu_*` gains 66 and loses 5, none named in this ledger; all 49 names `src/`
  uses or passes (env names and the shim's value-taking flags) are still there.
  Between 2.1.311 and 2.1.312 (`strings -n 6`, 2026-10-28, darwin-arm64 and
  linux-arm64): `ANTHROPIC_*` and `*_MODEL` identical at 77 and 14; `CLAUDE_CODE_*`
  gains 2 (`HOST_GUARDS_ARTIFACTS_MCP`, `REMOTE_TOOLS_HOST_IDLE_RELEASE_MINUTES`) and
  loses `MCP_HANDED_LISTINGS`, none of which `src/` sets; `tengu_*` gains 25 and loses 5,
  none named in this ledger; all 49 names `src/` uses or passes are still there.
  2.1.302 is the
  first build that reads `CLAUDE_CODE_AUTO_MODE_MODEL` (2.1.301 only names it in the env
  allow-list), with a server-configured classifier model taking priority over it; Koloft
  sets neither. The 2.1.301 changelog's "the `fable` (and
  `best`) alias … now retries once on the previous Fable model" is not found in the
  strings; what both binaries carry is the catalog entry `claude-fable-5-1` with
  `fallback_3p: "claude-fable-5"` (pointer, not run).
- **Since 2.1.304 a custom `ANTHROPIC_BASE_URL` no longer turns tool search off up
  front.** 2.1.303 skipped it for any host that is not Anthropic's ("is not a
  first-party Anthropic host. Set ENABLE_TOOL_SEARCH=true …"); 2.1.304 sends it, and when
  the endpoint answers 400 or 422 it resends the request without it and keeps tool search
  off for that model for 24 hours (`toolSearchRefusedAt` in the global config;
  "`ENABLE_TOOL_SEARCH=false` skips the refused request"). A gateway's `context_management:
  Extra inputs are not permitted` is also resent without that field (new in 2.1.304).
  Read from the strings of both builds, 2026-10-20, not run. **Since 2.1.305 the 24-hour
  memory is gone and the off switch lasts one conversation** (`toolSearchRefusedAt` is
  absent from 2.1.306): a 400 or 422 to a request that declared deferred tools — not a
  `billing_error`, and not taken by another recovery — is sent again once without
  them (`[ToolSearch] HTTP <status> … sending the request again without deferred tools.`),
  with a system reminder that `<ToolSearch>` is no longer available and the deferred
  tools are now declared in full; when that answer comes, tool search stays off for the
  rest of the conversation (`[ToolSearch] the endpoint answered the request sent without
  tool search, so this conversation goes on without it`). On Anthropic's own host only an
  error naming `defer_loading` or the tool-search beta header does this; behind a custom
  base URL any such 400/422 does. Read from the 2.1.306 strings, 2026-10-21, and the
  same three log lines in the 2.1.308 strings, 2026-10-22, not run:
  Koloft has no custom endpoint to test against. Koloft sets `ANTHROPIC_BASE_URL` for a
  custom-endpoint account and no `ENABLE_TOOL_SEARCH`, so a gateway that refuses tool
  search sees one refused request per conversation, and the session goes on; whether
  `/clear` or `/compact` starts that count again is inferred, not checked, and a gateway
  that accepts the field and then misbehaves is not probed.
  `CLAUDE_CONFIG_DIR` does NOT isolate credentials on macOS (official docs —
  credentials always go through the system Keychain). `claude setup-token` is the
  official login flow for a long-lived, inference-only token (scope below): it prints the authorization URL and, on success, the token on
  its output. **CC's Bash-tool children inherit the parent claude's full env**, so
  nested claude calls inherit the injected token (inferred, not checked).
- **Since 2.1.310 a gateway that refuses the effort beta or `role: "system"` turns
  gets the request again without them, and Koloft's hook text still arrives.**
  Measured 2026-10-25 on CC 2.1.309 and 2.1.310: `claude -p` with one Bash tool call
  against a fake Anthropic API (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN=fake`, every
  model slot pinned to `gw-model`, throwaway `HOME` and `CLAUDE_CONFIG_DIR`, `--settings`
  hooks for SessionStart, UserPromptSubmit and PostToolUse each giving
  `additionalContext`), the server logging every request and answering 400 by rule.
  - Accepted, both builds send `anthropic-beta` `effort-2025-11-24` with
    `output_config: {"effort": …}` (with or without `--effort`) and put all three hooks'
    text in `{role: "system"}` entries inside `messages` (beta
    `mid-conversation-tool-changes-2026-07-01`), not in the top-level `system`. Pinned to
    `claude-sonnet-4-5`, 2.1.310 sent neither, and the hook text went into user messages
    as `<system-reminder>` blocks.
  - A 400 in Anthropic's own wording ``Unexpected value(s) `effort-2025-11-24` for the
    `anthropic-beta` header…``: 2.1.309 failed (`API Error: 400 …`); 2.1.310 sent it again
    without the beta value and `output_config` and went on (`[effort] the server refused
    effort for model gw-model … this Claude Code process will not send either to this
    model again.`). The switch lives in memory: a second process (`-p --resume`) met the
    400 once more and recovered the same way.
  - A 400 refusing `role: "system"` (pydantic `messages.1.role: Input should be 'user'
    or 'assistant'`, or serde ``unknown variant `system` ``): 2.1.309 failed; 2.1.310 sent
    it again with no system entries and without that beta, and went on.
    `Unexpected role "system". …` was already recovered by 2.1.309. On the resend the
    SessionStart and UserPromptSubmit text sat in the user message as `<system-reminder>`
    blocks and the PostToolUse text at the end of the `tool_result`. The entries stayed off
    for the rest of the conversation and after a `-p --resume`; a new session sent them
    again (the log says "until /clear or /compact").
  - Other wordings (`Unsupported beta: effort-2025-11-24`, a bare `Bad Request`, `system
    role is not supported in messages…`) failed on both builds.
  Not run: the interactive TUI; which real gateways answer which wording.
- **CC's safety classifier can silently swap the model**: a blocked fable request is
  re-run on Opus and the session pinned there, so the model a session was launched
  with is not always the model it runs; the status JSON names the model in use.
  (2026-08-20, CC version not recorded.)
- **CC's fable consent prompt guards only the interactive first use**: `-p`, the Agent
  SDK, and already-consented users see no prompt, and a direct API call never meets
  it. (2026-08-20, CC version not recorded.)
- **What `claude setup-token` prints.** Before it prints, it runs `open <auth url>`
  from PATH and waits for the browser round trip (verified against 2.1.266). The token
  is about 108 characters, and its format is not documented; the stable parts are the
  `sk-ant-` prefix, a short kind segment (2–12 letters and digits), then a body of 24
  or more characters from `[A-Za-z0-9_-]`. **The output is hard-wrapped at the terminal
  width**, so at 80 columns the token is split across lines, and a capture stores a
  cut-off token that fails only later, when checked (seen in the guided-login flow).
  Apart from the 2.1.266 check: inferred, not checked. The 2.1.307 changelog's "the
  success page now appears as soon as sign-in completes" moved only the account-profile
  fetch after the browser's success redirect; the `setup-token` command, the code that
  prints the token ("Long-lived authentication token created successfully", "Store this
  token securely") and the browser step (`BROWSER`, else `open`, with the URL) are the
  same on 2.1.306 and 2.1.308 once minified names are evened out (`strings`, 2026-10-22,
  not run: no login was made).
- **Saved limit resets need a full-scope login; the token Koloft holds cannot read or use
  them.** Read 2026-10-13 from the 2.1.296 binary (`strings`): a hidden `/limit-reset`
  command reads resets from `GET /api/oauth/usage?cedar_ember=1&skip_spend=1` (blocks
  `cedar_ember` with `grants[]`, `resets_left`, `clears[]`, and `juniper_tide`) and spends
  one with `POST /api/organizations/{organizationUuid}/reset_rate_limits` (`{program,
  grant_id, request_id}`); both are skipped unless the token's scopes include
  `user:profile`, and a `CLAUDE_CODE_OAUTH_TOKEN` gets `user:inference` only. Measured
  the same day with one Koloft account's `setup-token` token: `GET /api/oauth/profile`
  answered 403 `oauth_scope_insufficient` (needs `user:profile` or `user:office`), so the
  organization id the claim's path needs is out of reach; the usage read answered 429
  twice and showed nothing. So a session Koloft starts — Assist's too — cannot use
  `/limit-reset` (inferred from the gate, not run). Where the narrow scope comes from,
  read from the 2.1.303 binary (`strings`, 2026-10-19): the authorize URL asks for
  `scope=user:inference` alone when the flow runs `inferenceOnly`, which the login
  command sets for `setup-token`; the full `/login` asks for `org:create_api_key
  user:profile user:inference user:sessions:claude_code user:mcp_servers
  user:file_upload`, plus `user:plugins` when the OAuth config's
  `PLUGINS_SCOPE_REGISTERED` is set. Whether any flag, variable or server setting widens
  the `setup-token` list: not probed.
- **The 5h window's reset time moves forward between probes** — the window is rolling.
  (Inferred, not checked.)
- **Remote Control refuses the long-lived token Koloft injects.** Measured 2026-10-01,
  CC 2.1.286, in a session the shim had launched with an account's
  `CLAUDE_CODE_OAUTH_TOKEN`: `/remote-control` answered "Remote Control requires a
  full-scope login token. Long-lived tokens (from claude setup-token or
  CLAUDE_CODE_OAUTH_TOKEN) are limited to inference-only…". So Claude's own phone remote
  does not work for a Koloft session.
- **Model prices** (USD per million tokens, input/output, and context window): Fable 5.1
  $10/$50, 1M (cache read $0.25); Fable/Mythos 5 $10/$50, 1M; Opus 5.5 $4/$20, 1M
  (cache read $0.20); Opus 5 $5/$25, 1M; Opus 4.6–4.8 $5/$25, 1M;
  Opus 4.5 $5/$25, 200k; Opus 4/4.1 $15/$75, 200k; Sonnet 5 $2/$10, 1M (standard rates
  since CC 2.1.243); Sonnet 4.6 $3/$15, 1M; Sonnet 4/4.5 $3/$15, 200k; Haiku 4.5 $1/$5,
  200k. A 5-minute cache write costs 1.25× input and a one-hour cache write 2× input
  (2026-10-24, CC 2.1.310, two `claude -p --output-format json` runs on a Koloft
  account, three requests: every cache write was `ephemeral_1h_input_tokens`, none 5m;
  CC's own `total_cost_usd` matched 2× input on them to the cent, and the transcript's
  `message.usage.cache_creation` carries the same split). A cache read costs 0.10×
  input, as ccusage applies it — except the 5.5-generation rows, whose cache read is their own
  figure: Fable 5.1 $0.25, Opus 5.5 $0.20, Sonnet 5.5 $0.10 (Anthropic's pricing page,
  fetched 2026-10-11, which also gives Haiku 5.5 $0.01, the plain 0.10×). Sources (2026-07): the Anthropic model catalog (through the
  local claude-api skill reference) for current families, Anthropic's public pricing
  page for older Opus/Sonnet, and the Sonnet 5 change noted against CC 2.1.243. The Opus
  5 and Opus 5.5 rows: the same skill's catalog (cached 2026-06-24), read 2026-09-24.
  Transcripts on the dev Mac (sweep 2026-09-24) record `message.model` values
  `claude-opus-5` and `claude-opus-5-5`, bare, with no date suffix. **Sonnet 5.5
  (`claude-sonnet-5-5`) $2/$10, 1M, cache read $0.10** — CC 2.1.296 changed its own
  `/cost` and status-line figure from $0.20 to $0.10 (changelog, read 2026-10-11), and
  Anthropic's pricing page said $0.10 the same day; the claude-api skill's catalog
  (cached 2026-10-06) still says $0.20.
  **Haiku 5.5 (`claude-haiku-5-5`) $0.10/$0.50, 1M**, the default `haiku` alias since
  CC 2.1.293 (so the §9 one-shot title runs on it); prompts over 100K tokens cost
  $0.50/$2.50 (changelog and the skill's catalog), a tier Koloft does not apply — it
  prices every token at the short-prompt rate (Codex's long-context tier, CODEX§13, is
  applied per request; this one is not). Both bare ids were in transcripts on the dev Mac on 2026-10-11
  (17 and 5 records).

Evidence: probe edge shapes curl-verified 2026-08-17; latency measured 2026-08-19–20;
classifier fallback seen 2026-08-20. Koloft dependents:
`src/main/usageProbe.ts` (marked `CC§7`; its parse rules are this section),
`src/main/accountPicker.ts`, `src/shared/accountUsage.ts`, the shim's inject section
in `src/main/shim.ts` and `accountEnv` in `src/main/remote/launch.ts` (the remote
launch pins the same six slots and the same FORCE flag); pinned by `usageProbe.parse/score`, `accountPicker`,
`accountUsage` unit suites and `test/e2e/multi-account.spec.ts`.

## §8 The Stop hook's task list, and what "running" means to CC

- **`Stop` / `SubagentStop` payloads carry `background_tasks`** — every registered
  task with `status ∈ {running, pending}` whose `isBackgrounded` is not `false`
  (the filter, read from the 2.1.261 binary) — and `session_crons`. Each entry is
  `{id, type, status, description}` plus `command` (shells), `agent_type`
  (subagents), `server`/`tool` (MCP), `name` (workflows). **`type` is a friendly
  label**: `shell`, `subagent`, `teammate`, `monitor` (MCP / live-update watchers),
  `workflow`, `MCP task`, `cloud session`, `dream`, `auto-mode scan`. Nothing in the
  payload says whether a task is idle or ambient — the SDK stream's `ambient` flag
  ("hosts should exclude them from activity indicators") is not forwarded to hooks.
- **A `/loop` wakeup shows up in `session_crons`.** Measured 2026-09-23 on CC 2.1.281,
  in a tmux run with a Stop hook that saved its input. `/loop <prompt>` ended its turn
  with `"session_crons":[{"id":"8044b6e3","schedule":"4 15 * * *","recurring":false,
  "prompt":"/loop …"}]` and `"background_tasks":[]`, in compact JSON. So a session
  whose last turn-end carried a non-empty `session_crons` will wake itself up, even
  though it looks idle. 209 sessions on the dev Mac had called `ScheduleWakeup`.
- **A subagent's own background shell is in its `SubagentStop` list, not in the main
  session's `Stop` list.** Measured 2026-10-08 on CC 2.1.294 (`claude -p`, temp HOME,
  both hooks saving their input): a subagent that started `sleep 120` with
  `run_in_background: true` and returned fired `SubagentStop` with
  `background_tasks: [{"type":"shell","status":"running","command":"sleep 120",…}]`, and
  the main `Stop` right after carried `[]`. The main transcript's `<task-notification>`
  for such a subagent says `<status>completed</status>` with the note "This agent
  stopped with background work of its own still running … the result below may be
  interim" (seen in a real interactive run the same day). Whether interactive mode's
  `Stop` lists it is inferred from that run, not probed.
- **The Bash tool refuses a long leading `sleep`.** Read from the 2.1.294 binary
  (`strings`): when a command's first part matches `^sleep\s+<n>\s*$` and `<n>` is at
  least a threshold (a minified constant, not read), the call is refused with "standalone
  sleep <n>" or "sleep <n> followed by: …", and the model is told to use Monitor or
  `run_in_background`. Seen the same day: a subagent told to run `sleep 300` in the
  foreground was refused, and one left free to choose ran it in the background instead.
  `perl -e "sleep 300"` does not match the check. Up to 2.1.309 this refusal, the
  Monitor tool and plugin monitors sat behind the server flag `tengu_amber_sentinel`
  (default off, so off wherever the flag never arrives — inferred, not checked);
  2.1.310 dropped that flag from all of them, the changelog's "Monitor … when telemetry
  or nonessential traffic is disabled; long foreground sleeps are now blocked there
  too". The regex `^sleep\s+(\d+(?:\.\d*)?)\s*$` and the "Blocked: …" text are the
  same (`strings`, 2026-10-25, not run).
- **An idle teammate is still `running`**. CC's own activity checks use
  `status === 'running' && !isIdle`; hooks never see `isIdle`. On disk the idle edge
  is a user record in the lead's transcript — `Another Claude session sent a
  message: <teammate-message teammate_id="…"> {"type":"idle_notification","from":"…"}`
  (the only message type seen, 127 of 127) — and teammates write their own
  transcripts under `<sid>/subagents/agent-<agentId>.jsonl` with a sibling
  `.meta.json` (`taskKind: 'in_process_teammate'`). ⚠️ A teammate's task id in the
  payload (`t…`) is NOT its agent id; a background Agent's task id (`a…`) IS the
  `agent-<id>.jsonl` name. `~/.claude/teams/<team>/config.json` has no status field.
- **A Monitor is reported as `type: 'shell'`** (it is a `local_bash` with
  `kind: 'monitor'`, and the label map flattens that). Its transcript ack —
  `toolUseResult: {taskId, timeoutMs, persistent}` — is the only way to tell.
  **A Monitor the model arms always has a deadline since 2.1.271**: at most 30 minutes
  (10 in a single-prompt `-p` run), then CC tells the model to re-arm it — the
  changelog says this replaced the no-timeout persistent option. The 2.1.276 binary
  still carries `Timeout deadline in milliseconds (0 when persistent)` and describes a
  plugin's `monitors.json` monitors as persistent (`strings`, 2026-09-18), so the ack
  shape survives and `timeoutMs: 0, persistent: true` can still show up for a plugin's
  monitor, never for a model-armed one (changelog claim plus binary strings; no live
  run measured). Measured on-machine before the change (2.1.261): one session reported
  `background_tasks` of length 1 at all 50 of its turn-ends (five persistent Monitors),
  another 12–24 (43 idle teammates + two `python3 -m http.server`).
- **Every Bash tool call — foreground or background — is a `zsh -c source
  …/shell-snapshots/… && eval …` child of claude whose stdout (fd 1) is
  `<scratch>/tasks/<id>.output`** (`lsof` shows the shell and every descendant
  holding it; the file outlives the task, the descriptor does not). So "is
  background shell `<id>` alive" has an exact OS answer, and a tool shell holding an
  output file the Stop list does not name is a FOREGROUND call in flight. One
  `bun listen.ts` was found 11.5 h into its run holding no listening socket.
- **Age does not tell a server from long work.** Census 2026-09-23 over every
  transcript on the dev Mac: of 2244 background shells with a start and an end, 88 ran
  ≥30 min. About 28 were servers (`npm run dev`, `next start`, `port-forward`); at
  least 25 were work (`until ! pgrep vitest…` waits, `npx playwright test`, gate
  scripts). CPU does tell them apart: over 60 s an idle `python3 -m http.server` used
  0.01 s of CPU per minute, while a test run uses tens of seconds per minute. A busy
  emulator (qemu) also used 24.5 s per minute, so it reads as work too.
- **A test run is not always busy on CPU, but it keeps printing.** Measured 2026-10-25,
  CC 2.1.310, macOS 27.0: a background `npx playwright test` of four Koloft e2e specs
  (65 tests, 7.4 min, Electron relaunched per test and listening on 127.0.0.1 through
  `--remote-debugging-port=0`) was sampled every 5 s. Over three 2-minute windows its
  tree used 23.7, 4.3 and 2.7 s of CPU per minute, counting programs that had exited
  (PLATFORM§3); summing only the live ones gave −0.7, 0.9 and 1.1. A second run gave
  27.3, 4.5 and 2.2 (live only: −1.7, 0.7, 0.7), and its output file grew in all three
  windows, by appending: the whole run's lines were still in it at the end.
- **A background subagent's own background shell stays in the MAIN session's Stop list
  after the subagent ends — in interactive mode.** Measured 2026-10-08 on CC 2.1.295,
  interactive TUI driven through a pty, with Stop/SubagentStop hooks that saved their input:
  the subagent ran `perl -e "sleep 100"` with `run_in_background` and returned at once. Its
  SubagentStop listed the shell (`{"id":"b3u7bx7sz","type":"shell","status":"running",…}`);
  the main session's next Stop listed the same id, and the shell was a `zsh -c … eval` child
  of the main claude with fd 1 on `<scratch>/tasks/b3u7bx7sz.output` — the same shape as a
  main-thread background shell. When it ended, the subagent woke (another SubagentStop), then
  the main session took one more turn whose Stop listed `[]`. The same on 2.1.310 and
  2.1.311 (2026-10-27, the same rig with python `pty.fork`, haiku,
  `--dangerously-skip-permissions`, scratch `CLAUDE_CONFIG_DIR`, hooks on Stop,
  SubagentStop, UserPromptSubmit and Notification; 1 run per build): three main Stops for
  one typed prompt, each wake-up turn also firing `UserPromptSubmit` with a `prompt` that
  starts with `<task-notification>`, and every main Stop followed about 1.5 s later by a
  SubagentStop with `agent_type: ""` and no transcript on disk. No periodic SubagentStop
  came on either build, here (100 s) or during a subagent's 70 s Bash call, so the
  2.1.311 changelog's "`SubagentStop` hooks running about twice a minute for each running
  subagent" was not reproduced; what triggered it is not probed yet. In the terminal a
  main-thread subagent always runs in the background, so a foreground one cannot be
  measured there. A `claude -p` run on 2.1.294 (issue #382) listed `[]` at the main Stop
  instead; whether the difference is the mode or the version is not probed yet.
- **In auto mode one subagent report costs the main session two turns, and every later
  wake of a background agent one more.** Measured 2026-10-27 on CC 2.1.310 and 2.1.311,
  the rig above with `--permission-mode auto`, 1 run per build per case. Only auto-mode
  subagents are told to report through `SubagentHandback` (6 of 6 auto transcripts, 0 of
  4 bypass ones); the report reaches the main session as a user record `Another Claude
  session sent a message: <agent-message from="<agentId>"> [Subagent hand-back] …` and
  starts a turn, then the `<task-notification>` for the same agent starts a second one (4
  main Stops for a subagent that started a 100 s background shell and returned, against 3
  in bypass mode). A subagent that armed a Monitor ticking every 20 s was woken by each
  tick; answering without calling `SubagentHandback` again, it got `[handback-send-enforce]`
  up to three times (SubagentStops with `stop_hook_active: true`), then the main session
  was told it "ended without a final report" — one main turn per tick, 6 main Stops in
  all, on both builds. So the 2.1.311 changelog's "background agents in auto mode that
  wait on their own shells starting a new main conversation turn on every wake" did not
  change this shape; the exact case it fixed is not probed yet (a subagent blocked in a
  foreground `until ! pgrep …` loop was never woken on either build). Koloft launches no
  auto-mode session itself; a person can switch a tab into it, and each such turn ends
  with a Stop like any other.
- **`Notification` payloads carry no task list** (124 "Claude is waiting for your
  input" nudges, none with `background_tasks`), and `-p` mode exits with a background
  shell still running, firing one Stop. 2.1.311 changed the keep-alive wait around
  `session_keepalive_background_wait` (`strings`, 2026-10-27, not run): when every
  background task is a `local_bash` and no command or wake-up is queued, it now waits
  quietly for a message instead of waking every 100 ms, unless
  `CLAUDE_CODE_DISABLE_QUIET_BACKGROUND_WAIT` is set; the "Waiting for background work
  to finish… Ctrl+C" text is in both builds, so whether `-p` still exits here is not
  probed yet.
- **A permission Notification's `message` contains "permission"** — "Claude needs your
  permission to use Bash" (undated note), "Claude needs your permission" (2.1.281,
  below). That some carry "approval" instead is inferred, not checked.
- **A Notification is NOT always one of those two: its input carries a
  `notification_type`, and a hook's `matcher` filters on it.** The 2.1.281 binary
  lists the types `permission_prompt, idle_prompt, auth_success, elicitation_dialog,
  agent_needs_input, agent_completed, elicitation_url_dialog,
  worker_permission_prompt, push_notification, computer_use_enter, computer_use_exit,
  quota_auto_resume_fired, …` — most are not a turn end. Measured 2026-09-23 on CC
  2.1.281 in a tmux run with `--settings`: a permission prompt fired
  `{"message":"Claude needs your permission","notification_type":"permission_prompt"}`,
  the 60 s nudge fired `{"message":"Claude is waiting for your
  input","notification_type":"idle_prompt"}`; both reached a hook with
  `"matcher":"permission_prompt|idle_prompt"`, and neither reached one with
  `"matcher":"auth_success"`. That `worker_permission_prompt` and `elicitation_url_dialog`
  also mean the run waits on the person is read from their names only; their payloads
  are not measured.
- **An MCP server's form (`elicitation/create`) sends an `Elicitation` hook, then one
  `elicitation_dialog` Notification, and no Stop while it stays open.** Measured
  2026-10-24 on CC 2.1.310: interactive claude in a python pty, haiku,
  `--dangerously-skip-permissions`, scratch `CLAUDE_CONFIG_DIR`, `--strict-mcp-config`
  with one stdio MCP server whose tool, when called, sent `elicitation/create`
  (`message: "Which colour do you prefer?"`, an enum field `colour` of Red / Green), and
  logging hooks on `Notification` (the matcher Koloft uses), `Stop`, `UserPromptSubmit`,
  `PermissionRequest`, `Elicitation`, `ElicitationResult` and `PostToolUse`; 1 run. The
  `Elicitation` hook fired 2.6 s after the prompt with `{mcp_server_name: "probe",
  message, mode: "form", requested_schema}`; 6 s later came
  `{"message":"Claude Code needs your input","notification_type":"elicitation_dialog"}`
  (no `PermissionRequest`); the form ("MCP server “probe” requests your input", Accept /
  Decline, "Esc to cancel") stayed open about 530 s, until the run was killed, and no
  other hook fired. `2`, then CR, did not answer it: CR moved the cursor to Accept with
  the field still "not set"; which keys fill and send it is not probed yet. The 2.1.310
  binary writes the same text for `elicitation_url_dialog` (`strings`). So with no
  "permission" in its message Koloft reads it as the `input` turn, which shows as
  `approval`.

**How a background task shows up in the transcript.** Checked "against real
transcripts and the CLI's own result schemas" on claude 2.1.222; the forked-skill
shapes on real transcripts, 2.1.227 and 2.1.220. Bullets with no source named are
inferred, not checked.

- **The spawn ack** is a tool_result user record whose `toolUseResult` tells the kind:
  - `status: 'async_launched'` — an Agent with `run_in_background`, and every Workflow
    run (`taskType: 'local_workflow'`). The Agent form looks like
    `{isAsync: true, status: 'async_launched', agentId}` with the text
    "Spawned successfully.", and the turn can end with Stop while it runs.
  - `status: 'teammate_spawned'` — a named or team Agent.
  - `status: 'remote_launched'` — a cloud agent (`isolation: 'remote'`,
    `taskType: 'remote_agent'`). It runs on CC's side: nothing under the session's
    `subagents/` folder ever grows, so the ack is the only local sign it runs.
  - `backgroundTaskId` — a background shell. A shell the model was waiting on also
    carries `timedOutAfterMs` (moved to the background at its tool timeout; the text
    reads "Command timed out and was moved to the background (ID: …)") or
    `backgroundedByUser` (Ctrl+B).
  - `{taskId, timeoutMs}` — a Monitor.
  - `{status: 'forked', background: true, agentId}` — a skill forked into a background
    agent (2.1.227). Its agent writes a transcript at once, and the main loop writes ONE
    wrap-up line before its Stop. A fork whose result is already final OMITS
    `background` entirely (2.1.220), rather than setting it false.
- **A Monitor a plugin starts has no spawn ack; only its events name it.** Seen
  2026-10-20 in a real CC 2.1.304 transcript (a plugin's monitor, started with the
  session): no `{taskId, timeoutMs}` record anywhere, yet the task ran for hours and was
  still running at a turn end. Each event arrives as a `<task-notification>` with
  `<task-id>` and `<summary>Monitor event: "<description>"</summary>`, no `<tool-use-id>`
  and no `<status>`; that plugin's first event came right at session start. A
  model-armed Monitor's events and its 30-minute expiry notice carry the same summary.
- **A Workflow's agents write transcripts** under `<sid>/subagents/workflows/<runId>/`,
  one level deeper than a plain subagent.
- **The finish report is a `<task-notification>`** naming both a `<tool-use-id>` and a
  `<task-id>`. It is written three ways: a `queue-operation` record (`operation:
  'enqueue'`, content = the notification) when the task reports, removed when
  delivered; then an `attachment` record (`type: 'queued_command'`,
  `commandMode: 'task-notification'`); or a user record with `origin.kind:
  'task-notification'`, `isMeta` unset, whose text opens with `<task-notification>`. That
  user record is still written by 2.1.295–2.1.296 (sweep of the 487 main transcripts on
  this Mac, 2026-10-09: 1,047 such records, every one carrying that `origin`). A probe
  the same day (2.1.296, scratch `HOME`, `/goal` asking for a `run_in_background` Bash
  and an end of turn) wrote it for a task that finished while CC sat idle, right after
  the `queue-operation` pair; that session, opened by `/goal`, got no `ai-title`.
  Which shape a task finishing mid-turn gets is not probed yet. Terminal `<status>` values are
  `completed`, `failed`, `killed`, `stopped`, `cancelled`, `canceled`; `stopped` comes
  for a task killed from the UI, by a Monitor timeout, or by agent teardown. Long-lived
  tasks (Monitor, teammate) also send progress notifications with the same tool-use-id.
  The terminal notification wakes the model, so a wrap-up turn with its own Stop
  follows. Every ack kind gets one — except a teammate.
- **A teammate never gets a `<task-notification>`** (measured: 149 `teammate_spawned`
  acks across 41 recent transcripts, zero named by one). It reports through an
  `Another Claude session sent a message: <teammate-message …>` record, which carries
  no tool-use-id.

Evidence: 2026-09-05, CC 2.1.261 — binary reading of the Stop-hook module, 251 real
Stop records in Koloft's run-state logs cross-checked
against their transcripts, `lsof`/`ps` on live sessions, and a headless probe
(`printf <prompt> | claude -p --settings <stop-hook settings> --allowedTools Bash`;
the prompt must ride stdin or `--allowedTools` swallows it). Koloft dependents: the
`bgl` list in `src/main/hooks.ts`'s injected script, `src/main/taskProcs.ts`,
`judgeReported` and the server test (`IDLE_SERVER_CPU_MS_PER_MINUTE`,
`SERVER_QUIET_WINDOW_MS`) in `src/main/sessionTracker.ts`.

## §9 Launch flags for a run nobody is watching

How established (unless a bullet names its own date or says inferred): live pty runs
of the real binary on 2026-09-03, CC 2.1.259, on a throwaway one-commit git repo, with
an own `--settings` hook file logging `SessionStart / UserPromptSubmit / Stop /
SessionEnd` with millisecond stamps, and the resulting
`~/.claude/projects/<slug>/<id>.jsonl` read back record by record.
Probes P1–P7. Flag spellings quoted from `claude --help` of the same build. The launch
line Koloft's scheduled jobs use (`--model`, `--name`, the task after `--`) is pinned by
`cron-real-smoke.spec.ts` › BB-R01, green on 2.1.296 (2026-10-11), 2.1.299
(2026-10-14), 2.1.300 (2026-10-15), 2.1.301 (2026-10-16), 2.1.302 (2026-10-17),
2.1.303 (2026-10-19), 2.1.304 (2026-10-20), 2.1.306 (2026-10-21), 2.1.308
(2026-10-22), 2.1.309 (2026-10-23), 2.1.310 (2026-10-25), 2.1.311 (2026-10-27) and
2.1.312 (2026-10-28).

Re-checked on 2026-09-06, CC 2.1.263, same throwaway-repo pty setup, six runs, each
transcript read back record by record: **P1, P3 and P6 are unchanged.** P1 — the text
after `--` still arrives as the first user record byte for byte, a dash-leading text
(`-- "-p is not a flag, …"`) is still a prompt and not a flag, and `-- "/probe-s9"`
still runs the project command and writes the same
`<command-message>…</command-message><command-name>…</command-name>` first user
record, followed by the command body. P3 — `--name "Probe S9 title"`
still writes `{"type":"custom-title",…}` and `{"type":"agent-name",…}` as records #0
and #1. P6 — with `ANTHROPIC_MODEL=claude-haiku-4-5-20251001` exported, `--model
sonnet` still won (`claude-sonnet-5` in every assistant record); the env var alone
still gave `claude-haiku-4-5-20251001` and the flag alone `claude-sonnet-5`. The
other bullets of §9 were not re-measured on this build.

- **A first message can be handed to a fresh session on the command line, after `--`.**
  `claude … -w <name> --name "<title>" -- "<text>"` opens the interactive session and
  submits `<text>` as the first turn: hooks fire SessionStart, then UserPromptSubmit
  52 ms later, then Stop; the transcript's first user record holds the text byte for
  byte. **The text may start with a dash** — `-- "-p is not a flag"` was taken as a
  prompt, not as a flag. **The text may be a slash command** — `-- "/probe-proj"` ran
  the project skill and wrote the same
  `<command-message>…</command-message><command-name>/probe-proj</command-name>`
  record that typing it produces.
- **`--permission-mode bypassPermissions` starts on its own ONLY on a machine that has
  already accepted the bypass warning** — the session then opens straight at the prompt
  with the footer `⏵⏵ bypass permissions on (shift+tab to cycle)` and answers
  immediately. On a machine that has not accepted it, this spelling shows the same
  one-time "WARNING: Claude Code running in Bypass Permissions mode / Yes, I accept"
  screen as `--dangerously-skip-permissions`, BEFORE SessionStart, so anything automated
  stalls there (measured 2026-09-08 on 2.1.263 with a throwaway `$HOME`, both spellings,
  a pty probe: identical screen).
  **The accepted answer lives in `~/.claude/settings.json` as
  `skipDangerousModePermissionPrompt: true`** — that is the key the dialog writes on
  "Yes, I accept" (read off the 2.1.263 binary's own dialog code with `strings`). The
  older `bypassPermissionsModeAccepted: true` in `~/.claude.json` is still honored as a
  gate (a throwaway `$HOME` carrying only that key started with no screen). Koloft reads
  neither: every launch carries the key in its own `--settings` file (next point).
- **The same key inside a `--settings` file skips the screen too.** With
  `{"skipDangerousModePermissionPrompt": true}` in a file passed as `--settings <file>`,
  both `--dangerously-skip-permissions` and `--permission-mode bypassPermissions` open
  straight at the prompt (footer `⏵⏵ bypass permissions on`); without it both show the
  warning. A launch with no bypass flag is unchanged by the key: Shift+Tab cycles auto →
  manual → accept edits → plan → auto and never offers bypass. Measured 2026-10-15 on
  2.1.300 and again 2026-10-16 on 2.1.301 (macOS arm64), a scratch `CLAUDE_CONFIG_DIR`
  with onboarding done and the folder trusted, a python pty, 20 s per run; and the same
  on Linux, 2.1.301 linux-arm64 in Docker `node:22-bookworm` as a plain user (the screen
  without the key, none with it). As root on Linux the flag is refused outright:
  `--dangerously-skip-permissions cannot be used with root/sudo privileges for security
  reasons`, key or not.
- **`--name <title>` is a real title, written before any message.** The transcript's
  first two records are `{"type":"custom-title","customTitle":"<title>"}` and
  `{"type":"agent-name","agentName":"<title>"}`, and the `claude --resume` picker
  lists the session under that title (an unnamed session shows an auto summary there
  instead). Help text: `-n, --name <name>  Set a display name for this session (shown
  in the prompt box, /resume picker, and terminal title)`.
- **A session started with `--name` never gets an `ai-title`.** A sweep on 2026-10-07 of
  every main transcript then on disk (CC 2.1.263 to 2.1.293): of the 127 whose first
  record is the `custom-title` that `--name` writes, 0 carried an `ai-title`; of the 311
  that start without one, 84 did. So the only words naming such a session, besides its
  `--name`, are its first prompt. **`--name` itself is what stops the title** — checked
  2026-10-08 on CC 2.1.295 with a pair of pty launches in an empty folder, the same
  first message, nothing else different: without `--name` the transcript got
  `ai-title` "Koloft 侧栏会话标题过长"; with `--name title-probe-n` it got only the
  `custom-title` / `agent-name` pair, no `ai-title`.
- **`/rename <text>` renames both the title and the address.** Same build and setup: a
  session started with `--name rename-probe-a` and then sent `/rename 改名后的标题`
  appended a new `custom-title` *and* a new `agent-name` with the new text, and still no
  `ai-title`. So the latest `custom-title` is the session's name, and a peer that kept
  the old name no longer reaches it by that name.
- **`claude -p --resume <id>` of a `/rename`d session appends to the same jsonl** (its
  init `session_id` is `<id>`). On 2.1.308 it also re-wrote `custom-title`, `ai-title`
  and `agent-name` (same text) plus `mode`, `permission-mode` and `atis-latch` after
  its first API request; 2.1.309 appended none of these (2026-10-23, a pty-driven
  session in a scratch `HOME`, `/rename` then `/exit`, then `-p --resume`, 2 runs per
  build). The latest `custom-title` is unchanged either way.
- **A name may hold spaces and CJK text and still be a message address.** Same build:
  `--name "带 空格 的 名字"` was listed by ListAgents under that name, and a
  SendMessage to that bare name was delivered (its transcript holds the reply
  `GOT PROBE-SPACE-123`).
- **A one-shot `claude -p --model haiku` makes a usable title in 2–5 s.** Measured
  2026-10-08, CC 2.1.295, through Koloft's shim with the account balancer: 20 real
  first messages of agent-started sessions, task on stdin, each answered in 2.1–5.0 s
  with a short title in the task's language. With the default system prompt and setting
  sources one call read ~5.7k input tokens (≈ $0.001); with `--system-prompt` set and
  `--setting-sources ''` it read ~750 (≈ $0.00024) and still answered. With
  `--no-session-persistence` it left no transcript in its cwd's project folder. Behind
  an expired login it prints `Failed to authenticate: …` on stdout and exits 1, so only
  the exit code tells a title from an error.
- **Spawn to SessionStart is well under a second on this machine**: 0.250 / 0.272 /
  0.293 / 0.265 / 0.381 s over six launches with the user's real MCP config loaded (no
  `--strict-mcp-config`), 0.429 s through Koloft's own shim with the account balancer
  and the Keychain read live. Caveat that keeps this honest: **no MCP server is
  configured anywhere on this machine**, so these numbers say nothing about a machine
  that loads MCP servers at startup.
- **`--model` out-ranks an `ANTHROPIC_MODEL` in the environment.** With
  `ANTHROPIC_MODEL=claude-haiku-4-5-20251001` exported and `--model sonnet` on the
  command line, every assistant record reported `claude-sonnet-5`; the env var alone
  gave `claude-haiku-4-5-20251001`, the flag alone gave `claude-sonnet-5`. So a
  `--model` flag overrides the `ANTHROPIC_MODEL` pin of a custom endpoint (§7); that it
  also overrides the `ANTHROPIC_DEFAULT_*_MODEL` slots is inferred, not checked. Help
  text: `--model <model>
  Model for the current session. Provide an alias for the latest model (e.g. 'fable',
  'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5').`
- **The `/` autocomplete is fed by exactly four folders**, and it tags the source
  instead of prefixing the name. A marker planted in each of
  `<repo>/.claude/skills/<dir>/SKILL.md`, `<repo>/.claude/commands/<file>.md`,
  `~/.claude/skills/<dir>/SKILL.md` and `~/.claude/commands/<file>.md` all showed up
  after typing `/probe`, rendered as `/<name>  <description> (project)` for the two
  repo-level ones and `(user)` for the two home-level ones. Repo entries come first,
  then home entries, each group alphabetical with skills and commands mixed together.
  A command file with no front matter uses the first line of its body as the
  description. CC's built-in commands carry no tag. The binary knows three folder
  names only — `.claude/skills`, `.claude/commands`, `.claude/agents` — and the third
  holds subagents, which are not slash commands. **Plugins are a fifth source** (a
  plugin ships commands and skills of its own) that could not be observed here because
  none is installed (`~/.claude/plugins/installed_plugins.json` is
  `{"version":2,"plugins":{}}`). **Skills synced from the claude.ai account are a sixth
  source** (changelog, read 2026-09-18: 2.1.275 "syncing of the skills and plugins
  enabled on your claude.ai account to terminal sessions; opt out with
  `syncClaudeAiSkills: false`"; 2.1.269 lists them as `anthropic-skills:<name>`). Where
  they land on disk was NOT observed — no sync happened on this machine.
- **Flag shapes worth not re-deriving.** The 2.1.281 binary carries the three sets its
  own argv scanner uses (`strings`, 2026-09-24); the flags `claude --help` shows are:
  takes a required value — `--agent --agents --append-system-prompt --autocompact
  --debug-file --effort --environment --fallback-model --input-format --json-schema
  --max-budget-usd --model -n/--name --output-format --permission-mode
  --permission-prompts --plugin-dir --plugin-url --remote-control-session-name-prefix
  --session-id --setting-sources --settings --system-prompt --system-prompt-snapshot`;
  takes an **optional** value (so the next token may be a real argument) —
  `-w/--worktree`, `-r/--resume`, `-d/--debug`, `--cloud`, `--from-pr`,
  `--prompt-suggestions`, `--remote-control`, `--teleport`; **variadic** — `--add-dir
  --allowedTools/--allowed-tools --disallowedTools/--disallowed-tools --betas --file
  --mcp-config --tools`. The same sets also hold flags `--help` does not show, among
  them `--max-turns` and `--system-prompt-file` / `--append-system-prompt-file`
  (required value) and `--remote`, `--rc`, `--project` (optional value); that
  `--max-turns` works the same as a shown flag is inferred, not checked. `-n` really is
  CC's short form of `--name`. From `claude --help` on 2.1.281 (2026-09-24):
  `--permission-prompts` takes `host` or `none`; `--effort` takes exactly `low`,
  `medium`, `high`, `xhigh`, `max`. The `--help` text of 2.1.293, 2.1.296 and 2.1.299 is
  byte-identical, 311 lines (run with stdin closed, 2026-10-11 and 2026-10-14); 2.1.300's
  differs only inside the `--restricted` paragraph (the word "REPL" dropped from the list
  of code-running tools; still 311 lines, 2026-10-15); 2.1.301's is byte-identical to
  2.1.300's (2026-10-16), 2.1.302's to 2.1.301's (311 lines, 22,110 bytes,
  2026-10-17), and 2.1.303's to 2.1.302's (2026-10-19). 2.1.304's is 313 lines, 22,319
  bytes (2026-10-20): only help text moved — `--resume` now says "by session ID or name"
  (the name lookup is older, §1), `--json-schema` "(only works with --print)",
  `--disable-slash-commands` "Disable all skills and commands", `--tools` "\"default\"
  to use the default set", `--system-prompt-snapshot` "on (the default, except under
  --bare outside cloud and background sessions)", `--debug` new examples, and `update`
  "package-manager installs update through the package manager"; no flag was added or
  removed, and the code behind `--system-prompt-snapshot` is the same in both builds
  (`strings`). 2.1.306's is byte-identical to 2.1.304's (313 lines, 22,319 bytes,
  2026-10-21), and 2.1.308's to 2.1.306's (2026-10-22). The permission mode a `-p` run with no permission flag starts in, and how
  2.1.302 changed it for a config dir with no flag cache, is measured in §14. The
  `CLAUDE_CODE_*` names the 2.1.301 binary adds over 2.1.300
  (`strings`, 2026-10-16; pointers): `ATTACHMENTS_IN_USER_DATA`, `DAPPER_CUPCAKE`,
  `RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS`; gone: `SQUISHY_NEWT`. **Unattended retry
  mode** (read from the 2.1.300 and 2.1.301 strings, 2026-10-16; not run): with
  `CLAUDE_CODE_RETRY_WATCHDOG` set, a 429, a 529 or an `overloaded_error` no longer
  ends the request after the usual retry count (`api_request_retry_exhausted`) or the
  repeated-529 give-up; each wait is the time to `anthropic-ratelimit-unified-reset`,
  else a backoff capped at 5 min, any one wait capped at 6 h and by what is left of
  `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` (2.1.300; unset means no limit). 2.1.301
  adds `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS`, a budget for the waits on a
  usage-limit 429 (`anthropic-ratelimit-unified-status: rejected`): a reset further
  away than what is left ends the request with `api_request_usage_limit_wait_too_long`,
  unless the overage status header says `allowed` or `allowed_warning`. The self-hosted
  runner's spawn env sets `CLAUDE_CODE_RETRY_WATCHDOG: "1"`. 2.1.305 adds
  `CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS` (in 2.1.306, not 2.1.304; digits
  only, 60,000 to 10,800,000; unset means no recheck): during a usage-limit wait CC asks
  whether the limit was lifted about every that many ms (±25%), while more than 30 s of
  the wait remain, and retries at once when it was; after a "lifted" that met another
  usage-limit 429 the gap grows, up to 3 h. Without `CLAUDE_CODE_RETRY_WATCHDOG` no wait is
  long enough for it to act (`strings`, 2026-10-21, not run). Koloft sets none of the
  four. The `CLAUDE_CODE_*` names the
  2.1.300 binary adds over 2.1.299 (`strings`, 2026-10-15; pointers, none read):
  `ATTACHMENTS_BY_PATH`, `FILE_READ_MAX_PDF_PAGES_PER_MESSAGE`,
  `FILE_READ_MAX_PDF_PAGES_PER_TURN`, `HIDE_REPLY_SERVER_NAME`,
  `MESSAGES_PROMPT_CACHE_TTL`; gone: `FORCE_SANDBOX`. The
  `CLAUDE_CODE_*` names the 2.1.299 binary adds over 2.1.296 (`strings`, 2026-10-14;
  pointers, none read): `ARTIFACT_PUBLISH_EDITS`, `AUTO_MODE_COMPACT_THREAD_RULE`,
  `CCR_WORKER_SOCKET`, `DISABLE_FILE_MENTIONS`, `ENABLE_SHARE_BUNDLE`,
  `JIT_POLICY_AFTER_STARTUP`, `LAZY_ENV_GETTERS`, `MCP_ALWAYS_LOAD_JOIN_BEFORE_INPUT`,
  `MCP_SERVE_INTERFACE_MIN_VERSION`, `REMOTE_MCP_CONFIG`,
  `SANDBOX_LEAVE_DENIES_TO_SRT_WIN`, `SANDBOX_LEAVE_PARENT_FOLDERS_ALONE`,
  `SETTLE_TOUCHED_FILES` (gone again in 2.1.306), `STRICT_INLINE_SHELL_RM_PROMPT`,
  `TRANSCRIPT_SLIM_TOOL_RESULTS`; gone: `WEBSEARCH_CITATIONS_DECLARED`.
- **A new directory always asks for trust on its first launch**, and
  `--dangerously-skip-permissions` does not skip that question ("Quick safety check: Is
  this a project you created or one you trust?", default answer "No, exit"). A worktree
  created under an already-trusted repo inherits the trust and asks nothing. Anything
  automated that launches CC in a folder for the first time therefore stalls on a
  question. The answer is recorded in `~/.claude.json` as
  `projects[<absolute path>].hasTrustDialogAccepted: true` (key name read off the
  2.1.263 binary with `strings`, 2026-09-06), and ancestors count — **but only up to the
  top of the git repo the folder is in.** Outside any git repo every ancestor counts;
  inside one, only the folder and its ancestors up to and including the repo's top
  folder; in a linked worktree (`.git` is a file), the top folder is the main repo's
  (the folder above the git dir its `gitdir:` entry's `commondir` names; `commondir` is
  read off the 2.1.310 binary, not run — the worktree probed sat inside its main repo,
  where `commondir` and the path shape agree, so a bare repo's worktree is not probed
  yet). So a repo
  under a trusted folder asks again: a folder that sat quietly under a trusted parent
  asked for trust on the next launch after `git init` in it, and stopped asking once
  `.git` was removed; with only the repo trusted, neither a subfolder nor
  `.claude/worktrees/w` asked. Measured 2026-10-24 on CC 2.1.310: a temp `HOME` with a
  `.claude.json` of `hasCompletedOnboarding: true` plus the trust entries, the binary
  run in a pty (`script -q`) under `perl -e 'alarm 8; exec @ARGV'`, looking for
  `Quick safety check` in what it drew. The same binary's code (`strings`) walks up and
  stops at the repo top; it also checks the folder's own key first, and gives no
  ancestor's trust to a folder outside the repo top it found (a worktree placed outside
  its main repo) — read, not run. **A `.git` file whose git dir has no readable
  `commondir` makes its own folder the top.** Measured 2026-10-27 on CC 2.1.311, the same
  temp-`HOME` method (the binary in a python pty for 9 s; a "no" run drew the main screen
  instead), two runs per case, same answer both times. A real submodule `P/R/sub` (made
  with `git submodule add`; its git dir `P/R/.git/modules/sub` has no `commondir`), and
  the same shape made with `git init --separate-git-dir`: asked with only `P/R` trusted
  and with only `P` trusted, did not ask with `P/R/sub` trusted. A worktree whose main
  repo is gone (`P/W/.git` naming a git dir that no longer exists): asked with only `P`
  trusted, did not ask with `P/W` trusted. Such a worktree at `P/Q/W`, inside a plain repo
  `P/Q`: asked with only `P/Q` trusted and with only `P` trusted. Controls: with nothing
  trusted it asked; with only `P` trusted, a launch in the repo `P/R` asked. The code also
  holds a second path, marked by the word `rootOnly`, where only one folder's own entry
  counts; in 2.1.311 the check that turns it on always says no, so it never runs (read
  with `strings`, not run) — look for `rootOnly` again on each upgrade. `claude --help`
  (2.1.281) adds that `-p`, or a stdout that is not a TTY, skips the trust dialog.
  **An older `<config dir>/.config.json` can stand in for `~/.claude.json`** (the config
  dir is `CLAUDE_CONFIG_DIR`, else `~/.claude`): through 2.1.296 its mere existence made
  CC read it instead, so an empty one left by a sandboxed command hid the trust and the
  login (the 2.1.299 changelog's Linux fix); 2.1.299 takes it only when it is non-empty,
  or empty but writable while no `~/.claude.json` exists. Read from the 2.1.296 and
  2.1.299 binaries, macOS and linux-arm64 alike (`strings`, 2026-10-14). So the trust
  Koloft writes into `~/.claude.json` on a remote machine holds unless that machine has
  such a file.
- **`-w` in a never-trusted repo does not ask — it refuses and exits.** `claude -w <name>`
  prints `Error creating worktree: Workspace trust not yet accepted. Run \`claude\` once
  in this directory and accept the trust dialog, then retry with --worktree.` and exits
  in about 0.4 s; no worktree is made. **A bare `{"hasTrustDialogAccepted": true}`
  entry is enough**: with only that under the repo's path, the same command made the
  worktree (locked, branch `worktree-<name>`) and opened the session. **The key must be
  the real path**: launched from `/var/folders/…` (a symlink to `/private/var/…`, with
  `PWD` set to the symlink path), a key written as `/var/…` was ignored and `-w`
  refused again; `/private/var/…` worked. **The launch folder is what counts, not the
  repo's top folder**: launched from a subfolder of the repo, with only that subfolder
  trusted, `-w` made the worktree at the top folder's `.claude/worktrees/` and started.
  Measured 2026-09-23, CC 2.1.281, pty probe on a throwaway one-commit repo under
  `$TMPDIR`, no trusted ancestor.
- That CC on Linux reads `projects[<real path>].hasTrustDialogAccepted` and treats
  `--name` / the text after `--` exactly as measured above on macOS is **inferred, not
  checked** on a real machine (2026-09-24).
- **A child claude inherits the parent's session markers and stops writing its
  transcript.** With `CLAUDE_CODE_CHILD_SESSION=1` in the environment the launched
  session prints `⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
  marker · restart with CLAUDE_CODE_FORCE_SESSION_PERSISTENCE…` and creates no jsonl at
  all. The sibling markers leak effort and messaging the same way. Seen 2026-09-24 on
  CC 2.1.281 with `env` inside a Bash tool call: `AI_AGENT`, `CLAUDECODE`,
  `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`,
  `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`,
  `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_EFFORT`,
  `CLAUDE_PID`. A background session (§5) also sets `CLAUDE_JOB_DIR=~/.claude/jobs/<short id>`.
  **A claude started with an inherited `CLAUDE_JOB_DIR` takes that job's name**: seen
  2026-09-27 on CC 2.1.283. A dev build of Koloft was started from a background
  session's Bash, and two sessions it launched in another folder were registered in
  `~/.claude/sessions/` under the parent job's name (`nameSource: "auto"`). Their
  environment held the parent's `CLAUDE_JOB_DIR` and `CLAUDE_PID`. Which of the two
  does it was not isolated.
- **Every process a claude starts carries `CLAUDECODE=1`** (the Bash tool's shell and
  everything under it; seen 2026-09-23 and again 2026-09-24 on CC 2.1.281).
- **A claude cleans up its own background shells, but not a program that detaches
  itself.** Measured 2026-09-23 on CC 2.1.281 in tmux. A `run_in_background` `sleep
  900` ran in its own process group under claude, and SIGHUP to claude took the shell
  and the `sleep` down with it. A program that re-parents itself to launchd lives on,
  and it still carries `CLAUDE_CODE_SESSION_ID=<id>` and `CLAUDE_PID` in its
  environment. Examples: an Android emulator's `qemu`, still running three days after
  its session; an `adb` server; the OrbStack app. So "programs this session left
  running" = processes with ppid 1 whose environment names that session id.
- **Since 2.1.309 the dangerous-`rm` check in bypass mode denies at once only where an
  SDK host draws its own permission card; a TUI still gets the dialog.** Read from the
  2.1.309 binary with `strings`, 2026-10-23, not run: the `tengu_splendid_horizon`
  settings gained `denyOnHostCard` (default `true`) beside `enabled`, `showDialog`,
  `timeoutMs: 120000` and `maxDialogTimeouts: 3`, and the deny-at-once path needs a flag
  the SDK's dialog handler sets inside the process — not `CLAUDE_CODE_ENTRYPOINT` or any
  env name. With no such host the 2.1.308 path runs unchanged
  (`CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT` still turns it off). Koloft runs the TUI
  in a pty and sets no `CLAUDE_CODE_ENTRYPOINT`, so its tabs are never taken for the
  Desktop app or VS Code.

Koloft dependents: the scheduled-jobs runner's launch line and the shim's new-session
branch (`src/main/shim.ts`), `src/main/claudeArgs.ts`, `src/main/skillList.ts`,
`src/main/claudeTrust.ts`, the env scrubs in `src/main/ptyManager.ts` and
`scripts/code-review.mjs`,
`src/main/leftovers.ts`, the warm-up `claude -p ok --max-turns 1` in
`src/main/remote/launch.ts`, and the remote launch and trust in
`src/main/host/sshHost.ts`.

## §10 The official install script (`https://claude.ai/install.sh`)

How established: the script as served on 2026-09-08 was fetched and read, alongside
the official install docs; Claude Code 2.1.263 was the current version that day. The
bullets dated 2026-10-11 were measured against a real install on macOS.

- **It is `#!/bin/bash`** (uses `[[ ]]` and `=~`), so `sh` cannot run it — a machine
  without bash needs bash installed first. It needs `curl` or `wget` and `sha256sum` or
  `shasum`, detects `x86_64` / `aarch64` and musl by itself, **refuses to run under
  `sudo`** (plain root is fine), and installs a self-contained native binary to
  `~/.local/bin/claude`, so a machine with claude need not have node.
- **The installer writes no shell rc file.** It only prints "~/.local/bin is not in your
  PATH" with an `echo … >> ~/.zshrc` line for the user to run, so neither `zsh -l -c` nor
  `zsh -l -i -c` finds `claude` afterwards. It does create `~/.claude.json` (install
  method, user and machine ids — no `hasCompletedOnboarding`). (2026-10-11, Claude Code
  2.1.296, macOS 27: `curl -fsSL https://claude.ai/install.sh | bash` under `zsh -l -i`
  with a fresh temporary `HOME` and `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, then the home's
  files listed and `command -v claude` run through both shells.)

- **A fresh install shows the first-run "Select login method" page even when
  `CLAUDE_CODE_OAUTH_TOKEN` is set** — the token is used (the process fetched
  `~/.claude/policy-limits.json` with it) but the onboarding still asks. The page is
  gated on `hasCompletedOnboarding: true` in `~/.claude.json` (key read off the 2.1.263
  binary with `strings`; the same key is `true` on a machine that has been through the
  page). Measured 2026-09-08 on a bare Ubuntu 24.04 container, CC 2.1.263.

- **The very first run on a machine draws the old flow layout (prompt right under the
  output, no alternate screen); every later run uses the full-screen layout with the
  prompt at the bottom.** The layout is gated by the server-side feature flags CC
  caches in `~/.claude.json` (`cachedGrowthBookFeatures` and friends): with a fresh
  `~/.claude.json` the process decides the layout before the flags arrive; bisected
  on the machine by copying ONLY those cached-flag keys into an otherwise fresh
  `~/.claude.json`, which restored the full-screen layout (tmux `alternate_on` 0 → 1).
  A resize does not re-decide it; a restart of the session does. The flag values come
  from the server, so they cannot be written by hand; that a short `claude -p` run
  fetches and caches them before the first interactive run is inferred, not checked.
  Measured 2026-09-08, CC 2.1.263, Ubuntu 24.04 container.
  **On 2.1.296 on macOS the first run waits for the flags instead:** with a fresh
  `~/.claude.json` (only `hasCompletedOnboarding` and a trusted folder) and an OAuth token,
  `cachedGrowthBookFeatures` landed in the file 0.65 s after spawn and the alternate
  screen (`ESC[?1049h`) came 0.02 s later; with the network cut (`HTTPS_PROXY` to a dead
  port) nothing was drawn in 10 s. `claude -p ok --max-turns 1 --no-session-persistence`
  wrote the flags in about 3 s and left no transcript. (2026-10-11, Python pty probe.)
- **The first-run page on macOS is the text-style (theme) picker**, and
  `hasCompletedOnboarding: true` skips it: the same fresh install then opened on the
  folder-trust question. (2026-10-11, CC 2.1.296, macOS 27, pty probe with no login.)

Koloft dependents: `ensure.sh` in `src/main/remote/install.ts` (installs bash first —
through `sudo` unless root or Homebrew — pipes the install script to plain `bash`,
never through `sudo`, and treats node as a separate, non-fatal step); `tabs/<tab>.sh` in
`src/main/remote/launch.ts`, only when Koloft itself supplied the login, writes the
onboarding flag and runs `claude -p ok --max-turns 1` once when
`cachedGrowthBookFeatures` is missing. Locally, `src/main/toolInstall.ts` runs the script
in a terminal tab and puts `~/.local/bin` at the end of Koloft's own PATH, and
`launchClaude` in `src/main/host/localHost.ts` writes only the onboarding flag (no
warm-up, per the 2.1.296 bullet above).

## §11 Session registry (`~/.claude/sessions/`)

How established: the shape from two entries looked at on this Mac, 2026-09-18, CC
2.1.276, re-read on 7 entries 2026-09-24, CC 2.1.281; the lifecycle from 7 live
sessions plus a tmux probe, 2026-09-23, CC 2.1.281 (bullets below).

- **A session writes `~/.claude/sessions/<pid>.json`** with keys `pid, sessionId,
  cwd, startedAt, procStart, version, peerProtocol, peerFeatures, kind, entrypoint,
  pidDomain, messagingSocketPath, name, nameSource, nameSince, status, updatedAt,
  statusUpdatedAt`. Values seen: `kind: 'interactive'`, `entrypoint: 'cli' | 'sdk-cli'`,
  `nameSource: 'derived' | 'user' | 'auto'`, `status: 'busy' | 'idle'`. A sibling
  `<pid>.<sha256>.key` sits next to each one. Re-read 2026-09-24 on CC 2.1.281: 7
  entries, the same 18 keys, `entrypoint: 'sdk-cli'` on 3 of them. A daemon-hosted
  session adds `kind: 'bg'` and a `jobId` key (bullet below and §5).
- **On Linux `procStart` is a number and a session in tmux adds a `tmux` key.** 2026-10-29,
  CC 2.1.312 (linux-arm64) in tmux on a Debian bookworm machine: `"procStart":"54022809"`
  (not the `ps -o lstart=` text below), `"tmux":"cc:@0.%0"`, `"pidDomain":
  "linux::pid:[4026532380]"`, `"messagingSocketPath":"/tmp/cc-socks/60.sock"`, one entry
  per file on one line; the other keys as on macOS.
- **A `/fork` copy writes one too, with `kind: "bg"` and a `jobId`** (2026-10-27, CC
  2.1.311, §5), so a live entry for an id can belong to a background copy that
  `claude --resume` would attach to rather than run twice.
- **A `claude -p` run writes an entry too** (`kind: "interactive"`, `entrypoint:
  "sdk-cli"`, busy then idle, removed on exit). For `claude -p --resume <id>` of a
  `/rename`d session, on 2.1.309 the entry takes the session's title with `nameSource:
  "auto"` about 50 ms after it appears; on 2.1.308 it kept the derived name
  (`nameSource: "derived"`) for the whole run. A later interactive `--resume` showed
  `nameSource: "user"` on both (2026-10-23, CC 2.1.308 and 2.1.309, the registry read
  every 50 ms, 2 runs each).
- **Lifecycle, measured 2026-09-23 on CC 2.1.281** (7 live sessions plus a tmux probe):
  - Every live interactive session had an entry, and its `sessionId` was the id it was
    running, a resumed id included.
  - `/clear` rewrites `sessionId` to the new id within seconds.
  - A SIGTERM'd claude removes its entry; so does a tmux kill.
  - **Closing its terminal removes the entry within ~0.02 s**, and the process is gone
    within ~1 s (two runs, 2026-09-29, CC 2.1.285: a python pty whose master fd was
    closed, the way Koloft's own exit closes every tab). So a Koloft that relaunches
    does not find its last run's sessions still registered.
  - A `kill -9`'d claude **leaves its entry behind**.
  - **`status` is `waiting` exactly while a dialog, panel or menu is open** (2026-10-04/05,
    CC 2.1.289 and 2.1.290): the `/model` and `/resume` pickers, the "Switch model?"
    confirmation, the panels `/cost`, `/usage`, `/status`, `/help` and `/config` open,
    and the rewind menu. It went back to `idle` about 0.1 s after the Esc that closed
    one, and it stayed `idle` through 130 s at an idle prompt, including after the
    `idle_prompt` Notification. `busy` while a turn, a local command or a compaction
    runs. A reply that says "waiting on you" mid-sentence leaves it `idle` (0.1 s after
    Stop and for 6 s after, 3 interactive runs each on 2026-10-28, CC 2.1.311 and
    2.1.312, the same 18 keys); the binary sets `waiting` only from what is open on
    screen, never from the message text, so the 2.1.312 changelog's "showing as waiting
    on you" fix is the agent view's count, not this field.
  - `procStart` is `ps -o lstart=` for that pid printed in UTC (`TZ=UTC`,
    e.g. `Wed Sep 23 20:29:08 2026`). So "pid alive and its UTC `lstart` equals
    `procStart`" tells a live entry from a stale one whose pid was reused. Re-checked
    2026-09-24 on CC 2.1.281: `TZ=UTC ps -o lstart= -p <pid>` equalled `procStart`
    for 7 of 7 entries.

Koloft dependents: `src/main/claudeSessionRegistry.ts`, read before resuming a
session; `restoreOpenTabs` in `src/main/index.ts`, which starts the Keep running
sessions once at launch and does not retry one found still registered.

## §12 The interactive TUI inside a terminal

Unless a bullet names a version or a measurement, it is inferred, not checked.

- **Every TUI frame is wrapped in DEC mode 2026** (`?2026h` … `?2026l`, synchronized
  output), so while claude streams, a sync window is open much of the time and a
  terminal resize very often lands inside one (verified in the 2.1.232 binary).
- **The XTVERSION reply picks the wheel-scroll engine.** A reply naming
  `xterm.js(<version>)` (which xterm ≥ 6.1.0-beta sends) switches fullscreen wheel
  scrolling to a paced drain of 2–3 lines per frame; no reply keeps the native profile,
  which drains in step with the input. claude also skips its DEC-2026 probe when
  `TERM_PROGRAM=Apple_Terminal`; "no XTVERSION reply" is the other half of that gate.
- **Fullscreen claude turns on mouse and focus reports, and loses a mouse report cut
  in two with another written in between.** Measured 2026-10-13, CC 2.1.296,
  `"tui": "fullscreen"`, a python pty in a scratch `HOME`, the input box read back
  through `pyte`. At start it sends `?1000h ?1002h ?1003h ?1004h ?1006h` (1003: a
  report on every mouse move). An SGR report (`ESC[<0;79;45M`) left the input box
  empty when written whole, before the TUI was up, in a flood of 2000, during a resize
  of a long resumed transcript, or cut at any byte with 0.3–2.5 s before the rest. Cut
  after `ESC[<0` with a whole `ESC[<35;61;45M` written in the gap, `;79;45M` stayed in
  the box as typed text; cut after `ESC[<` it left `<0;79;45M`, after `ESC[<0;79` it
  left `;45M`.
- **Cell widths follow Unicode 11 tables** (Ink / string-width). A terminal using other
  tables makes wide CJK and emoji drift and clip at the right edge.
- **A bare LF (`\n`, the same as Ctrl+J) inserts a newline in the input box; CR
  submits.** Measured 2026-10-03, CC 2.1.288, a pty in a scratch `HOME`: one write of
  three lines joined by LF showed as one three-line input, and a CR in a second write
  0.4 s later sent it as one `user` record whose `content` kept the `\n`s.
- **Text typed into the input box and the CR that sends it must be two writes.** One
  write of 63 bytes or more that ended in CR put a newline in the box instead of
  sending; the text first and the CR in a second write 0.3 s later sent texts of 120 and
  300 bytes. Recorded from the Discord design round's probe notes (2026-10-02, CC
  2.1.286); the setup was not re-run here.
- **Typing while claude is in the middle of a turn queues the message**: the screen
  shows "Press up to edit queued messages", and claude takes it once the running tool
  call ends, in the same turn (a `queued_command` attachment, §2). Recorded from the
  same probe notes (CC 2.1.288); not re-run here.
- **A slash command typed into the box runs as the command; the same text sent between
  sessions does not** (2026-10-04/05, CC 2.1.289 and 2.1.290, real claude in a pty in a
  scratch `HOME`, text then Enter 0.3 s later; the Linux build over `ssh -tt` into tmux
  did the same for `/compact` and `/clear`). `/compact`, `/clear`, `/context`, `/model
  haiku` and a `~/.claude/commands/<n>.md` command ran; one sent on the messaging socket
  (§13) reached the model as text. Typed while a turn runs, each was queued and ran
  right after the turn.
- **Enter runs the command menu's highlighted entry, not the typed text**: `/co` +
  Enter would run `/copy` and `/con` + Enter opened `/config`, with or without a
  trailing space. A misspelling that only fuzzy-matches (`/clera`, `/contxt`) gets no
  highlight and writes "Unknown command: /clera. Did you mean /clear?". **Esc after the
  text closes the menu and keeps the text, and Enter then submits exactly that**:
  `/con`, Esc, Enter gave "Unknown command: /con"; `/context`, `/clear`, `/compact `,
  `/compact <args>` and `/model haiku` with Esc before Enter ran as typed. With no menu
  open (a command with arguments), that Esc only shows "Esc again to clear"; one Esc at
  an empty box does nothing, a second one opens the rewind menu.
- **That Esc and the Enter after it must reach claude in two reads, or the Enter is
  lost.** Measured 2026-10-19, CC 2.1.303, real claude in a python pty (120×40) in a
  scratch `HOME`, logged in with `CLAUDE_CODE_OAUTH_TOKEN`, `--dangerously-skip-permissions`,
  stub hooks and a status line, the screen read back through `pyte`: `/context`, then
  `ESC` and CR in one write 0.3 s later, closed the command menu, left `/context` in the
  box ("ctrl+g to edit in VS Code" showed above it) and wrote nothing to the transcript,
  in 3 of 3 tries with a background subagent running and 2 of 2 without one; with the
  CR 20 ms after the `ESC`, 3 of 3 were lost; 60 ms after, 0 of 3. A lone CR later sent
  the command (3 of 3). With the keys 300 ms apart, 40 of 40 tries in that pty ran it.
  Inside Koloft (13 runs of `discord-real-smoke.spec.ts`'s background-subagent `/context`
  case, every pty write and read logged), claude asked for the cursor position
  (`ESC[?6n`) about every 220 ms while a background subagent ran, and in the seconds after
  the subagent started those asks came 377–529 ms apart: claude's event loop stood still
  longer than the 300 ms between Koloft's keys, so both can wait in the pty and be read
  together. That this is what lost the Enter in the nightly failures is inferred from
  their screen (`❯ /context` left in the box under "✻ Waiting for 1 background agent to
  finish"); none of the 13 logged runs lost it.
- **Commands that open a panel or picker write nothing until it closes**: `/cost`,
  `/usage`, `/status`, `/help` and `/config` open a panel and leave no record at all;
  `/model` with no argument and `/resume` open a picker; `/model sonnet` from Haiku asks
  "Switch model?" first (option 1, Yes, highlighted; Esc or `2` keeps the model; a
  typed Enter picks Yes). One Esc closes each, except `/config`, which takes two (the
  first leaves its search box). A closed picker writes `Kept model as …` / `Resume
  cancelled`.
- **A claude ended by a signal leaves the full screen and prints how to resume.**
  Measured 2026-10-09, CC 2.1.295 logged in, inside a Koloft tab: after SIGTERM the
  terminal left the alternate screen, and the normal buffer showed `Resume this session
  with:` / `claude --resume <id>` under the launch line. So the last frame of the
  conversation is gone from a terminal that keeps reading after the kill.
- **The keys the TUI takes, one write each** (2026-10-09, CC 2.1.295, a python `pty`
  (100×40) in a scratch folder, through Koloft's shim with `KOLOFT_HOOK_SETTINGS` unset,
  about 1 s between writes, the screen read back through `pyte`): in the input box
  `abcd`, `ESC[D` twice and `DEL` (0x7f) left `acd`; `ESC[C`, `X`, a space and `Y` made
  `acX Yd`. `ESC[Z` (Shift+Tab) moved the footer from "bypass permissions on" to "auto
  mode on". `/mod` then Tab completed to `/model `; CR opened its picker, where `ESC[B`
  moved the `❯` mark down one entry (from the last entry it wrapped to the first),
  `ESC[A` moved it up, and ESC closed it with "Kept model as …". The same keys through
  ssh and tmux to a remote claude are not probed.
- **URLs and files are opened with `Bun.spawn(["open", url])`**, which looks `open` up
  on PATH, so a PATH shim can catch it.
- **Since 2.1.295 claude can tell its terminal whether it is working, waiting or done
  (OSC 7501, "Program Status Protocol"), but only to a terminal that answers its
  query.** Read from the 2.1.296 binary (`strings`, 2026-10-11; not run): at startup
  it writes `ESC ] 7501 ; ? BEL` next to its XTVERSION query, and only a reply that is
  an OSC 7501 whose data starts with `?` turns the reports on — no env var, setting,
  `TERM_PROGRAM` or DA reply takes part, and `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` or a
  background worker (`CLAUDE_CODE_SESSION_KIND=bg`) skips the query. Then, on every
  change, `ESC ] 7501 ; state=<s>:app=claude-code[:id=<id>][:kind=<k>][:progress=<n>]
  [:title=<base64>][:msg=<base64>] BEL` (ST instead of BEL under kitty): `working` (a
  turn runs, or idle with a queued message), `blocked` (waiting on the person; `kind`
  `permission` for a permission, sandbox, worker or goal dialog, `question` for an MCP
  elicitation, `auth` for a login error), `done` (last turn completed), `idle` (no turn
  yet, or the last one stopped), `error`; background tasks and subagents report under
  their own `id`, a gone one gets `state=clear:id=<id>`, and exit writes a bare
  `state=clear`. The sequence is not wrapped for tmux (the DCS passthrough wrapper is
  not applied), so whether it crosses tmux to the outer terminal is not probed; in or
  out of fullscreen alike (read, not run). The 2.1.299, 2.1.301, 2.1.302, 2.1.303,
  2.1.304, 2.1.306 and 2.1.308 binaries carry the same builder (`app=claude-code`, `id=`,
  `kind=`, `progress=`, a base64 `title=` capped at 192, `msg=` capped at 2048), states,
  kinds and startup probe (`strings`, 2026-10-14, 2026-10-16, 2026-10-17, 2026-10-19,
  2026-10-20, 2026-10-21 and 2026-10-22; on 2.1.306 only the builder pieces and the
  startup probe's strings were counted, equal to 2.1.304's; on 2.1.308 the builder code,
  minified names evened out, equals 2.1.306's). On 2.1.310 the sequence is still written
  unwrapped; the tmux passthrough that release added (for a mod's `Image`) is the image
  renderer's own wrapper (`strings`, 2026-10-25). The name "Program Status" came only from the changelog the binary
  carries, which in 2.1.306 covers 2.1.296–2.1.304, so it is no longer in its strings.
  Since Codex CLI 0.163.0 the Codex TUI writes OSC 7501 too, with no query first and
  only `state` and `app=codex` (`docs/codex-cli-contract.md` §25).
- **Since 2.1.305 a permission rule that does nothing shows as a warning row under the
  banner, and the long warning goes to the debug log.** On 2.1.306 a deny
  `Write(/etc/**)` drew `⚠ Deny rule Write(/etc/**) never matches · use Edit(/etc/**)`
  (amber) under the banner, in default and fullscreen mode alike, and the long
  `Permission deny rule (<settings path>): Write(/etc/**) is not matched by file
  permission checks …` became a `[WARN]` line in `--debug-file`; on 2.1.304 that long
  text was printed in yellow into the pty before the TUI, with no row. An allow
  `Bash(npm * install)` drew `⚠ Allow rule Bash(npm * install) allows any option at its
  * · use an exact value`. Koloft's own allow `Bash(koloft *)` draws no row and no
  `[WARN]`, nor do `Bash(*)` and `Bash`; `Bash(:*)` and `*` in allow open the blocking
  "Settings Warning" dialog instead (run on 2.1.306 only). No Koloft screen reader looks at the
  banner: `inputBoxDraft` still finds the input box (the last two `─` rules and the `❯`
  row between them) on a 2.1.306 screen with such a row. Measured 2026-10-21 on CC
  2.1.304 and 2.1.306, a python pty 120×40 drawn through `pyte`, a scratch `HOME`,
  `--settings` with Koloft's hooks and `permissions.allow: ["Bash(koloft *)"]`,
  `--plugin-dir`, `--append-system-prompt-file`, `--session-id` and `--model haiku`;
  the other row shapes the 2.1.306 strings name were not run.
- **An idle claude process holds a lot of memory**: measured 185–350 MB each for idle
  processes about two days old (date and CC version not recorded). On 2026-09-24, CC
  2.1.281, four live sessions (not idle, 20 min to 4 h old) held 196–403 MB each
  (`ps -o rss`). On 2026-10-09 (CC 2.1.295 on PATH), seven idle sessions 1–8 h old held
  211–307 MB RSS (three of them measured with `footprint`: 255–271 MB) and used 1.8–5.3 s
  of CPU in 5 minutes (0.6–1.8% of one core) — the process, not Koloft's watching of it,
  is what an idle session costs.

## §13 Handing a session extra skills, context and a command allow rule; messaging between sessions

How established: 2026-09-26, CC 2.1.283, on this Mac. Each launch route was run with
`claude -p … --output-format stream-json --verbose --model haiku --strict-mcp-config
--mcp-config <empty>` in a scratch folder, and the check was a made-up word that only
the injected text held: the model had to say it back, and the `system/init` record's
`skills` and `plugins` lists were read. The same day, one interactive claude (a pty,
`--permission-mode default --plugin-dir <dir> --settings <file with the allow rule>` and
a first prompt) called `Skill(koloft:koloft)`, said back its word, and ran `koloft …`
through Bash with no approval prompt, so those two routes hold interactively too; the
other three were run in `-p` only. The messaging lines below were run in interactive
sessions.

- **`--plugin-dir <dir>` loads a plugin with no install step.** A folder holding
  `.claude-plugin/plugin.json` (`{"name":"koloft",…}`) and `skills/<n>/SKILL.md` showed up
  as `plugins: [{name:"koloft", source:"koloft@inline"}]` and
  `skills: ["koloft:<n>"]`. The model called the skill through the Skill tool and read
  its body.
- **An interactive session's transcript lists the skills it was handed** (2026-10-10,
  CC 2.1.296 for Linux arm64, an interactive claude on a Docker ssh machine, read off its
  jsonl): an `attachment` record `{type:"skill_listing", content}` whose `content` holds one
  `- <name>: <description>` line per skill, `- koloft:koloft: …` among them. Since
  2.1.304 the attachment also carries a `digests` array, and which skills were already
  sent is read from the attachments still in the conversation, so a compaction sends
  the list again (the changelog line; `strings`, 2026-10-20, not run). Koloft's e2e
  helper reads only `type` and `content`.
- **`--add-dir <dir>` also loads `<dir>/.claude/skills`**, listed without a prefix
  unless another skill (a user skill, say) already holds the name: since 2.1.309 it is
  then offered as `<folder>:<name>`, and CC adds ` (scoped to <folder>/ — use this
  instead of the unscoped "<name>" skill when the files being changed are under
  <folder>/)` to its `skill_listing` description; 2.1.308 left it out. A `--plugin-dir`
  skill is `<plugin>:<name>` on both builds, beside a same-named user skill (2026-10-23,
  `claude -p` init `skills` and `skill_listing` in a scratch `HOME`). It also opens that
  folder to the model's file tools. Koloft passes no `--add-dir` to claude, only
  `--plugin-dir`.
- **A SessionStart hook's `hookSpecificOutput.additionalContext`** (given through a
  `--settings` file) reached the model.
- **`--append-system-prompt-file <file>`** reached the model.
- **`permissions.allow: ["Bash(koloft *)"]` in a `--settings` file lets that command run
  in `--permission-mode default`**; without it the same call was denied ("This command
  requires approval") in `-p`. A command with arguments (`koloft note append "hello
  world"`) matched too.
- **Sessions on one machine can message each other.** A second interactive claude
  started with `-n <name>` showed up in another session's `ListAgents` under that name,
  and `SendMessage` reached it. With no context, the receiver would not act on the
  message: it asked its own user first. When its first prompt said which session had
  started it and that it should report back, it did the task and its `SendMessage`
  reply arrived in the sender. The `SendMessage` tool text says a session in a
  different permission mode holds such messages for its user's approval — read, not
  measured.
- **SendMessage does not reach a session on another machine.** 2026-10-23, CC 2.1.309
  (linux-arm64), two Docker containers on one network, each with its own `HOME`, an OAuth
  token and model haiku. An interactive receiver started with `-n home-session`
  registered with a messaging socket under `/tmp/cc-socks/`. A `claude -p` in the same
  container listed it in `ListAgents` and its `SendMessage` was delivered (the text
  reached the receiver's transcript). A `claude -p` in the other container got
  `ListAgents`: "No reachable agents — no other Claude session is running on this
  machine right now", and `SendMessage` to `home-session`: `{"success":false,"message":
  "No agent named 'home-session' is reachable."}`; nothing reached the receiver. Claude's
  own way across machines, Remote Control, refuses the token Koloft injects (§7).
- **A line written from the Mac with `ssh -W <messagingSocketPath> <host>` reaches a
  session on that machine** as one written on its own machine does. 2026-10-29, CC 2.1.312
  (linux-arm64) in the e2e SSH lab image (Debian bookworm, OpenSSH 9.2 sshd), the Mac's
  OpenSSH 10.3; an interactive `--dangerously-skip-permissions` receiver in tmux, model
  haiku, an OAuth token. Its registry entry (§11) gave `/tmp/cc-socks/<pid>.sock`. Five
  `bypass` envelopes, each one line on ssh's stdin: idle, it showed "Message from @peer: …"
  and answered; written while a 20 s Bash call ran, it was folded into that turn and
  answered at its end; written with a half-typed line in the box, it started its own turn
  and the half-typed line stayed in the box. It went through a fresh connection, through a
  ControlMaster another ssh had opened, and with Koloft's own option set
  (`RemoteCommand=none`, `RequestTTY=no`, `ControlMaster=auto`, `ControlPersist=yes`,
  `BatchMode=yes`) with no master yet, which left one behind; ssh exited 0 each time. The
  transcript held the same `origin: {kind:"peer", fromMode:"bypass", body, verifiedPeerPid}`
  as on one machine, `verifiedPeerPid` being sshd's process for that connection (the same
  pid for every line through one master). A path with no socket behind it made ssh exit
  255 with "Stdio forwarding request failed: Session open refused by peer" — the words
  ssh also prints when a master has no room left (platform ledger §33).
- **How a message from another session lands in the receiver's transcript** (2026-10-02,
  CC 2.1.288, interactive sessions in a scratch `HOME`, the message sent as one
  `{"type":"user",…}` line to the receiver's `messagingSocketPath`, §11). When the
  receiver was idle: a `user` record with `isMeta: true`, `origin: {kind:"peer",
  from:"unknown", verifiedPeerPid}`, `turnOrigin: "peer"`, and the text wrapped as
  `"Another Claude session sent a message:\n<text>\n\nThis came from another Claude
  session — not typed by your user, …"`. When the receiver was in the middle of a turn: no
  `user` record; a `queued_command` attachment (shape in §2) with `origin.kind: "peer"`
  and `isMeta: true`, whose `prompt` holds the bare text. A sweep of 80 recent
  transcripts on this Mac (CC 2.1.285–2.1.288, 2026-10-03) found 4 `user` records with
  `origin.kind: "peer"`, all `isMeta: true`.
- **A receiver started with `--dangerously-skip-permissions` holds a message whose sender
  does not say it runs the same way.** Measured 2026-10-02, CC 2.1.288, four interactive
  receivers in a scratch `HOME`, each sent one line on its socket while idle; re-run
  2026-10-03, CC 2.1.288, with Koloft's own writer (`src/main/crossSessionMessage.ts`)
  against one logged-in receiver:
  - content `<cross-session-message from-mode="bypass">` + `\n` + body + `\n` +
    `</cross-session-message>`: delivered — the screen showed "Message from @peer: …" and
    a turn started; the logged-in receiver did what the body asked. The transcript keeps
    the envelope inside the usual "Another Claude session sent a message:" wrap.
  - The same `bypass` line sent while that receiver was running a 15 s Bash command was
    taken into the running turn and answered there: a `queued_command` attachment whose
    `prompt` holds the whole envelope and whose `origin` adds `fromMode: "bypass"` and
    `body` (the bare body). Re-run 2026-10-23 on CC 2.1.308 and 2.1.309 (one
    interactive bypass receiver each, the line written while a `ping -c 25` Bash call
    ran): both wrote the same record kinds — that `queued_command` attachment (now also
    with `delivery_id` and `reminderId`) and a `queue-operation` `enqueue`/`remove` pair
    whose `content` is the whole envelope. The 2.1.309 change is on screen only: ctrl+o
    shows the message under the transcript as "Waiting to be delivered"; 2.1.308's ctrl+o
    view did not show it.
  - the same with `from-mode="prompting"`, or a bare body, or `"from_mode":"bypass"` as a
    field beside `message`: held — "Held peer message … The sending session's permission
    mode class doesn't match this session's", and a "Held message from another session"
    dialog with two choices, "Deny" (selected) and "Deliver this message to Claude".
  - The two classes are `bypass` and `prompting`. The 2.1.288 binary counts a session as
    `bypass` when its mode is `bypassPermissions`, or when a second check passes that
    takes the mode and whether bypass mode is available
    (`e.mode==="bypassPermissions"||IW(e.mode,e.isBypassPermissionsModeAvailable)`);
    what that second check accepts was not read.
  - The binary only accepts the envelope when it matches its own pattern exactly
    (attributes in a fixed order, a newline right after `>` and right before `</`).
  - It is switched by the internal gate `tengu_harbor_kite_mode_emit`, default on
    (`T("tengu_harbor_kite_mode_emit",!0)` in the 2.1.288 binary); recheck on upgrade.
    Still on in 2.1.299, and the pattern there allows, in this order and each optional,
    `from`, `from-session`, `hop-chain`, `from-name`, `from-mode` (`bypass` or
    `prompting`) and `from-plugin`, then `\n`, the body, `\n</cross-session-message>`;
    the receiver's limits read `bucketCapacity:30, refillPerSecond:0.5,
    dedupWindowMs:30000, maxSelfHops:10, maxChainLength:28, maxTrackedSenders:256`, the
    same as 2.1.296 (`strings`, 2026-10-14). Still on in 2.1.309, with the same
    pattern, wrap text and limits (`strings`, 2026-10-23).
  - A busy receiver with a mismatched mode, and a receiver not in bypass mode, were not
    tried.
- **A message reaches a receiver whose turn ended with background work still running.**
  2026-10-08, CC 2.1.294, interactive receivers in a pty with a scratch `HOME` and an
  OAuth token, `--dangerously-skip-permissions`, model haiku. One receiver's first turn
  started `sleep 90` with the Bash tool's `run_in_background: true` and ended; 5 s later a
  `bypass` envelope written to its socket was answered 1.3 s after the write. A control
  receiver with no background work answered in 1.0 s.
- **Messaging between sessions works with agent teams off.** 2026-10-11, CC 2.1.296, two
  interactive sessions in a pty, both started with `--settings '{"env":
  {"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": ""}}'` (§6), the receiver also with
  `-n <name>`: the sender's `ListAgents` listed the receiver ("interactive · idle"), its
  `SendMessage` was accepted, and the receiver's transcript held the text. The docs page
  on messaging other sessions says it is "on with nothing to enable"; in `claude -p` both
  tools were offered with teams on and off alike.
- **What a receiver does with messages on its socket** (2026-10-11, CC 2.1.296, the socket
  probe: interactive receivers in a pty with a scratch `HOME`, model haiku and opus, a
  `--settings` file with a SessionStart role, a logging `UserPromptSubmit` hook and the
  `Bash(koloft *)` allow rule; each message one `{"type":"user",…}` line on the
  receiver's `messagingSocketPath`, sent by one Python process):
  - **`"crossSessionInbound": "accept"` in the receiver's settings takes a message whose
    claimed mode does not match.** Three receivers, each sent a line asking it to run
    `koloft session list`: bypass receiver with `from-mode="prompting"`, `default`
    receiver with `bypass`, `auto` receiver with `bypass` — all three ran it (3 of 3). The
    same `default`/`bypass` pair without the setting held the message and ran nothing.
  - **A body identical to the one before it from the same sender is dropped, with no
    error to the sender.** Three sends of one body: the second, 2 s after the first, made
    no turn and the transcript got a `system` record "Dropped a peer message from unknown:
    identical to the previous message from this sender."; the third, 31 s after the
    first, was taken. Four sends differing only in a last line holding an id were each
    taken. The 2.1.296 binary has `dedupWindowMs:30000` and compares only with that
    sender's last body (read, not run).
  - **A sender may send 30 at once, then one more every 2 s; the rest are dropped** —
    read from the 2.1.296 binary, not run: `bucketCapacity:30, refillPerSecond:0.5`,
    drop reason `"rate-limited"` ("sender exceeded the peer message rate limit"), kept per
    sender by the receiver.
  - **A message fires `UserPromptSubmit`, idle or busy, and the hook's `prompt` holds
    the whole envelope**: `<cross-session-message from-mode="bypass">\n<body>\n</cross-session-message>`.
    Sent while a typed turn was running a slow command, it was folded into that turn as a
    `queued_command` attachment (`origin.kind: "peer"`), and its `UserPromptSubmit` input
    carried the same `prompt_id` as the typed prompt that started the turn.
  - **The input box is left alone.** With a half-typed line in an idle receiver's box, a
    message started its own turn; Enter pressed after that turn sent the half-typed line
    whole, as a prompt of its own. The same check while the receiver was busy was run but
    its result was not kept.
- **Esc that interrupts a running turn fires no `Stop` hook.** 2026-10-11, CC 2.1.296,
  model haiku, temp HOME, a `Stop` hook that appends to a file: a typed turn running
  `ping -c 30 127.0.0.1` was interrupted with Esc 6 s in; the session went `idle` and the
  file stayed empty. (A standalone `sleep 30` is refused by CC itself — "Blocked:
  standalone sleep" — and ends the turn at once, with a `Stop`.) So a typed turn's
  `<tab>.typed` mark outlives an Esc until the next typed turn's `Stop`.
- **Only the last `--append-system-prompt-file` reaches the model.** 2026-10-11, CC
  2.1.296, `claude -p`, model haiku, two files each holding one made-up word: given two
  `--append-system-prompt-file` flags the model knew only the second file's word. Given
  one `--append-system-prompt-file` and one inline `--append-system-prompt`, it knew both
  words.

## §14 The PermissionRequest hook: answering a dialog from outside

How established: 2026-10-03, CC 2.1.288, interactive claude in a pty with a scratch
`HOME`, model haiku, a `--settings` file whose `PermissionRequest` entry (matcher `"*"`)
ran a logging script, next to logging `PreToolUse` and `PostToolUse` hooks. Each line
below was one run.

- **It fires the moment claude draws a dialog that waits on the person.** Its input has
  `session_id`, `transcript_path`, `cwd`, `permission_mode`, `prompt_id`,
  `hook_event_name: "PermissionRequest"`, `tool_name` and `tool_input` — and no
  `tool_use_id` (`PreToolUse` and `PostToolUse` carry one).
- **With `--permission-mode bypassPermissions`, `AskUserQuestion` and `ExitPlanMode` still
  fire it; `Bash` does not** (it ran with no dialog).
- **An `AskUserQuestion` is answered by the hook's output, with no key press:**
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":
  "allow","updatedInput":{…tool_input,"answers":{"<question>":"<label>"}}}}}`.
  `PostToolUse` then showed those `answers` in `tool_response`.
- **An `ExitPlanMode` needs `updatedInput`:** a bare `{"behavior":"allow"}` was ignored
  with no error and the dialog stayed; `allow` with `updatedInput` set to the
  `tool_input` unchanged approved the plan, and claude went back to the mode it had
  before plan mode.
- **`{"behavior":"deny","message":"<text>"}`** hands claude the text; it carries on and
  `Stop` fires at the end of the turn.
- **A hook may wait for the answer.** One that answered after 120 s with
  `"timeout": 900` took effect. At its `timeout` (20 s in one run) claude ends the hook
  with SIGTERM and the dialog stays on screen; nothing is denied.
- **After a hook's timeout the dialog still takes its keys.** 2026-10-22, CC 2.1.309, a
  python pty, scratch `CLAUDE_CONFIG_DIR`, haiku, `--dangerously-skip-permissions`, a
  `PermissionRequest` hook with `"timeout": 5` that logged its start, SIGTERM and exit
  and then waited; 1 run. An `AskUserQuestion` (Red / Green): the hook started 2.0 s after the
  prompt, got SIGTERM at +7.0 s and exited 20 ms later; 10 s on, the dialog was unchanged on
  screen. `3` ("Type something."), then `Purple with green stripes` in a second write,
  then CR 1 s later answered it: `PostToolUse` held `answers: {"Which colour do you
  prefer?": "Purple with green stripes"}` and the model repeated it.
- **A hook that gives up by itself, with no output, while its dialog is on screen
  leaves the dialog to the person too.** 2026-10-22, CC 2.1.309, the same setup with
  `"timeout": 30` and a hook that waited 5 s by bash's `SECONDS`, then exited 0 printing
  nothing; 1 run. It got no SIGTERM; 10 s after it exited the dialog was unchanged, and
  `3`, the text, then CR 1 s later answered it the same way (`PostToolUse` held the
  typed answer). A `Bash` dialog did the same (`--permission-mode default`, 1 run): after
  the hook gave up, the dialog (`1. Yes` … `4. No`) stayed, the command did not run, and
  `1` 10 s later ran it. Unlike ending at the `timeout`, this never looks like the
  SIGTERM that "No" or Esc at the Mac sends (below).
- **When the person answers in the terminal first:** "No" or Esc ends the hook with
  SIGTERM at once (its `EXIT` trap ran); "Yes" does not signal it, and it lived on until
  claude exited. What it prints after that is ignored. Re-run 2026-10-04, CC 2.1.289
  (scratch `HOME`, haiku, `--permission-mode default`, a hook that logged its start and
  any SIGTERM and then waited): `1` on a `Bash` dialog ran the command, and 15 s later the
  hook was still alive with no SIGTERM logged.
- **A hook still waiting when the session ends can make claude skip every SessionEnd
  hook.** 2026-10-06, CC 2.1.291, a pty, haiku, `--dangerously-skip-permissions`,
  Koloft's hook settings with the `.answerable` marker present: an `AskUserQuestion`
  answered `1` in the terminal (Koloft's `ask` hook kept waiting), one more turn, 60 s
  idle, then `/exit` — claude exited with code 0 after 0.5 s and no SessionEnd hook ran
  (neither Koloft's nor a second logging one), 2 runs out of 2. The same run with the
  waiting hook ended by SIGTERM just before `/exit` fired SessionEnd
  `prompt_input_exit`. `/exit` 3 s after the answer, with no turn between, fired it
  too (1 run). Seen live in Koloft three times the same night: the first `/exit` of a
  session that had answered a question in the terminal left its row cold. **On 2.1.300
  the SessionEnd hook ran**: the same shape (a `PermissionRequest` hook that printed
  nothing and waited, `2` typed in the terminal, one more turn, 5 s idle, `/exit`) ended
  the waiting hook with SIGTERM and fired SessionEnd `prompt_input_exit` 0.1 s later,
  exit code 0 about 2 s after Enter (2026-10-15, python pty, scratch `HOME`, haiku, 1
  run; the 2.1.300 changelog: "Fixed SessionEnd hooks sometimes not running when you
  exit while a background command is still running").
- **A hook's `updatedInput` is checked against the tool's own input schema since
  2.1.300** (changelog: "unknown keys are dropped, and input the tool rejects denies the
  call"). 2026-10-15, python pty, scratch `HOME`, haiku, `--dangerously-skip-permissions`,
  a `PermissionRequest` hook answering an `AskUserQuestion` ("Pick a colour", Red /
  Green), one run each: Koloft's shape (`{…tool_input, answers: {"<question>":
  "Green"}}`) was taken as before — `PostToolUse` showed `answers` in `tool_input` and
  `tool_response`, the model replied "you picked Green"; the same with an extra
  `bogusKey: "x"` — taken, and the key gone from `PostToolUse`'s `tool_input`; with
  `answers` set to a string the call was denied, the model saw "PermissionRequest hook
  for AskUserQuestion returned updatedInput that failed schema validation: … The
  parameter `answers` type is expected as `record` but provided as `string`. The tool
  input from the model was valid; the hook's rewrite of it was not." (`Denied by
  PermissionRequest hook`), asked once more, was denied again and gave up. So
  `dialog.ts`'s answer survives, and a malformed one no longer slips through.
- **The transcript's `tool_use` input and the hook's `tool_input` hold the same values
  in a different key order.** One `AskUserQuestion`, 2026-10-06, CC 2.1.291: the hook
  had `question, header, options, multiSelect`, the transcript `question, header,
  multiSelect, options`.
- **A hook that exits at once with no output** leaves the dialog to the person, as if
  there were no hook. Run 2026-10-04, CC 2.1.289, through Koloft (the
  `discord-real-smoke` case "with Discord off"): Koloft's hook script left before reading
  its input, the `AskUserQuestion` dialog drew as usual, `2` picked the second option (the
  `tool_result` held it), and the turn ended.
- **With no permission flag and no setting, a fresh `HOME` starts in `auto` mode**
  (2026-10-04, CC 2.1.289, interactive: the transcript's `permission-mode` record said
  `"auto"`), and in it a `Bash` `touch` ran with no dialog. `permissions.defaultMode:
  "default"` in `~/.claude/settings.json` brought the dialog back. **For `claude -p` the
  start mode hangs on the cached server flag `tengu_moss_anchor`, and only a config dir
  with no cache yet differs between 2.1.301 and 2.1.302** (2026-10-17, seven `-p` runs,
  haiku, `--max-turns 3`, a scratch `CLAUDE_CONFIG_DIR` holding only a `.claude.json` with
  onboarding done and the folder trusted, no `settings.json`, the OAuth token in the env,
  asked to run `touch … && echo …` with Bash): a never-used dir got `auto` on 2.1.301 (the
  `touch` ran) and `default` on 2.1.302 (denied, `permission_denials` holds the Bash call);
  the same dir used a second time, its cache now holding `tengu_moss_anchor: false`, got
  `default` on both — the flag is read from the cache, not fetched for the launch, so an
  install that has run before sees no change on upgrade. With `DISABLE_TELEMETRY=1` and
  `CLAUDE_CODE_ENABLE_TELEMETRY=0` a fresh dir got `default` on 2.1.302 and wrote no flag
  cache; `--permission-mode auto` still gives `auto`. This is the 2.1.302 changelog's
  "`claude -p` … with no permission mode … start in `default` mode on third-party
  providers, with telemetry off or on a fresh install" (third-party provider not run): in
  the strings the parser's fallback for a missing cache went from `k("tengu_moss_anchor",
  !0)` to `k("tengu_moss_anchor", !1)`. A `-p` run writes no `permission-mode` record on
  either build; its mode is the first `user` record's `"permissionMode"` and the
  `stream-json` init line. Koloft runs `claude -p` twice and its shim adds no permission
  flag to a `-p`: the Assist (`src/main/assist.ts`) passes `--tools ''`, so there is no
  tool to deny; the remote install's warm-up `claude -p ok --max-turns 1`
  (`src/main/remote/launch.ts`) asks for no tool, and the SSH lab runs that very warm-up
  on a fresh linux-arm64 2.1.302 before E-SSH-10/11/12/15/17/C2, all green (2026-10-17),
  and on 2.1.303 (2026-10-19) and 2.1.304 (2026-10-20; on both the `tengu_moss_anchor`
  fallback and the code around it are the same in `strings`), and on linux-arm64 2.1.306
  before E-SSH-10/11/12/15/17, all green (2026-10-21), and on linux-arm64 2.1.308 before
  E-SSH-10/11/12/15/17/C2, all green, the fallback the same in `strings` (2026-10-22),
  and on linux-arm64 2.1.309 the same again (2026-10-23; the new `tengu_mossy_anchor`
  is a different gate), and on linux-arm64 2.1.310 before E-SSH-10/11/12/15/17/C2, all
  green (2026-10-25), and on linux-arm64 2.1.311 the same (2026-10-27), and on
  linux-arm64 2.1.312 the same (2026-10-28). A user's own `claude -p` in a Koloft terminal is the measured case.
- **The `Notification` hook (`permission_prompt`) comes about 6 s after
  `PermissionRequest`** for the same dialog (7.7→13.8 s, 6.4→12.4 s, 7.0→13.0 s in three
  runs), also for a plan in `bypassPermissions`.
- **Plan mode in a session that has bypass permissions prints a notice, not a dialog.**
  2.1.299 adds the line "Session was started with bypass permissions, so plan mode won't
  ask before most edits or commands. Start a new session without bypass permissions for
  prompts in plan mode.", appended to the conversation 800 ms after plan mode starts,
  once per process, not written to the transcript, with no options and nothing to press
  (read from the 2.1.299 binary, `strings`, 2026-10-14; not run). So a run nobody watches
  does not stall on it.
- **An open `AskUserQuestion` sends one `permission_prompt` Notification and nothing
  after it while it stays open.** 2026-10-11, CC 2.1.296, an interactive claude in a pty
  (python `pty.fork`), haiku, `--dangerously-skip-permissions`, a `--settings` file with
  logging hooks on `PermissionRequest` (printing nothing), `Notification` (matcher
  `permission_prompt|worker_permission_prompt|idle_prompt|elicitation_dialog|elicitation_url_dialog`),
  `UserPromptSubmit` and `Stop`; 1 run. `PermissionRequest` at +1 s, then
  `{"message":"Claude needs your permission","notification_type":"permission_prompt"}` at
  +6 s; the dialog was then left open 330 s and no other Notification came (no
  `idle_prompt`). So a session showing a question stays `approval` for Koloft until it is
  answered.
- **The same holds on 2.1.310, through Koloft, in a scheduled job set to "Close it".**
  2026-10-24, the hand-test sandbox (`npm run handtest`, a real local Claude tab, Sonnet,
  effort low), a job whose task asked one `AskUserQuestion` (Red / Green), started with
  Run now: Koloft's status log got `prompt`, then `ask` (the `PermissionRequest`), then
  `notify` "Claude needs your permission" and nothing else; the row showed `st-approval`
  and the tab, row and worktree stayed for the 300 s the question was left open. `2` typed
  into the tab picked Green; 1.4 s later the toast said the job "finished and closed" and
  the row and the worktree were gone. 1 run.
- **A peer message sent while an `AskUserQuestion` is open waits for the answer.** Same
  run: a `bypass` envelope (§13) written to the session's socket 90 s into the dialog
  drew no reply for the next 240 s; the moment `1` answered the dialog, a
  `UserPromptSubmit` fired and the reply to the message appeared on screen.
- **Koloft's own hook script and answer builder, run by a real claude** (2026-10-03, CC
  2.1.288, scratch `HOME`, haiku, the `PermissionRequest` entry exactly as
  `hookSettings()` writes it, the answer file written by `hookAnswer()`): with
  `--dangerously-skip-permissions`, an `AskUserQuestion` answered `2` showed "→ Green" and
  "Allowed by PermissionRequest hook"; with `--permission-mode default`, a `Bash` dialog
  answered `yes` (`allow` with `updatedInput` set to the `tool_input` unchanged) ran the
  command. Both hooks removed their files on the way out.
- **The keys that answer a dialog in the terminal** (2026-10-03, CC 2.1.288, a pty, scratch
  `HOME`, haiku, `--dangerously-skip-permissions`, a `PermissionRequest` hook that printed
  nothing):
  - an `AskUserQuestion` with one question lists its options as `1.`…`N.`, then
    `N+1. Type something.` and `N+2. Chat about this`. A digit picks that option and sends
    it at once. `N+1`, then the text in a second write, then CR in a third write 1 s later
    sent the text as the answer.
  - a plan (`ExitPlanMode`) offers `1. Yes, and switch to BYPASS PERMISSIONS …` (in a
    session that was in bypass before plan mode; `1. Yes, auto-accept edits` in one that
    was not), `2. Yes, manually approve edits`, `3. Tell Claude what to change`. `1`
    approved it and the session went back to bypass; Esc rejected it ("User rejected
    Claude's plan"), the turn ended and the session stayed in plan mode.
  - a `Bash` dialog (`--permission-mode default`) offers `1. Yes`, `2. Yes, and always
    allow …`, `3. No`; `1` ran it, `3` and Esc refused it (2026-10-02 round, same version).

## §15 The PreToolUse hook stops a tool even when permission checks are skipped

How established: 2026-10-08, CC 2.1.294, one `claude -p` run on this Mac through
Koloft's shim (an account picked by the balancer), `--dangerously-skip-permissions`,
model haiku, an empty MCP config, and a `--settings` file whose `PreToolUse` entry
(matcher `"*"`) ran a logging node script. The script printed
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
"permissionDecisionReason":"<text>"}}` for every call except a Bash command starting
with `koloft`, and printed nothing for that one. The prompt asked for a Bash
`echo x > <file>`, a Write of a second file, then Bash `koloft help`.

- **The hook ran for every tool call, and its input said `permission_mode:
  "bypassPermissions"`.**
- **A `deny` stopped the call in that mode**: neither file was written, and claude got
  the reason back as `PreToolUse:Bash hook error: <text>` and went on to the next step.
- **Printing nothing let the call run** (`koloft help` ran).
- **`permissionDecision: "allow"` runs a Bash call that would otherwise need approval.**
  2026-10-11, CC 2.1.296, `claude -p --permission-mode default`, model haiku, a temp
  folder, an empty MCP config: asked to run `touch <file>`, with no hook claude refused
  ("blocked because it needs approval") and the file was not made; with Koloft's Assist
  gate as the `PreToolUse` hook and an allow file naming `Bash(touch)`, the gate printed
  `allow` and the file was made, with no approval asked.
- **The same holds in an interactive session.** 2026-10-08, CC 2.1.294, the
  `discord-real-smoke` case for a Claude conductor: Koloft's own gate, a pty session
  with `--dangerously-skip-permissions`, asked to write a file — the file was not
  written and the transcript held `PreToolUse:<tool> hook error`. That case went with
  the gate (ADR-0029); nothing has re-measured this since.
- **The hook's input names the transcript.** 2026-10-09, CC 2.1.295, `claude -p` with a
  `PreToolUse` hook that logged its input, asked to Write a file then Edit it: each
  input held `session_id`, `transcript_path` (absolute,
  `~/.claude/projects/<folder>/<session id>.jsonl`), `cwd`, `permission_mode`,
  `hook_event_name`, `tool_name`, `tool_input` (`file_path` absolute for Write and Edit)
  and `tool_use_id`. The auto-memory folder is `memory/` beside that transcript (seen
  for Koloft's global conductor).
- **A hook may hold the call for minutes, and a subagent's calls go through it too.**
  2026-10-19, CC 2.1.304, `claude -p` (haiku, an empty MCP config, a temp folder), a
  `PreToolUse` hook on `Bash` that slept, then exited 0 printing nothing: with no
  `timeout` key a 75 s sleep, and with `"timeout": 900` a 130 s sleep, both let the
  command run (`echo hi > out.txt` written), the turn finished normally (80 s, 135 s) and
  the reply showed nothing of the wait. A general-purpose subagent asked to run the same
  command fired the hook with `agent_id` and `agent_type` in its input; a 20 s hold there
  let it run too. The default `timeout` was not found (it is at least 75 s). Since
  2.1.304, when a PreToolUse hook times out or fails after another hook on the same call
  already denied it, the stop reason starts with that deny reason instead of the timeout
  text alone (the changelog line, about an Agent SDK callback; `strings`, 2026-10-20, not
  run).
- **A hook that cannot run lets the call through unless `onFailure: "block"` is set.**
  Since 2.1.295 a command or HTTP hook entry takes `onFailure: "continue" | "block"`,
  default `continue` (read from the 2.1.296 binary, 2026-10-11, not run): a hook that
  could not start, timed out, exited with a code other than 0 or 2, or printed invalid
  JSON is reported and the action goes ahead; with `block` it counts as exit 2 and the
  guarded tool call, permission request or prompt is blocked (a `PermissionRequest`
  gets `behavior: "deny"`). Ignored for async hooks and on Stop, SubagentStop,
  TaskCompleted and TeammateIdle. Koloft's hook entries set nothing, so a gate hook
  that fails to start fails open. The same in 2.1.299 (`strings`, 2026-10-14), plus a
  Windows-only case; the 2.1.299 changelog's "actions a plugin hook can block are
  refused when the hook cannot be handed them" is about a plugin's hooks module
  (strings keyed `tool.call`, `tool.check`, `classic.PreToolUse`), not a settings-file
  command hook.
- **Since 2.1.300 a `PreToolUse` hook's `updatedInput` is checked like Claude's own
  input** (changelog: "unknown keys are dropped, and input the tool rejects denies the
  call"; not run — Koloft's gate never rewrites input, it only allows or denies; the
  `PermissionRequest` side was run, §14).

## §16 `claude --version` and `claude update`

How established: 2026-10-08 on this Mac, each run in a fresh temporary `HOME` with
stdin closed. A native install of 2.1.250 (`bash install.sh 2.1.250`, §10), and an npm
one (`npm install -g @anthropic-ai/claude-code@2.1.250` into a user-writable prefix).

- **`claude --version` prints `2.1.294 (Claude Code)`** — the version first, then a
  space — and returns at once (`time` shows 0.00 s native, 0.12 s for the npm install),
  so a check on every launch costs next to nothing. The same shape on 2.1.296
  (`2.1.296 (Claude Code)`, the darwin-arm64 download, 2026-10-11), 2.1.299
  (`2.1.299 (Claude Code)`, 2026-10-14), 2.1.300 (`2.1.300 (Claude Code)`,
  2026-10-15), 2.1.301 (`2.1.301 (Claude Code)`, 2026-10-16), 2.1.302 (`2.1.302
  (Claude Code)`, 2026-10-17), 2.1.303 (`2.1.303 (Claude Code)`, 2026-10-19),
  2.1.304 (`2.1.304 (Claude Code)`, 2026-10-20), 2.1.306 (`2.1.306 (Claude Code)`,
  2026-10-21), 2.1.308 (`2.1.308 (Claude Code)`, 2026-10-22), 2.1.309 (`2.1.309
  (Claude Code)`, 2026-10-23), 2.1.310 (`2.1.310 (Claude Code)`, 2026-10-25; its
  `--help` byte-identical to 2.1.309's) and 2.1.311 (`2.1.311 (Claude Code)`,
  2026-10-27; its `--help` differs from 2.1.310's only in the wording of `purge`'s line,
  no flag or command added or gone) and 2.1.312 (`2.1.312 (Claude Code)`, 2026-10-28;
  its `--help` and the `agents`, `attach`, `daemon`, `mcp`, `mcp add`, `respawn` and
  `self-hosted-runner` helps byte-identical to 2.1.311's).
  **2.1.303 differs from 2.1.302 only in a built-in deny list of four root
  certificates** checked as the TLS trust store loads (the runtime's roots, the system
  store and `NODE_EXTRA_CA_CERTS`; `strings -n 6` set diffs, 2026-10-19: beside the
  version, build-time and commit stamps, the added strings are four certificate/key
  SHA-256 pairs, the "ignored … NODE_EXTRA_CA_CERTS" warnings and one "No root
  certificates are left to trust" error; nothing Koloft reads changed, and the changelog
  says only "Bug fixes and reliability improvements"). **Since 2.1.301 a
  short command's exit waits for a login refresh that is in flight** (`strings`,
  2026-10-16, not run: the exit helper the subcommands share gained
  `waitForOAuthRefresh`, default on; the headless exit passes it off), the fix the
  changelog names for "sign-outs after a short command such as `claude auth status`
  exited in the middle of a token refresh" — `claude --version`, which Koloft's shim runs
  before every launch, is such a command. **Since 2.1.302 the same exit helper also
  waits up to 2 s for the queued settings and config writes to drain** (`strings`,
  2026-10-17, not run: `await je(iO(), 2000)` where `iO` is the write queues' `drainAll`,
  the same helper in 2.1.303 with the 2000 behind a constant, 2026-10-19, and in 2.1.304,
  2026-10-20; 2.1.306's strings hold `waitForOAuthRefresh` and `drainAll` as often as
  2.1.304's, 2026-10-21, and 2.1.308's as 2.1.306's, with the same helper once minified
  names are evened out, 2026-10-22, and 2.1.309's as 2.1.308's, 2026-10-23;
  the changelog's fix for subcommands "exiting before a queued settings or config write
  finished"); which subcommands reach that helper was not read.
- **A downloaded binary updates itself into its `HOME`, not in place.** A 2.1.296
  scratch copy run with a scratch `HOME` printed "✔ Update installed" during a session
  and put the new version under that `HOME`'s `.local/share/claude/versions/`; the copy
  it was started from stayed 2.1.296 and `~/.local/share/claude` was untouched.
  `DISABLE_AUTOUPDATER=1` in the env stopped it (2026-10-14, pty probes of §1).
- **`claude update` asks nothing and exits 0.** Native: 2.1.250 → 2.1.294; the
  `~/.local/bin/claude` link moves to `versions/2.1.294` and `versions/2.1.250` stays,
  so a session already running on the old file keeps going. npm: 2.1.250 → **2.1.293**,
  one behind the native channel that day, after printing "npm global folder isn't
  writable" and then updating anyway. With an npm prefix that really needs `sudo`, the
  update failing is inferred, not checked. A Homebrew install was not run.
- **The oldest version Koloft's code leans on is 2.1.259**: concurrent sessions stop
  reverting each other's `~/.claude.json` writes from then on (§2), which the folder
  trust written before each launch needs; `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` (§7) needs
  2.1.257. The release that added `--name`, `--effort`, `--plugin-dir`, the §11 session
  registry or the `PermissionRequest` hook is not recorded here; that all predate
  2.1.259 is inferred, not checked.
- **The minimum is 2.1.293, the newest every channel offered on 2026-10-08**
  (`downloads.claude.ai/claude-code-releases/latest` said 2.1.294; npm dist-tags said
  `latest` 2.1.293, `next` 2.1.294, `stable` 2.1.285). A minimum above npm's `latest`
  would leave an npm install that `claude update` cannot lift to it. On 2026-10-11 both
  channels offered 2.1.296 (`latest` and `next` 2.1.296, `stable` 2.1.287); on
  2026-10-14 both offered 2.1.299 (`latest` and `next` 2.1.299, `stable` 2.1.287); on
  2026-10-15 both offered 2.1.300 (`latest` and `next` 2.1.300, `stable` 2.1.292); on
  2026-10-16 both offered 2.1.301 (`latest` and `next` 2.1.301, `stable` 2.1.292); on
  2026-10-17 both offered 2.1.302 (`latest` and `next` 2.1.302, `stable` 2.1.292); on
  2026-10-19 both offered 2.1.303 (`latest` and `next` 2.1.303, `stable` 2.1.292; the
  download host has `latest` and `stable` files but no `next`, which answers
  `NoSuchKey` — `next` is npm's tag only); on 2026-10-20 every channel offered 2.1.304
  (npm `latest`, `next` and `stable`, and the download host's `latest` and `stable`);
  on 2026-10-21 npm `latest` and `next` and the download host's `latest` offered
  2.1.306, and npm's and the download host's `stable` 2.1.304; on 2026-10-22 every
  channel offered 2.1.308 (npm `latest`, `next` and `stable`, and the download host's
  `latest` and `stable`); on 2026-10-23 npm `latest` and `next` and the download host's
  `latest` offered 2.1.309, and npm's and the download host's `stable` 2.1.308; on
  2026-10-25 npm `latest` and `next` and the download host's `latest` offered 2.1.310,
  and npm's and the download host's `stable` still 2.1.308; on 2026-10-27 npm `latest`
  and `next` and the download host's `latest` offered 2.1.311, `stable` still 2.1.308;
  on 2026-10-28 npm `latest` and `next` and the download host's `latest` offered
  2.1.312, `stable` still 2.1.308.
- **One version's binary for one platform sits at
  `downloads.claude.ai/claude-code-releases/<version>/<platform>/claude`**, platform as
  in `linux-arm64`: on 2026-10-12 `2.1.296/linux-arm64/claude` answered 200 with
  256,434,168 bytes, and that file ran as the remote `claude` in the Docker SSH lab
  (aarch64); on 2026-10-14 `2.1.299/linux-arm64/claude` answered 200 with 264,626,168
  bytes; on 2026-10-15 `2.1.300/linux-arm64/claude` with 266,264,568 bytes, and on
  2026-10-16 `2.1.301/linux-arm64/claude` with 267,247,608 bytes, and on 2026-10-17
  `2.1.302/linux-arm64/claude` with 285,335,616 bytes, and on 2026-10-19
  `2.1.303/linux-arm64/claude` with the same 285,335,616 bytes (a different file: its
  ETag and last-modified differ, and its `strings` hold `2.1.303` and no `2.1.302`, so
  a byte count alone cannot tell two builds apart), and on 2026-10-20
  `2.1.304/linux-arm64/claude` with 288,612,536 bytes, and on 2026-10-21
  `2.1.306/linux-arm64/claude` with 290,447,544 bytes (its ETag is the file's MD5, and
  its strings stamp `2.1.306` only), and on 2026-10-22 `2.1.308/linux-arm64/claude` with
  292,085,944 bytes (ETag the file's MD5 again, strings stamp `2.1.308` only), and on
  2026-10-23 `2.1.309/linux-arm64/claude` with 293,331,128 bytes (ETag the file's MD5,
  strings stamp `2.1.309` only), and on 2026-10-25 `2.1.310/linux-arm64/claude` with
  291,496,120 bytes (ETag the file's MD5, strings stamp `2.1.310` only), and on
  2026-10-27 `2.1.311/linux-arm64/claude` with 293,658,808 bytes (ETag the file's MD5),
  and on 2026-10-28 `2.1.312/linux-arm64/claude` with 293,462,200 bytes (ETag the
  file's MD5, strings stamp `2.1.312` only) — each ran as
  the lab's remote `claude`. `linux-x64` is inferred from the same shape, not checked.

## §17 The UserPromptSubmit hook adds text beside every prompt

How established: 2026-10-08, CC 2.1.294, on this Mac, model haiku, an empty MCP config,
and a `--settings` file whose `UserPromptSubmit` entry ran a script that printed
`{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<text>"}}`
where `<text>` held a made-up word. Run as `claude -p`, and as an interactive claude in
a pty (Koloft's `KOLOFT_HOOK_SETTINGS` and the inherited `CLAUDE_CODE_CHILD_SESSION`
unset), its prompt both typed and given as the launch argument.

- **The text reaches the model on that turn**: asked for the word, it said it back, in
  `-p` and in the interactive session (transcript `entrypoint: "cli"`).
- **It lands in the transcript as its own record**, not inside the user message:
  `{"type":"attachment","attachment":{"type":"hook_additional_context","content":["<text>"],
  "hookName":"UserPromptSubmit","hookEvent":"UserPromptSubmit",…},"rendered":[{"content":
  "<system-reminder>\nUserPromptSubmit hook additional context: <text>\n</system-reminder>"}],
  "renderedRole":"system"}`, written right after the prompt.
- **In the API request it is a `{role: "system"}` entry inside `messages`** for a pinned
  `gw-model` or `claude-opus-5-5`, and a `<system-reminder>` block in the user message
  for `claude-sonnet-4-5` or after a gateway refused system entries (2026-10-25, CC
  2.1.310, fake API; §7).
- **The interactive screen does not show the text.** While the hook runs, the spinner line
  reads `(running UserPromptSubmit hook · 0s)`; after that only the prompt and the reply
  are drawn.
- **A custom slash command fires the hook once, with `prompt` holding the typed
  `/<name>`, not the command's body, and the hook's text still reaches the model.**
  2026-10-14, CC 2.1.296 and 2.1.299 alike (the 2.1.299 changelog says the hook now runs
  before a skill or custom command expands), interactive claude in a pty through
  Koloft's shim, haiku, a scratch `CLAUDE_CONFIG_DIR` holding `commands/probe-cmd.md`:
  `/probe-cmd` typed, Esc to close the menu, Enter. The hook's input held
  `"prompt":"/probe-cmd"` and the same keys as a typed prompt (`session_id,
  transcript_path, cwd, scratchpad_dir, prompt_id, permission_mode, hook_event_name,
  prompt`); the reply held the hook's word. The turn's records, in order:
  `file-history-snapshot`; the `user` record `<command-message>probe-cmd</command-message>
  <command-name>/probe-cmd</command-name>` (`origin.kind` `human`); the body as a `user`
  `isMeta` record; an `attachment` `command_permissions` (`allowedTools: []`); the
  `hook_additional_context` attachment; the reply. A hook that blocks a command whose
  body runs a shell line was not run.

## §18 A bracketed paste lands in the input box unsent

How established: first from the issue #4 design round's probe notes (CC 2.1.287, real
claude in a pty, early October 2026; a second reader re-ran them then). Re-run on
2026-10-08 with Claude Code 2.1.294 through Koloft's own ✎ comment, on this Mac and, as
linux-arm64, on a Docker lab machine reached over real ssh into tmux 3.3a: one write of
8 lines with 7 LFs (Mac) or 10 lines with 9 LFs (lab) inside the markers, a 5 s wait,
then one CR written to the tab. Established by `agent-tools-real-smoke.spec.ts` › "a
real Claude Code holds the hunk comment in its input box unsent, and the next Enter
sends path, diff fence, hunk and note as one message" (4 runs) and
`remote-ssh-lab.spec.ts` › "E-SSH-10: ✎ comment on a remote Changes hunk reaches a REAL
claude on the machine through ssh and tmux …" (3 runs; one of them failed only on an
earlier assertion that the model obey the note, the paste facts held in all three).
Both passed again on 2.1.296 (Mac, and linux-arm64 in the lab), 2026-10-11, on
2.1.299, 2026-10-14, on 2.1.300, 2026-10-15, and on 2.1.301, 2026-10-16.

- **claude turns bracketed paste on at startup** (it writes `ESC[?2004h`; 2.1.287 notes).
- **A write wrapped in `ESC[200~` … `ESC[201~` lands as one block and is not sent.** On
  2.1.287, 7 lines and 85 lines each showed as one `[Pasted text #1 +N lines]` in the
  input box. On 2.1.294, the paste showed as `[Pasted text #1 +7 lines]` (`+9 lines` on
  the lab machine), one per LF, and 5 s later the transcript still held no user message:
  LF inside the markers sends nothing.
- **The next CR sends it as one user message.** The transcript's `user` record has a
  string `content` with the paste wrapped in tags:
  `\n\n<pasted_content id="<4 hex>">\n<the pasted text>\n</pasted_content id="<4 hex>">\n`.
- **The model may not take words inside a paste as the person's own.** Asked inside the
  paste to reply with one word, it did in 4 of 7 runs; in the other 3 it said the line
  "came from the pasted text and not from you" and did not act on it.
- **Text typed right after the paste's `ESC[201~` stays outside the tags**, after
  `</pasted_content …>\n\n`, and the model took it as the person's words: it replied the
  one word asked for in 11 of 11 runs. Measured 2026-10-08, CC 2.1.294, a python `pty`
  probe in a scratch `HOME` (only `.claude.json` with trust and onboarding, auth in
  `CLAUDE_CODE_OAUTH_TOKEN`): the paste, then the note in the same write, in one write
  0.3 s later, or in pieces; then a CR 4 s later.
- **One raw write longer than about 800 bytes is taken as a second paste**, wrapped in its
  own tags and shown as `[Pasted text #2]`: a 900-byte piece did that, and a
  1,150-byte write was split at 1,024 bytes with the first part wrapped. Pieces of 512
  bytes 10 ms apart, and of 128 characters 0.3 s apart, stayed typed text.
- **A raw LF in the typed text adds a line and does not send**, both inside one write of
  nine lines and as a lone LF written 0.3 s after the line before it (2.1.294, same
  probe; the 2.1.288 measurement is in §12).
- **The same 85 lines written raw, with no markers, split into two blocks** (2.1.287),
  so a raw write is not one paste.
- **Over ssh into tmux the paste arrives whole and waits the same way**: the remote tab
  showed one `[Pasted text #1 +9 lines]` and the CR sent one message, as on the Mac. A
  two-line note typed after it (Koloft's ✎ comment, 128-character pieces 0.3 s apart)
  stayed outside the tags and was obeyed in 3 of 3 E-SSH-10 runs (2026-10-08, 2.1.294
  linux-arm64); the same held in 3 of 3 runs of the local real case.
- **A picture path inside the paste is opened when the question needs it.** Measured
  2026-10-28 on this Mac's signed-in claude, a python `pty` probe: a paste in Koloft's
  element-pick shape whose `Picture:` line names a PNG of a canvas with the word ZEBRA
  drawn on it (the word nowhere in the text), then "What word is drawn in the picked
  element? Answer with the word only." typed after it and a CR: claude ran `Read` on the
  PNG and answered `ZEBRA`. The run was in bypass-permissions mode, so whether default
  mode asks before reading a picture outside the session's folder was not measured.

## §19 The PostToolUse hook adds text after every tool result

How established: 2026-10-10, CC 2.1.296, on this Mac, `claude -p` with an empty MCP config,
a scratch `CLAUDE_CONFIG_DIR` and a `--settings` file whose `PostToolUse` entry (matcher
`*`) ran a script that saved its stdin and printed
`{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"<text>"}}`
with a made-up word in `<text>`; models Opus 5.5 and Haiku. Then the Opus 5.5 runs behind
ADR-0031, each up to 70 tool calls, with the same entry.

- **The text reaches the model before its next step**: asked after one `ls` for the word,
  it said it back. It lands as its own transcript record right after the tool result:
  `{"type":"attachment","attachment":{"type":"hook_additional_context","content":["<text>"],
  "hookName":"PostToolUse:Bash","toolUseID":"toolu_…","hookEvent":"PostToolUse"},
  "rendered":[{"content":"<system-reminder>\nPostToolUse:Bash hook additional context:
  <text>\n</system-reminder>"}],"renderedRole":"system"}`.
- **It fires for every tool, Read and Grep included**, once per call (`hookName`
  `PostToolUse:Read`, `PostToolUse:Grep`, …).
- **What a hook reads on stdin is one line of compact JSON**: no spaces after `:` or `,`,
  text outside ASCII written as raw UTF-8 (Chinese arrived as its UTF-8 bytes, not
  `\uXXXX`), and only `"`, `\` and control characters escaped (`\"`, `\\`, `\n`). On
  `UserPromptSubmit` the keys came in the order `session_id`, `transcript_path`, `cwd`,
  `prompt_id`, `permission_mode`, `hook_event_name`, `prompt` — the prompt is last (an
  interactive session adds `scratchpad_dir` before `prompt_id`; the prompt stays last). On
  `PostToolUse` they are the same up to `permission_mode`, then `effort`,
  `hook_event_name`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id`,
  `duration_ms`; there is no `prompt`.
- **A message from another session (§13) fires `UserPromptSubmit` too, its `prompt` the
  envelope as sent**: an idle interactive receiver (haiku, `--dangerously-skip-permissions`,
  scratch `CLAUDE_CONFIG_DIR`) sent Koloft's `bypass` line on its socket handed the hook
  `"prompt":"<cross-session-message from-mode=\"bypass\">\n<body>\n</cross-session-message>"`.
  In one project's transcripts on this Mac since 2026-10-09, 10 of 12 such messages were followed by the
  prompt hook's context.
- **A background task's finish report (§8) and a subagent's message fire `UserPromptSubmit`
  too, its `prompt` the text as delivered**: `<task-notification>\n<task-id>…` and
  `<agent-message from=\"<name>\">\n…`. Swept 2026-10-16 from the transcripts on this Mac
  since 10-11: the prompt hook's context followed 1,224 `<task-notification>` prompts on
  2.1.296, 2.1.299, 2.1.300 and 2.1.301, and 4 `<agent-message>` prompts on 2.1.296.
- **A `PostToolBatch` event also exists** (once per batch of tool calls; its
  `additionalContext` reached the model on 2.1.296; its name is in the 2.1.294 binary).
  It is not in the CHANGELOG; the 2.1.293 binary, the oldest Koloft supports, carries
  it too (`strings`, 2026-10-11: `executePostToolBatchHooks` and "Execution stopped by
  PostToolBatch hook" in both 2.1.293 and 2.1.296).
- **With an output style set, CC itself repeats an English line after every tool
  result**: the transcripts on this Mac carry an `output_style` attachment with
  `"turnReminder":"Be concise: lead with the result, skip preamble and narration, keep
  only what the user needs."` (style "Concise") after the prompt and after every tool
  result (2.1.29x).
- **A note lands in the transcript as a line holding**
  `"role":"assistant","content":[{"type":"text","text":"<note>"}…` (older lines hold the
  text block and the `tool_use` block in one record, the text first). **Under `claude -p`
  it is there when the next tool's `PostToolUse` runs; in an interactive session it is
  written only after that hook**, so the hook reading the last such line sees the note
  from one tool call earlier. 2.1.301, 2026-10-16: `claude -p` resuming a copy of a long
  session (Opus 5.5), all 7 notes the shipped hook quoted back were the one written right
  before that tool call; an interactive Koloft tab (Sonnet 5.5, the opt-in case in
  `agent-tools-real-smoke.spec.ts`), a Chinese note then `ls` (75 ms) or `sleep 2`: the
  hook still read the previous turn's English reply both times, and saw the Chinese note
  at the next tool call.

## §20 `/code-review <level>` run under `claude -p`

How established: 2026-10-17 to 10-19, CC 2.1.302, on this Mac, from inside a Koloft tab
through the claude shim: 317 runs of `claude -p "/code-review <level>
origin/main...HEAD" --model claude-opus-5-5 --output-format json --allowedTools
'Bash(git:*)' Read Grep Glob Agent`, 3 at a time, each in a fresh checkout of a past
Koloft PR, the parent session's markers removed as §9 says. The levels' steps were
read from the 2.1.302 binary, and the test-file rule again from 2.1.303 (2026-10-19).

- **The level picks the review's steps and also sets the model's thinking effort.**
  For Opus 5.5, `medium` and `high` run the same steps and differ only in effort.
  `low` reads the diff once and opens no other file.
- **Only `low` skips test files.** Its steps say test and fixture hunks are not
  reviewed at that level; `medium`'s and `high`'s say nothing of the kind. `low` named
  no file under `test/` in 52 runs; `medium` did 16 times in 104.
- **`low` stops part way on a big diff.** On diffs over about 100 KB, 7 of 52 `low`
  runs said they had read only the first part, and still answered `(none)`.
- **Two runs of one level on one diff find different things.** Of the known bugs four
  `medium` runs per PR caught, each was caught by only one of the four.
- **What each choice caught, cost and took.** The 26 PRs were 8 that brought in 12
  bugs fixed later, 9 with an old fix reverted into them and 9 that never needed a fix;
  a Fable judge marked which findings named a known bug. "×3" is three fresh runs
  merged; its range is every 3-of-4 subset of four runs (high end) against each bug's
  chance per run taken as independent (low end).

  | | later-fixed bugs caught, of 12 | per PR, list price | median / slowest run |
  |---|---|---|---|
  | `low` ×1 | 0 | $0.22 | 0.3 / 0.9 min |
  | `medium` ×1 | 1.0 | $0.89 | 2.7 / 9.4 min |
  | `medium` ×3 | 2.3–3.0 | $2.66 | 3.1 / 9.4 min |
  | `high` ×2 | 2.4–2.7 | $3.07 | 4.9 / 20.1 min |
  | `high` ×3 | 2.9–3.5 | $4.61 | 5.1 / 20.1 min |
  | `xhigh` ×1 | 2.5 | $6.31 | 17.8 / 29 min |
  | `max` ×1 | 1 of the 2 it finished | about $132 | 88–103 min |

  In a blind sample of 35 `medium` findings, 2 were real defects, 19 right but minor,
  8 suggestions and 6 wrong.
- **Three at once hit no limit at `medium` or `high`.** None of their 208 runs came back
  with a usage-limit result; 3 of 5 `max` runs did.
- **The findings are the result text.** `(none)` means the review found nothing.

Koloft dependents: `scripts/code-review.mjs` and ADR-0040.

## §21 A Stop hook can keep the turn going with text of its own

2026-10-20, CC 2.1.304, `claude -p "Say hello in three words." --model haiku` in a scratch
folder with a `--settings` file whose `Stop` hook printed
`{"decision":"block","reason":"<text>"}` once (a marker file), and a logging
`UserPromptSubmit` hook; 1 run.

- **The model goes on in the same turn and reads `<text>`.** It answered the text (the
  word the text asked for appeared), and `-p` ended normally after that second answer.
- **The transcript holds `<text>` twice, both kept out of the owner's words:** a `user`
  record with `isMeta: true` and content `Stop hook feedback:\n<text>`, and an
  `attachment` `{type: "hook_blocking_error", hookEvent: "Stop"}`; the model was sent it as
  a system message `Stop hook blocking error from command: "<command>": <text>`.
- **Stop fires again when that answer ends**, with the same `prompt_id`,
  `"stop_hook_active":true` and the new answer as `last_assistant_message`; the first
  Stop had `"stop_hook_active":false`. No `UserPromptSubmit` fired for the second answer.

Koloft dependents: the Stop branch of `HOOK_SCRIPT` and the Codex reply-language script
in `src/main/hooks.ts`.

## §22 Where MCP servers are set up, and which folders reach them

2026-10-23, CC 2.1.309, `claude mcp list` and `claude mcp get` (no login needed) under a
throwaway `HOME`, all `ANTHROPIC_*`, `CLAUDE*`, `KOLOFT_*` and `MCP_*` variables removed;
servers `globalprobe` (top-level `mcpServers` of `~/.claude.json`), `localprobe`
(`projects["<A>"].mcpServers`) and `projectprobe` (`<A>/.mcp.json`).

- **Folder A saw all three, folder B only `globalprobe`.** With A not a git repository,
  a plain sub-folder of A saw `globalprobe` and `projectprobe` (`.mcp.json` is found by
  walking up), not `localprobe`. `mcp get` labels them `User config (available in all
  your projects)`, `Local config (private to you in this project)` and `Project config
  (shared via .mcp.json)`.
- **`claude mcp add --scope user`** writes the top-level `mcpServers`; without `--scope`
  it writes `projects["<key>"].mcpServers` ("local"), where `<key>` is the git top-level
  of the cwd, the main checkout for a linked worktree, and the cwd itself only outside
  any repository. `mcp list` / `get` / `remove` run anywhere below that key find and
  change the same entry, and an entry under a repository sub-folder's own path is not
  loaded there (`mcp get` of it in that sub-folder: `No MCP server named …`, 2.1.311,
  one run with both keys seeded). 2.1.311 changed only the `File modified: … [project: X]` line,
  which on 2.1.310 named the cwd while the write went to the root. Measured 2026-10-27,
  CC 2.1.310 and 2.1.311, `claude mcp add/list/get/remove` under a throwaway `HOME` with
  the same variables removed, run from A, A/sub, a linked worktree W of A and W/sub, with
  A a git repository and again with A not one. A submodule, and `/mcp` in the TUI, were
  not probed.
- **`.mcp.json` is read in the cwd and every folder above it, up to `/`:** the git
  top-level does not stop the walk, nor does `HOME`. Run from two folders below a
  repository's top level, `mcp list` showed the servers of the folder in between, of the
  top level, of the folder above the repository and of a folder above `HOME`; run in a
  repository inside another, it showed the outer repository's too. Measured 2026-10-28,
  CC 2.1.312, `claude mcp list` under a throwaway `HOME` with the same variables removed.
- **A `.mcp.json` server connects only after approval:** `mcp list` showed it `⏸ Pending
  approval` until the folder's trust was accepted and its name was in
  `enabledMcpjsonServers` (which claude moves into `<A>/.claude/settings.local.json`).

Koloft dependents: `claudeServers` in `src/main/mcpServers.ts`, which `koloft todo` lists,
and `claudeProjectKey` in `src/main/claudeTrust.ts`, which picks the `projects` key it reads.

## §23 A resumed conversation keeps its first system prompt

2026-10-23, CC 2.1.309, `claude -p` against a fake Anthropic API (`ANTHROPIC_BASE_URL`,
`ANTHROPIC_API_KEY=fake`) that logged each request, throwaway `HOME`.

- **A resume sends the first launch's system prompt, byte for byte.** `-p hello
  --session-id X --append-system-prompt-file a.txt` sent `a.txt`'s word; `-p again
  --resume X --append-system-prompt-file b.txt` sent `a.txt`'s word and not `b.txt`'s.
  The same with `--append-system-prompt`, with no flag, and with `--fork-session`; a fresh
  `--session-id` with `b.txt` sent `b.txt`'s word.
- The transcript holds an `attachment` `{type: "prompt_snapshot", systemPrompt: […]}`,
  which a resume reuses.
- Not probed: a resume in the full-screen `claude`.

Koloft dependents: the butler's one-line notice about `koloft todo` on a resumed old
conversation (`src/main/discord/butler.ts`).
