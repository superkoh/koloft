# Claude Code contract ledger

Measured facts about Claude Code (CC below) that Koloft depends on and that **reading
Koloft's own code cannot reveal**. Every entry carries its observation date, CC version,
and how it was established; any entry can drift when CC upgrades — the canary run
(below) watches for structural drift, and a disproven entry is corrected in place,
never kept for history. This file records only observations of the
external system; Koloft's own mechanism rationale lives in code comments and behavioral
claims live in tests (doctrine: the document-retirement rule in CLAUDE.md). Entries
were extracted from earlier design notes; sources are named per section.

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
    `prompt_input_exit` (3/3 repeats, E1/E2/E8)
  - `logout` → `logout`
  - SIGHUP → `other` (E6); a finishing `claude -p` run → `other`
  - `/clear` → `clear` (process stays alive; a new-id SessionStart with
    source=`clear` follows on the same tab)
  - in-TUI `/resume` switch → `other` (process stays alive; new-id SessionStart with
    source=`resume` follows, E3)
- **Full enums** (read from CC 2.1.238 source, 2026-08-22): SessionEnd reason =
  `clear / resume / logout / prompt_input_exit / other`; SessionStart source =
  `startup / resume / clear / compact / fork`. Note `compact` fires **mid-turn** never reseed run-state from it. The bullets above are observed mappings; the enums
  are the value space.
- **auto-compact restarts in place with the SAME session id** (E1 could not produce an
  id change; if a future CC compact ever changes the id, whitelist its source then —
  Koloft's rebind guard `nextId !== prevId` is naturally immune to the same-id case).
- **On exit CC prints a resume hint, and what it quotes depends on the session**:
  `Resume this session with: claude --resume <id>` for a session with no name, but
  `claude --resume "<name>"` once the session was given a `--name`, and
  `claude --worktree <name> --resume "<name>"` after a keep-the-worktree exit
  (measured 2026-09-03 on 2.1.259 — four exits, named and unnamed, §4).
- **A resumed session's SessionStart hook reports the LAUNCH directory as cwd, not the
  worktree** — the re-enter happens after the hook (E8). Row labeling / reportedCwd
  logic must account for this.
- **A running SessionStart hook is now visible and can be cut short** (changelog, read
  2026-09-18, not measured): 2.1.268 — `--continue`/`--resume` show the conversation at
  once instead of waiting for SessionStart hooks; 2.1.271 — the spinner names the
  running hook with elapsed time, and Esc cancels a prompt waiting on one. A hook that
  does slow work before its report may never report — Koloft's hook does nothing slow
  before its report (no `claude --version` probe).

Evidence: live experiments E1–E8, 2026-08-10, claude 2.1.227; enums read from CC 2.1.238 source on 2026-08-22. Koloft dependents: the `EVICTING_END_REASONS` whitelist
and its comment in `src/main/index.ts`; `workspaces.stampLive` (the launch-directory
entry above); `test/e2e/fixtures/fake-claude.js` mimics this section entry by entry.

## §2 Transcript on disk

- **Lazy write: the jsonl is only created at the first user message**, while
  SessionStart fires with the jsonl path already filled in — a non-empty path ≠ an
  existing file (a 77s gap was measured between bind and first write). **Exception:
  `/clear` writes the new id's jsonl immediately**, so the "after /clear, before the
  first prompt" window does not actually exist. (Verified live 2026-08-24, landed with
.)
- **A worktree session's transcript lands in the ROOT checkout's slug** (re-verified in
  E2: the jsonl sits in the launch cwd's slug, while an empty worktree-slug directory
  is also created) — but **slug placement is unreliable as a signal**: of 535 existing
  transcripts, 116 carry a worktree-state record — 90 in the repo-root slug, 26 in the
  worktree's own slug, both groups spanning the same CC versions (2.1.220–227). The
  correct model is two independent axes: the slug the transcript lives in decides the
  resume starting directory; the presence of worktree-state decides whether the
  re-enter machinery applies.
  **What moves it is the exit** (measured 2026-09-03, 2.1.259): while a `-w` session is
  alive its jsonl sits in the WORKTREE's slug, and a clean `/exit` — Keep or Remove —
  relocates it to the root checkout's slug, leaving the worktree slug directory empty
  (§4). A session that was killed never moves. That is very likely what the 90-vs-26
  census split above is: exited runs versus killed ones.
