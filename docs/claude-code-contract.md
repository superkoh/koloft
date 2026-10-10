# Claude Code contract ledger

Measured facts about Claude Code (CC below) that Koloft depends on and that **reading
Koloft's own code cannot reveal**. Every entry carries its observation date, CC version,
and how it was established; any entry can drift when CC upgrades — the canary run
(below) watches for structural drift, and a disproven entry is corrected in place,
never kept for history. This file records only observations of the
external system; Koloft's own mechanism rationale lives in ADRs (`docs/adr/`) and behavioral
claims live in tests (doctrine: the document-retirement rule in CLAUDE.md). An entry
with no date, version or method is marked "inferred, not checked".

**Canary run** — the e2e suite against a real `claude`, started by hand after a CC
upgrade; nothing schedules it and it is not a gate. `test/e2e/helpers/env.ts` pins
`KOLOFT_CLAUDE_CMD: 'claude'` after spreading `process.env` and builds PATH itself, so
an exported env var never reaches the app — override `launchEnv` in code instead
(pattern: restart-session.spec.ts). Viable because specs assert structure, never model
prose; `cron-real-smoke.spec.ts` is the one opt-in case that already runs on the real
binary.

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
  prompt cache expired". When it fires was read off the 2.1.295 binary's strings, not
  probed: a server-side flag, at least 100 000 context tokens
  (`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` can raise it), at a fraction (0.5–0.95, default
  0.9) of the prompt cache's lifetime, and only after 60 s with nothing typed.
- **Every compaction ends by writing a summary record**, at about the moment SessionStart
  `compact` fires (2026-10-09, CC 2.1.295, manual and automatic): `type: "user"`, string
  content "This session is being continued from a previous conversation that ran out of
  context. …", `isCompactSummary: true`, `isVisibleInTranscriptOnly: true`, no `origin`,
  no `isMeta`. It is not something anyone typed. Koloft reads hooks at once but the
  transcript on a 500 ms poll, so the summary is usually read after the compaction has
  ended: two dev-build runs of `/compact` with the real binary, read before this rule,
  both showed the row go back to working about 0.5 s after it went back to waiting.
- **On exit CC prints a resume hint, and what it quotes depends on the session**:
  `Resume this session with: claude --resume <id>` for a session with no name, but
  `claude --resume "<name>"` once the session was given a `--name`, and
  `claude --worktree <name> --resume "<name>"` after a keep-the-worktree exit
  (measured 2026-09-03 on 2.1.259 — four exits, named and unnamed, §4).
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
- **Every hook payload carries `session_id`**, run-state events (UserPromptSubmit,
  Stop, Notification) included, not only SessionStart/SessionEnd. (Inferred, not
  checked.)
- **A hook can read the running claude's version from its env.** On a native install
  `CLAUDE_CODE_EXECPATH` is the binary inside `…/versions/<version>`, so its basename
  is the version (digits and dots only; an npm layout's basename is not a version).
  claude also stamps its children with `AI_AGENT=claude-code_X-Y-Z_agent`. Seen
  2026-09-24 on CC 2.1.281 with `env` inside a Bash tool call:
  `CLAUDE_CODE_EXECPATH=/Users/…/.local/share/claude/versions/2.1.281`,
  `AI_AGENT=claude-code_2-1-281_agent`. A resumed session's transcript tail still
  shows the version of the older claude that wrote it, so only the live process tells
  the truth (inferred, not checked).
- **A brand-new claude prints its login and onboarding links before its SessionStart
  hook fires**, so a user can click a link before the session is bound. (Inferred, not
  checked.)

Evidence: live experiments E1–E8, 2026-08-10, claude 2.1.227; enums read from CC 2.1.238 source on 2026-08-22. Koloft dependents: the `EVICTING_END_REASONS` whitelist
in `src/main/backends/claude.ts` (marked `CC§1`); `sessionTracker.bindSession` (it takes
the hook's `cwd` — the launch-directory entry above) and `followWorktreeState` (which
then moves the root to the worktree the last `worktree-state` names);
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
  record sat at most 49KB from the end (p90 27KB), so a 64KB tail read always finds it.
  241 ended on `worktreeSession: null` (left the worktree), all in the root checkout's
  slug; 70 ended bound, all in a worktree's slug; 2 ended bound in the root slug.
  Measured by reading every `~/.claude/projects/*/*.jsonl` on the dev Mac.
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

Unless a bullet below says more, it is inferred, not checked.

- **The transcript is append-only.** Once the head of a file has been read to its end
  (or to the scan cap), later writes never change what that head says; a file that
  shrinks was rewritten by someone else.
- **`ai-title` records repeat.** CC writes the session's `ai-title` again every few
  turns with the same value, so the first one is enough (one 2.1.281 transcript,
  2026-09-24: 56 `ai-title` records).
- **Streaming repeats the usage record.** The same assistant usage object is written
  several times — 3 times in real transcripts, with the same `message.id` and
  `requestId`. Some records carry neither id and each must count; records with model
  `<synthetic>` carry no real spend.
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
  report: `/goal <pasted image>`).
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
  and said back a word only folder A's turn held.
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
  strings + docs).