- **worktree-state record shape**:
  `{"type":"worktree-state","worktreeSession":{originalCwd, preEnterOriginalCwd, worktreePath, worktreeName, worktreeBranch, originalBranch, originalHeadCommit, sessionId}}`.
  Position census: 86/116 on line 4, 23 on lines 2–3, deepest at line 236; 2/535 sit
  beyond the 256KB head-scan window (treated as unbound — accepted fallback).
  **`worktreeSession.sessionId` differs from the file's own id in 14/116 samples**
  (the binding is inherited from a predecessor session) — never key on it (pinned in
  `src/main/sessionAggregate.ts`).

- **Message-line field vocabulary**: jsonl message lines carry
  `cwd / gitBranch / timestamp / sessionId / version`; a `summary` record is NOT
  guaranteed to exist (titles need a fallback chain). **`gitBranch` can lag** — a
  worktree session was measured recording `main` — so bucket ownership must come
  from the directory the file lives in, never from that field. (V1, CC 2.1.225.)
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
  usually absent at bind time; slug and sessionId derive from the jsonl path). Its
  sibling `tasks/` holds full subagent transcripts (single files reach MBs) — Koloft
  lists scratchpad as a virtual tree root and deliberately never exposes `tasks/`.
- **A live session can move to another checkout, and the transcript moves with it.** The
  `EnterWorktree` / `ExitWorktree` tools relocate a session mid-conversation; on disk that
  is ONE `rename` of the jsonl into the destination directory's slug — **the inode is
  preserved** (measured: 89888511 → 89888511; a file rebuilt under the same name gets a
  new one), and **no hook fires at all**, so the SessionStart path that is Koloft's only
  other source of a transcript path never runs. Census: 191/965 transcripts carry a
  `relocated` record, 652 records in all — 267 naming a worktree, 385 naming a root
  checkout. Koloft therefore follows the inode, never a directory comparison (it would
  chase a plain `cd`: one real session hopped between a workspace and three vendored
  clones 11 times with the transcript never moving).
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
  always the main loop's own doing, and needs no "was this a subagent?" filter. **This is
  the entry most likely to drift**: if CC relaxes it, one is needed (noted at
  `sessionTracker.followRelocation`).
- **Tool file paths are all but always absolute**: 17 relative out of 18,035 (0.094%),
  every one a `Read`, all in a single repository. A relative one means a file under the
  directory CC stood in on that line, so it has to be resolved as it is read, once.
- Retention and deletion of transcripts are CC's own (`claude project purge`) —
  Koloft never invents a second lifecycle.
- **Concurrent sessions used to revert each other's `~/.claude.json` writes**, resetting
  a workspace's trust answer (the key is in §9). The 2.1.259 changelog says fixed
  ("workspace trust no longer resets"); changelog claim, read 2026-09-18, not measured.

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
  id, no fork (E3).
- **`--resume <id> -w <name>` compose**: CC creates (or enters) the named worktree and
  resumes there with full history (E4); an existing name is entered and used as-is.
- **Resume with a binding, worktree present** → CC re-enters after verification
  (symbolic-ref / `status --porcelain` / baseline compare, with a possible
  `git reset --hard` back to baseline — a loaded gun against a same-named NEW
  worktree); **worktree missing** → resumes in the current directory without isolation
  and clears the binding; **belongs to another repo** → refused; poisoned → refused.
  **There is no auto-rebuild path** (CC 2.1.227 binary evidence).
- **Re-entering a dirty same-branch worktree is silent and lossless** (E8: dirty files
  survive). The precise trigger surface of the baseline reset was never fully mapped —
  Koloft's dialog warning is worded for the worst case.
- **A same-named old-vs-new worktree is fundamentally undecidable**: the branch name is
  derived from the worktree name (`worktree-<name>`), so a reused name reuses the
  branch, and the disk carries no ownership trace — when it can't be decided, ask the
  human (the basis of Koloft's D7 call).

- **`-w <name>` creation semantics** (CC 2.1.226, temp-repo runs 2026-08-08):
  creates `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>` and
  `git worktree lock`s it immediately; CC locks every worktree it runs in
  (`git worktree remove` needs an unlock first — the user's/CC's business). Same
  name again = silent reuse, exit 0. **Reuse recognizes ONLY the
  `.claude/worktrees/` namespace**: handing `-w` the name of a worktree living at
  any other path mis-creates a same-named NEW worktree — so "open an existing
  worktree" must cd into its checkout and run bare `claude`, never `-w`. A bare
  `-w` with no name invents a random three-word name. A `--tmux` companion flag
  exists ("Create a tmux session for the worktree"; it refuses to run without `-w` —
  help text and binary strings, CC 2.1.263, 2026-09-06; unused by Koloft).
- **CC's background retention sweep once removed worktrees under `.claude/worktrees/`
  that the person had created by hand**; the 2.1.246 changelog says it no longer does
  (changelog claim, read 2026-09-18, not measured). Koloft's worktrees live exactly
  there.

Evidence: experiments E3/E4/E8, 2026-08-10, plus `strings` analysis of the claude
2.1.227 binary. Koloft dependents: the `sessions:resumePlan` decision tree;
`createClaudeTab`'s composed `--resume`/`-w` construction.

## §4 Worktree session exit

- **2.1.265 (measured 2026-09-08, Linux, over Koloft's remote path): an UNCHANGED
  worktree is removed silently again on `/exit` — no Keep/Remove page, dir and branch
  gone, transcript relocated to the root slug (with messages) or never written (none).**
  So the prompt is only certain for a dirty tree; the bullets below describe 2.1.259.
- **`/exit` ALWAYS asks, even when nothing changed** (measured live on 2.1.259; up to
  2.1.227 an unchanged worktree was cleaned up silently, with no prompt — E2/E7b/E8
  recorded that, and it is gone). The screen is titled "Exiting worktree session" and
  its second line depends on the tree:
  - clean → `This session was named "<name>". Keep the worktree to resume it later, or
    remove it to clean up.` with options `1. Keep worktree — Stays at <path>` and
    `2. Remove worktree — Clean up the worktree directory.`
  - dirty → `You have N uncommitted files. These will be lost if you remove the
    worktree.` with `2. Remove worktree — All changes and commits will be lost.`
  That two-choice shape is the non-tmux one: a `--tmux` session adds "Keep worktree
  and tmux session" / "Keep worktree, end tmux session" (binary strings, CC 2.1.263,
  2026-09-06) — Koloft never passes `--tmux`, so `fake-claude.js` emulates only the
  two-choice prompt.
- **Exit means exit — there is no "respawn in place"**: whichever choice is taken, the
  process simply exits with reason=`prompt_input_exit` (E2/E8). Historical "respawn"
  sightings were the old shell-tab shape starting a second claude after the first died
  — not CC behavior.

  **Keep is option 1 and pre-selected in both cases**, so a run nobody answers keeps
  its worktree. Choosing Remove deletes the directory, the git registration and the
  branch `worktree-<name>` — dirty files included.
- **A clean exit UNLOCKS the worktree.** CC locks every worktree it runs in (§3), but
  after a Keep or a Remove the lock is gone, so a later `git worktree remove` needs no
  `unlock` first. A worktree whose session was killed instead stays locked.
- **The transcript SURVIVES either choice — it is moved to the ROOT checkout's slug**
  (the `relocateSessionTranscript` rename of §5): full content, the `custom-title`
  record intact, while the worktree's own slug directory is left behind **empty**.
  This replaces the 2.1.226 behavior where the cleanup deleted the worktree project's
  whole slug directory. On 2.1.259 a worktree run never loses its transcript, so
  orphan-bucket rescue applies to every exited worktree run, and a sidebar row that
  vanishes with the worktree is no longer expected. A killed (never exited) session's
  transcript stays in the worktree slug.
- **Exit means exit — there is no "respawn in place"**: on either choice the process
  simply exits with reason=`prompt_input_exit` (E2/E8; re-verified 2026-09-03 on
  2.1.259 for Keep, Remove and dirty-Remove). Historical "respawn" sightings were the
  old shell-tab shape starting a second claude after the first died — not CC behavior.
- SIGHUP is the opposite of an exit: worktree directory kept (still locked), branch
  kept, transcript left in the worktree slug, SessionEnd reason=`other`, exit code 129
  (2026-09-03, 2.1.259 — confirms §1).
- **After a session LEAVES a worktree, no line ever carries a directory again** — 195/195
  on-disk sessions (2026-09-10, CC 2.1.267): past the emptying `worktree-state` there is
  not one record with a `cwd`. So where a departure landed can only be read from the
  `relocated` record (§2), never from the session's own current directory, which stays
  pointed at the checkout it left. In the same sweep, leaving a worktree was the session's
  LAST act in all 195 cases — carrying on afterwards was never observed, so it needs to
  work but deserves no machinery of its own.

Evidence: experiments E2/E7b/E8, 2026-08-10, claude 2.1.227, **superseded for the
prompt, the lock and the transcript by four live worktree exits on 2026-09-03, claude
2.1.259** (M0 probe P5: `-w n5/n6/n7/n8/n9` in a throwaway repo, driven in a
pty, checked with `git worktree list`, `git branch` and `ls ~/.claude/projects/<slug>`).
Koloft dependents: the §1 whitelist eviction path; `fake-claude.js`'s dirty-tree exit
prompt emulation.

## §5 fork and background sessions (claude daemon)

- **`/fork` = "Copy this conversation into a new background session and keep working
  here"** (official description, CC 2.1.238): a brand-new session id plus a full
  transcript copy (3.0 MB measured); the title inherits the parent's plus a `⑂`
  suffix. **Hosted by CC's resident process (claude daemon), it does NOT die with the
  window** (measured alive nearly two days, waiting for an answer).
- **The copy inherits the parent tab's hook settings**, so every report it sends claims
  the parent tab's identity; its SessionStart carries `source=fork` (single live
  sample, 2026-08-20); **its self-stop fires SessionEnd reason=`prompt_input_exit`**
  (the job_stop_self path, read from CC source) — which lands inside any
  "user deliberately quit" whitelist, so only a session-id identity check is safe