- **A `WorktreeCreate` hook is not a setup step: it REPLACES `git worktree add`.** It is
  meant for other version-control systems; the hook must make the folder and print its
  path, and with the hook set the `.worktreeinclude` copy does not run. Setup work in a
  new worktree belongs in a `SessionStart` hook. Probed for #5 on claude 2.1.287 (binary
  strings + docs). The 2.1.294 strings agree that the hook makes the worktree
  ("configure WorktreeCreate and WorktreeRemove hooks in settings.json for another
  version-control system"; "Provides the absolute path to the created worktree
  directory"); that the copy is then off was not re-read there.
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
  that worktree’s name (opt-in, spends real money)".
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
  kept. So a worktree on a branch of its own name (a pull request's branch) is opened by
  starting bare `claude` inside it, never with `-w`, as for any existing worktree.
  Measured 2026-10-09, claude 2.1.295 (the real binary, not the shim), a throwaway
  one-commit repo with no `origin`, a scratch `HOME` whose `~/.claude.json` trusted the
  repo, no login (the worktree step runs before any model call), driven in a python pty
  with a `--settings` SessionStart hook, then `git worktree list` and `git branch`.
- **A worktree name is refused when only its branch is left.** If a person deletes
  `.claude/worktrees/<n>` but keeps the branch `worktree-<n>`, `claude -w <n>` refuses
  that name. (Inferred, not checked.)

Evidence: experiments E3/E4/E8, 2026-08-10, plus `strings` analysis of the claude
2.1.227 binary. Koloft dependents: the resume decision tree in `src/main/resumePlan.ts`
(behind `sessions:resumePlan`); `claudeArgv` in `src/main/claudeArgs.ts`, which composes
`--resume`/`-w`; `copyWorktreeIncludes` in `src/main/sessionWorktrees.ts`, which copies
the same files into a worktree Koloft makes or rebuilds itself.

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
  window title) followed at once by the line `Removing worktree…` (U+2026), deletes the
  folder, deletes the branch `worktree-<name>`, prints one result line, runs the
  SessionEnd hooks and only then exits. Success lines start with `Worktree removed`
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
- **A SIGHUP during the delete cuts it off half way.** CC stops waiting and exits; the
  folder keeps what was not deleted yet (213,696 of 250,000 files), the worktree stays
  in `git worktree list` and its branch stays. `git worktree remove --force --force`
  and `git branch -D worktree-<name>` finish the job.
- Measured 2026-10-09 on CC 2.1.295 (strings and code of the binary, a pty-driven `-w`
  session in a throwaway repo, `--debug-file` timings, the raw pty bytes); the tmux row
  in the e2e SSH lab image.

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
  the parent tab's identity; its SessionStart carries `source=fork` (single live
  sample, 2026-08-20); **its self-stop fires SessionEnd reason=`prompt_input_exit`**
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
  exist on the dev Mac; where 2.1.281 keeps this state is not measured.
- **One-step attach exists: `claude attach <id>`** (added in 2.1.251 per the changelog,
  alongside `logs / stop / respawn / rm` in `claude --help`). Measured on this Mac,
  2026-09-18, CC 2.1.276, and unchanged on 2.1.281 (2026-09-24) — `claude attach --help`
  prints: `Usage: claude attach <id> /
  Open the background session in this terminal. ← returns to agent view, Ctrl+Z drops
  back to your shell. The session keeps running either way.` The changelog also says a
  direct `--resume` of a running background session is refused with a message naming
  `claude attach <id>` (not re-measured). `claude --resume <id> --fork-session` still
  makes ANOTHER copy, it is not a takeover.
- **Interactive sessions have NO re-entry guard**: resuming an already-running normal
  session is not blocked — the same session can be written by two processes at once
  (measured loss, 2026-08-20). The "already running … split-brain" refusal belongs to
  claude remote-control, not to resume.
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