- **State & enumeration**: `~/.claude/jobs/<short-id>/state.json` + `timeline.jsonl`
  (carrying `forkParentSessionId`, `needs`, `state`, tokens). **state.json's `state`
  is a frozen snapshot — file content ≠ process liveness, and a non-growing transcript
  ≠ an exited session**. The only reliable liveness sources are
  `claude agents --json` (official scripting interface; supports `--cwd` filtering and
  `--all`) plus `ps -p <pid>`. ⚠️ Measured: `claude agents --json` stdout is polluted
  by statusline output ahead of the JSON — parse from the first `[`.
- **One-step attach exists: `claude attach <id>`** (added in 2.1.251 per the changelog,
  alongside `logs / stop / respawn / rm` in `claude --help`). Measured on this Mac,
  2026-09-18, CC 2.1.276 — `claude attach --help` prints: `Usage: claude attach <id> /
  Open the background session in this terminal. ← returns to agent view, Ctrl+Z drops
  back to your shell. The session keeps running either way.` The changelog also says a
  direct `--resume` of a running background session is refused with a message naming
  `claude attach <id>` (not re-measured). `claude --resume <id> --fork-session` still
  makes ANOTHER copy, it is not a takeover.
- **Interactive sessions have NO re-entry guard**: resuming an already-running normal
  session is not blocked — the same session can be written by two processes at once
  (measured loss, 2026-08-20). The "already running … split-brain" refusal belongs to
  claude remote-control, not to resume. This gate can only be built on Koloft's side.
- **On a cwd change CC relocates the transcript wholesale**:
  `relocateSessionTranscript` → `fs.rename` (with `{replace:true}` in newer storage) —
  **an existing target is silently overwritten**, the proven mechanism of history loss
  (~1700 records lost, 2026-08-20). The old file keeps a `relocated` record as the
  move's breadcrumb. **CC 2.1.251 changelog says fixed** ("session transcripts being
  silently overwritten when a directory change relocated a session onto an existing
  same-ID transcript"); not re-measured; Koloft's inode-following (§2) stands.

Evidence: on-machine diagnosis 2026-08-22 (CC 2.1.238 / app 0.13.1), CC source
reading, and the 2026-08-28 implementation review. Koloft
dependents: the fork gate and session_id extraction in `src/main/hooks.ts`'s injected
script (commented in detail there); `src/main/hookRouting.ts`. Unshipped remainder is
collected in a follow-up issue.

## §6 Settings precedence & the statusLine protocol

- **`--settings <file>` sits at the CLI-args tier and out-ranks user / project / local
  settings, merging per key** — source order `userSettings < projectSettings <
  localSettings < flagSettings` (verified in the installed 2.1.224 binary, confirmed by
  the CLI reference, 2026-08-07). This is the seam Koloft's entire per-tab injection
  (hooks + statusLine) rests on. The one tier above it: **managed (enterprise)
  settings out-rank `--settings`** — accepted, no managed policy on target machines.
- **The `statusLine.command` string is shell-interpreted by CC** (paths need quoting),
  and **CC ≥2.1.153 exports `COLUMNS` before running it**. CC pipes its status JSON to
  the command's stdin and **treats stdout-pipe EOF as "render done"** — any orphaned
  process holding the pipe's write end delays the visible render for its full lifetime
  (measured: 10.06 s → 0.83 s cold / 0.18 s warm after the fix; the wrapper's watchdog
  detachment in `src/main/statusline.ts` is the load-bearing part).
- statusLine (like hooks) only runs after the workspace trust dialog is accepted, and
  `disableAllHooks: true` kills it — together with the session detection Koloft's hooks
  provide (pre-existing condition, out of scope).
- CC also supports `subagentStatusLine` — unused by Koloft, nothing designed.
- **The status JSON carries `effort: { level }`** (the session's thinking effort:
  low / medium / high / xhigh / max; Ultracode reports as xhigh). Read from the
  status-object builder in the installed 2.1.263 binary via `strings`, 2026-09-06.
  Koloft's default theme shows it through ccstatusline's `thinking-effort` widget,
  which prefers this field over its transcript / settings.json fallbacks — so the
  segment is per session, not confused by concurrent sessions.
- **The status JSON also carries `rate_limits` and `prompt_cache`** (read from the
  statusLine JSON doc block in the 2.1.276 binary with `strings`, 2026-09-18; not yet
  seen live): `rate_limits: { five_hour | seven_day | spend_limit: { used_percentage,
  resets_at } }` and `prompt_cache: { warm, caching_observed, ttl: '5m' | '1h',
  expires_at, requests, misses, expected_rebuilds, hit_ratio, cache_write_tokens,
  miss_recache_tokens, last_miss_at, last_miss_cause: { causes: [] } }`. Unused by
  Koloft today; a follow-up may read `prompt_cache`.

Evidence: three parallel investigations + two local experiments, 2026-08-07, CC
2.1.224; render-latency mechanism found in live
testing (commit 1dabc23). Koloft dependents: `src/main/statusline.ts` (wrapper comments
carry the mechanics), `writeTabHookSettings` in `src/main/hooks.ts`,
`test/e2e/statusline.spec.ts`.