Evidence: on-machine diagnosis 2026-08-22 (CC 2.1.238) and CC source reading; the two
background-move bullets as dated above. Koloft dependents: the fork gate and session_id
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
  `CLAUDE_CONFIG_DIR` does NOT isolate credentials on macOS (official docs —
  credentials always go through the system Keychain). `claude setup-token` is the
  official login flow: it prints the authorization URL and, on success, the token on
  its output. **CC's Bash-tool children inherit the parent claude's full env**, so
  nested claude calls inherit the injected token (inferred, not checked).
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
  Apart from the 2.1.266 check: inferred, not checked.
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
  200k. A 5-minute cache write costs 1.25× input and a cache read 0.10× input, as
  ccusage applies them. Sources (2026-07): the Anthropic model catalog (through the
  local claude-api skill reference) for current families, Anthropic's public pricing
  page for older Opus/Sonnet, and the Sonnet 5 change noted against CC 2.1.243. The Opus
  5 and Opus 5.5 rows: the same skill's catalog (cached 2026-06-24), read 2026-09-24.
  Transcripts on the dev Mac (sweep 2026-09-24) record `message.model` values
  `claude-opus-5` and `claude-opus-5-5`, bare, with no date suffix.

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
  `perl -e "sleep 300"` does not match the check.
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
- **A background subagent's own background shell stays in the MAIN session's Stop list
  after the subagent ends — in interactive mode.** Measured 2026-10-08 on CC 2.1.295,
  interactive TUI driven through a pty, with Stop/SubagentStop hooks that saved their input:
  the subagent ran `perl -e "sleep 100"` with `run_in_background` and returned at once. Its
  SubagentStop listed the shell (`{"id":"b3u7bx7sz","type":"shell","status":"running",…}`);
  the main session's next Stop listed the same id, and the shell was a `zsh -c … eval` child
  of the main claude with fd 1 on `<scratch>/tasks/b3u7bx7sz.output` — the same shape as a
  main-thread background shell. When it ended, the subagent woke (another SubagentStop), then
  the main session took one more turn whose Stop listed `[]`. A `claude -p` run on 2.1.294
  (issue #382) listed `[]` at the main Stop instead; whether the difference is the mode or the
  version is not probed yet.
- **`Notification` payloads carry no task list** (124 "Claude is waiting for your
  input" nudges, none with `background_tasks`), and `-p` mode exits with a background
  shell still running, firing one Stop.
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
  `"matcher":"auth_success"`. That `worker_permission_prompt`, `elicitation_dialog` and
  `elicitation_url_dialog` also mean the run waits on the person is read from their
  names only; their payloads are not measured.

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
Probes P1–P7. Flag spellings quoted from `claude --help` of the same build.

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
  gate (a throwaway `$HOME` carrying only that key started with no screen), so anything
  that wants to know whether this Mac will stall must check BOTH.
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
  `medium`, `high`, `xhigh`, `max`.
- **A new directory always asks for trust on its first launch**, and
  `--dangerously-skip-permissions` does not skip that question ("Quick safety check: Is
  this a project you created or one you trust?", default answer "No, exit"). A worktree
  created under an already-trusted repo inherits the trust and asks nothing. Anything
  automated that launches CC in a folder for the first time therefore stalls on a
  question. The answer is recorded in `~/.claude.json` as
  `projects[<absolute path>].hasTrustDialogAccepted: true` (key name read off the
  2.1.263 binary with `strings`, 2026-09-06), and ancestors count. `claude --help`
  (2.1.281) adds that `-p`, or a stdout that is not a TTY, skips the trust dialog.
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

Koloft dependents: the scheduled-jobs runner's launch line and the shim's new-session
branch (`src/main/shim.ts`), `src/main/claudeArgs.ts`, `src/main/skillList.ts`,
`src/main/claudeTrust.ts`, the env scrub in `src/main/ptyManager.ts`,
`src/main/leftovers.ts`, the warm-up `claude -p ok --max-turns 1` in
`src/main/remote/launch.ts`, and the remote launch and trust in
`src/main/host/sshHost.ts`.

## §10 The official install script (`https://claude.ai/install.sh`)

How established: the script as served on 2026-09-08 was fetched and read, alongside
the official install docs; Claude Code 2.1.263 was the current version that day. Not
re-measured against a running install.

- **It is `#!/bin/bash`** (uses `[[ ]]` and `=~`), so `sh` cannot run it — a machine
  without bash needs bash installed first. It needs `curl` or `wget` and `sha256sum` or
  `shasum`, detects `x86_64` / `aarch64` and musl by itself, **refuses to run under
  `sudo`** (plain root is fine), and installs a self-contained native binary to
  `~/.local/bin/claude`, so a machine with claude need not have node.
  **The native installer adds `~/.local/bin` to PATH in `~/.zshrc`**, which only an
  interactive shell reads (inferred, not checked).

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

Koloft dependents: `ensure.sh` in `src/main/remote/install.ts` (installs bash first —
through `sudo` unless root or Homebrew — pipes the install script to plain `bash`,
never through `sudo`, and treats node as a separate, non-fatal step); `tabs/<tab>.sh` in
`src/main/remote/launch.ts`, only when Koloft itself supplied the login, writes the
onboarding flag and runs `claude -p ok --max-turns 1` once when
`cachedGrowthBookFeatures` is missing.

## §11 Session registry (`~/.claude/sessions/`)

How established: the shape from two entries looked at on this Mac, 2026-09-18, CC
2.1.276, re-read on 7 entries 2026-09-24, CC 2.1.281; the lifecycle from 7 live
sessions plus a tmux probe, 2026-09-23, CC 2.1.281 (bullets below).

- **A session writes `~/.claude/sessions/<pid>.json`** with keys `pid, sessionId,
  cwd, startedAt, procStart, version, peerProtocol, peerFeatures, kind, entrypoint,
  pidDomain, messagingSocketPath, name, nameSource, nameSince, status, updatedAt,
  statusUpdatedAt`. Values seen: `kind: 'interactive'`, `entrypoint: 'cli' | 'sdk-cli'`,
  `nameSource: 'derived' | 'user'`, `status: 'busy' | 'idle'`. A sibling
  `<pid>.<sha256>.key` sits next to each one. Re-read 2026-09-24 on CC 2.1.281: 7
  entries, the same 18 keys, `entrypoint: 'sdk-cli'` on 3 of them.
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
    runs.
  - `procStart` is `ps -o lstart=` for that pid printed in UTC (`TZ=UTC`,
    e.g. `Wed Sep 23 20:29:08 2026`). So "pid alive and its UTC `lstart` equals
    `procStart`" tells a live entry from a stale one whose pid was reused. Re-checked
    2026-09-24 on CC 2.1.281: `TZ=UTC ps -o lstart= -p <pid>` equalled `procStart`
    for 7 of 7 entries.

Koloft dependents: `src/main/claudeSessionRegistry.ts`, read before resuming a
session; `restoreResident` in `src/main/index.ts`, which starts the Keep running
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
- **`--add-dir <dir>` also loads `<dir>/.claude/skills`** (listed without a prefix). It
  also opens that folder to the model's file tools.
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
    `body` (the bare body).
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
  - A busy receiver with a mismatched mode, and a receiver not in bypass mode, were not
    tried.
- **A message reaches a receiver whose turn ended with background work still running.**
  2026-10-08, CC 2.1.294, interactive receivers in a pty with a scratch `HOME` and an
  OAuth token, `--dangerously-skip-permissions`, model haiku. One receiver's first turn
  started `sleep 90` with the Bash tool's `run_in_background: true` and ended; 5 s later a
  `bypass` envelope written to its socket was answered 1.3 s after the write. A control
  receiver with no background work answered in 1.0 s.

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
  session that had answered a question in the terminal left its row cold.
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
  (2026-10-04, CC 2.1.289: the transcript's `permission-mode` record said `"auto"`), and
  in it a `Bash` `touch` ran with no dialog. `permissions.defaultMode: "default"` in
  `~/.claude/settings.json` brought the dialog back.
- **The `Notification` hook (`permission_prompt`) comes about 6 s after
  `PermissionRequest`** for the same dialog (7.7→13.8 s, 6.4→12.4 s, 7.0→13.0 s in three
  runs), also for a plan in `bypassPermissions`.
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
- **The same holds in an interactive session.** 2026-10-08, CC 2.1.294, the
  `discord-real-smoke` case for a Claude conductor: Koloft's own gate, a pty session
  with `--dangerously-skip-permissions`, asked to write a file — the file was not
  written and the transcript held `PreToolUse:<tool> hook error`.
- **The hook's input names the transcript.** 2026-10-09, CC 2.1.295, `claude -p` with a
  `PreToolUse` hook that logged its input, asked to Write a file then Edit it: each
  input held `session_id`, `transcript_path` (absolute,
  `~/.claude/projects/<folder>/<session id>.jsonl`), `cwd`, `permission_mode`,
  `hook_event_name`, `tool_name`, `tool_input` (`file_path` absolute for Write and Edit)
  and `tool_use_id`. The auto-memory folder is `memory/` beside that transcript (seen
  for Koloft's global conductor).
- Not run: a `Task` subagent's own tool calls under the hook.

## §16 `claude --version` and `claude update`

How established: 2026-10-08 on this Mac, each run in a fresh temporary `HOME` with
stdin closed. A native install of 2.1.250 (`bash install.sh 2.1.250`, §10), and an npm
one (`npm install -g @anthropic-ai/claude-code@2.1.250` into a user-writable prefix).

- **`claude --version` prints `2.1.294 (Claude Code)`** — the version first, then a
  space — and returns at once (`time` shows 0.00 s native, 0.12 s for the npm install),
  so a check on every launch costs next to nothing.
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
  would leave an npm install that `claude update` cannot lift to it.

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
- **The interactive screen does not show the text.** While the hook runs, the spinner line
  reads `(running UserPromptSubmit hook · 0s)`; after that only the prompt and the reply
  are drawn.

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