## §7 Anthropic API: usage headers, auth env, model fallback

- **Probe contract**: a `max_tokens: 1` POST to `/v1/messages` returns
  `anthropic-ratelimit-unified-*` response headers carrying the server's exact
  per-bucket usage: 5h (`u5/s5/r5`: utilization / status / reset), 7d, and 7d_oi
  (fable) — utilization, status and reset come from the same header group, no extra
  request. **The Claude Code system prompt is REQUIRED for an OAuth token to be
  accepted at all.** Only per-bucket status is trustworthy: the top-level
  unified-status follows the 7d_oi bucket under a fable probe and would misreport a
  fable-full account as fully unavailable.
- **Header edge behavior** (real curl runs, 2026-08-17): non-2xx responses
  carry NO unified headers ⇒ parse headers before looking at the status code;
  zero-utilization buckets still return status headers (the group is atomic — no
  "utilization present, status missing"); **utilization can exceed 1** (overage);
  no header field reveals plan/quota size — only percentages, so any cross-account
  aggregation is equal-weight by data ceiling, not by choice. Headers seen live but
  not parsed yet: `overage-disabled-reason`, `representative-claim`, and one logged
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
  deterministic failures (400/403/404) mean no fable, transient shapes (408,
  headerless 429) mean re-probe, never stamp. A claude-fable-5 probe takes 4.0–5.1 s
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
  `CLAUDE_CONFIG_DIR` does NOT isolate credentials on macOS (official docs —
  credentials always go through the system Keychain). `claude setup-token` is the
  official login flow: it prints the authorization URL and, on success, the token on
  its output. **CC's Bash-tool children inherit the parent claude's full env**, so
  nested claude calls inherit the injected token (same account, no re-balancing —
  by inheritance, not interception).
- **CC's safety classifier can silently swap the model**: a blocked fable request is
  re-run on Opus and the session pinned there — any external assumption about which
  model a session runs is unreliable; the embedded statusline's model widget is the
  only trustworthy observation point.
- **CC's fable consent prompt guards only the interactive first use**: `-p`, the Agent
  SDK, and already-consented users pass with zero protection, and a bare fetch (Koloft's
  main-process probe) is structurally outside the consent mechanism entirely.

Evidence: two years of shell-prototype quota economics productized 2026-08-07; probe
edge shapes curl-verified 2026-08-17; latency measured 2026-08-19-20;
classifier fallback established in the rev3 routing review, 2026-08-20. Koloft dependents:
`src/main/usageProbe.ts` (header comment carries the parse doctrine),
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
  `bun listen.ts` was found 11.5 h into its run holding no listening socket — age is
  a needed server tell, a port is only the fast one.
- **`Notification` payloads carry no task list** (124 "Claude is waiting for your
  input" nudges, none with `background_tasks`), and `-p` mode exits with a background
  shell still running, firing one Stop.

Evidence: 2026-09-05, CC 2.1.261 — binary reading (`smr` / `Vp` / `qDe` in the
Stop-hook module), 251 real Stop records in Koloft's run-state logs cross-checked
against their transcripts, `lsof`/`ps` on live sessions, and a headless probe
(`printf <prompt> | claude -p --settings <stop-hook settings> --allowedTools Bash`;
the prompt must ride stdin or `--allowedTools` swallows it). Koloft dependents: the
`bgl` list in `src/main/hooks.ts`'s injected script, `src/main/taskProcs.ts`,
`judgeReported` in `src/main/sessionTracker.ts`.

## §9 Launch flags for a run nobody is watching

How established (all of §9): live pty runs of the real binary on 2026-09-03, CC
2.1.259, on a throwaway one-commit git repo, with an own `--settings` hook file
logging `SessionStart / UserPromptSubmit / Stop / SessionEnd` with millisecond stamps,
and the resulting `~/.claude/projects/<slug>/<id>.jsonl` read back record by record.
Issue M0 probes P1–P7. Flag spellings quoted from `claude --help` of the same
build.

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
  record that typing it produces. This is the seam that lets Koloft start a job's first
  turn without ever writing into a pty.
- **`--permission-mode bypassPermissions` starts on its own ONLY on a machine that has
  already accepted the bypass warning** — the session then opens straight at the prompt
  with the footer `⏵⏵ bypass permissions on (shift+tab to cycle)` and answers
  immediately. On a machine that has not accepted it, this spelling shows the same
  one-time "WARNING: Claude Code running in Bypass Permissions mode / Yes, I accept"
  screen as `--dangerously-skip-permissions`, BEFORE SessionStart, so anything automated
  stalls there (measured 2026-09-08 on 2.1.263 with a throwaway `$HOME`, both spellings,
  a pty probe: identical screen). The earlier reading here — "starts on its own, no
  screen" — was taken on this Mac's real `$HOME`, which had accepted it long ago;
  swapping Koloft's "never ask" to this flag therefore fixes nothing.
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
- **Spawn to SessionStart is well under a second on this machine**: 0.250 / 0.272 /
  0.293 / 0.265 / 0.381 s over six launches with the user's real MCP config loaded (no
  `--strict-mcp-config`), 0.429 s through Koloft's own shim with the account balancer
  and the Keychain read live. Caveat that keeps this honest: **no MCP server is
  configured anywhere on this machine**, so these numbers say nothing about a machine
  that loads MCP servers at startup. Koloft's 90 s start deadline for a scheduled run
  has roughly 200× headroom against the worst of these.
- **`--model` out-ranks an `ANTHROPIC_MODEL` in the environment.** With
  `ANTHROPIC_MODEL=claude-haiku-4-5-20251001` exported and `--model sonnet` on the
  command line, every assistant record reported `claude-sonnet-5`; the env var alone
  gave `claude-haiku-4-5-20251001`, the flag alone gave `claude-sonnet-5`. That matters
  for the custom-endpoint accounts of §7: the shim pins all six model slots to the
  endpoint's own model, and any `--model` Koloft adds would override that pin and ask
  the endpoint for a `claude-*` model it cannot serve. Help text: `--model <model>
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
- **Flag shapes worth not re-deriving** (from `claude --help`, 2.1.259). Takes a
  required value: `--agent --append-system-prompt --autocompact --betas --debug-file
  --effort --environment --fallback-model --input-format --json-schema
  --max-budget-usd --model -n/--name --output-format --permission-mode
  --permission-prompts --plugin-dir --plugin-url --session-id --setting-sources
  --settings --system-prompt --system-prompt-snapshot`. Takes an **optional** value
  (so the next token may be a real argument): `-w/--worktree`, `-r/--resume`,
  `-d/--debug`, `--cloud`, `--from-pr`, `--prompt-suggestions`, `--remote-control`,
  `--teleport`. **Variadic**: `--add-dir --allowedTools --disallowedTools --betas
  --file --mcp-config --tools`. Note `-n` really is CC's short form of `--name`, so any
  argv scanner that skips a flag's value has to know it. `--permission-prompts none` is a
  value that flag takes since 2.1.259 (changelog, read 2026-09-18; not measured here).
- **A new directory always asks for trust on its first launch**, and
  `--dangerously-skip-permissions` does not skip that question ("Quick safety check: Is
  this a project you created or one you trust?", default answer "No, exit"). A worktree
  created under an already-trusted repo inherits the trust and asks nothing. Anything
  automated that launches CC in a folder for the first time therefore stalls on a
  question. Pinning a workspace in Koloft is not the same as having opened claude in it,
  so a scheduled job there dies at the start deadline every time; the answer is recorded
  in `~/.claude.json` as `projects[<absolute path>].hasTrustDialogAccepted: true` (key
  name read off the 2.1.263 binary with `strings`, 2026-09-06), and ancestors count.
  Koloft READS that file to warn in the jobs form and to explain the deadline
  (`src/main/claudeTrust.ts`); it never writes it — the answer is the person's to give.
- **A child claude inherits the parent's session markers and stops writing its
  transcript.** With `CLAUDE_CODE_CHILD_SESSION=1` in the environment the launched
  session prints `⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
  marker · restart with CLAUDE_CODE_FORCE_SESSION_PERSISTENCE…` and creates no jsonl at
  all. Any Koloft code path, test or probe that starts claude from inside a claude
  session and then expects a transcript must unset it (the sibling markers
  `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, `CLAUDE_EFFORT`,
  `CLAUDE_CODE_MESSAGING_SOCKET/TOKEN` leak effort and messaging the same way).

Koloft dependents: the scheduled-jobs runner's launch line and the shim's new-session
branch (`src/main/shim.ts`), `src/main/claudeArgs.ts`, `src/main/skillList.ts`.

## §10 The official install script (`https://claude.ai/install.sh`)

How established: the script as served on 2026-09-08 was fetched and read during the
remote workspace design review, alongside the official install docs;
Claude Code 2.1.263 was the current version that day. Not re-measured against a
running install.

- **It is `#!/bin/bash`** (uses `[[ ]]` and `=~`), so `sh` cannot run it — a machine
  without bash needs bash installed first. It needs `curl` or `wget` and `sha256sum` or
  `shasum`, detects `x86_64` / `aarch64` and musl by itself, **refuses to run under
  `sudo`** (plain root is fine), and installs a self-contained native binary to
  `~/.local/bin/claude`. Having claude therefore says nothing about node being present
  — anything that needs node (Koloft's statusline) has to bring or find its own.

- **A fresh install shows the first-run "Select login method" page even when
  `CLAUDE_CODE_OAUTH_TOKEN` is set** — the token is used (the process fetched
  `~/.claude/policy-limits.json` with it) but the onboarding still asks. The page is
  gated on `hasCompletedOnboarding: true` in `~/.claude.json` (key read off the 2.1.263
  binary with `strings`; the same key is `true` on a machine that has been through the
  page). Measured 2026-09-08 on a bare Ubuntu 24.04 container, CC 2.1.263, during the
  first manual remote-workspace round.

- **The very first run on a machine draws the old flow layout (prompt right under the
  output, no alternate screen); every later run uses the full-screen layout with the
  prompt at the bottom.** The layout is gated by the server-side feature flags CC
  caches in `~/.claude.json` (`cachedGrowthBookFeatures` and friends): with a fresh
  `~/.claude.json` the process decides the layout before the flags arrive; bisected
  on the machine by copying ONLY those cached-flag keys into an otherwise fresh
  `~/.claude.json`, which restored the full-screen layout (tmux `alternate_on` 0 → 1).
  A resize does not re-decide it; a restart of the session does. Nothing Koloft can
  pre-seed — the flags are the server's. Measured 2026-09-08, CC 2.1.263, Ubuntu 24.04
  container.

Koloft dependents: `ensure.sh` in `src/main/remote/install.ts` (installs bash before
running the script, never through sudo, and treats node as a separate, non-fatal step);
`tabs/<tab>.sh` in `src/main/remote/launch.ts` writes the onboarding flag when Koloft
itself supplied the login.

## §11 Session registry (`~/.claude/sessions/`)

How established: two entries looked at on this Mac, 2026-09-18, CC 2.1.276. Shape
only — when an entry is written, updated or removed is unmeasured.

- **A session writes `~/.claude/sessions/<pid>.json`** with keys `pid, sessionId,
  cwd, startedAt, procStart, version, peerProtocol, peerFeatures, kind, entrypoint,
  pidDomain, messagingSocketPath, name, nameSource, nameSince, status, updatedAt,
  statusUpdatedAt`. Values seen: `kind: 'interactive'`, `entrypoint: 'cli'`,
  `nameSource: 'derived' | 'user'`, `status: 'busy' | 'idle'`. A sibling
  `<pid>.<sha256>.key` sits next to each one.
- Unused by Koloft today.
