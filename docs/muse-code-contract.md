# Muse Code contract ledger

Measured facts about Meta's Muse Code CLI (`muse`) that Koloft depends on and that
**reading Koloft's own code cannot reveal**. Claude Code, Codex and the platforms have
their own ledgers. Each entry says how it was established; a disproven entry is
corrected in place, never kept for history. Code cites a section with a `// MUSE§N`
marker.

**How everything here was established, unless a bullet says otherwise**: muse 1.4.7
(`Muse Code 1.4.7 (1.4.7-R6101.1)`), installed with its official installer, in a Linux
Docker container and in a throwaway macOS 27 virtual machine, October 2026. A terminal
was simulated with a pty driver that answers the TUI's queries. Two stand-ins for a
real model were used, neither needing a Meta account:

- `--provider echo`, a built-in model that echoes the prompt;
- a **fake model server**: `--base-url http://127.0.0.1:8787` with
  `META_API_KEY=<made-up>` and `MUSE_MODEL=fake-model`, answering `GET /muse-code/models`
  (a one-model catalog), `GET /muse-code/config` and `POST /responses` (Server-Sent
  Events in the shape of the OpenAI Responses API, with `function_call` items to make
  muse call its tools). Its runs were in Docker, where muse's Linux sandbox
  (bubblewrap) cannot start, so a plain sandboxed shell command fails there.

Re-checked on 1.4.9 (`Muse Code 1.4.9 (1.4.9-R6297.1)`) the same ways, October 2026:
the 7501 frames, the hook events and their fields, `approval/listPending`, the session
log's prompts, replies and renames, the live registry and `exec --json` are
unchanged; what changed is in the bullets that name 1.4.9.

A bullet measured only with `!cmd` (a shell command the user types into the TUI) says
so; the model's own shell tool was checked against those on macOS with the fake model
(§8). Nothing has been run against Meta's real API.

## §1 The command line

- `muse [OPTIONS] [PROMPT]` starts the TUI (text user interface); a prompt becomes the
  first message. `muse resume <session-uuid-or-name>` reopens a session in the TUI.
  `muse exec [OPTIONS] [PROMPT]` runs one prompt headless (subcommand first, its flags
  after). Root options may sit on either side of `resume`.
- Options Koloft uses: `--model <id>`, `--reasoning-effort
  none|minimal|low|medium|high|xhigh|max|ultra`, `--trust-workspace` (§10), and the
  approval and sandbox flags of §15. `--model` is refused with `--provider echo`.
- **No model names without a login.** The models come from the provider's catalog
  (`GET /muse-code/models` on the fake server; "failed to fetch model catalog", §13),
  and this Mac has no Meta login, so which ids a real account gets is **not probed
  yet**. `muse model-profile show <model>` (1.4.11, Docker, 2026-10-26) answers for any
  name, `nope-model` too, so it names nothing; its help gives `muse-spark-1.3` as the
  example, and `muse-spark-1.2` and `muse-spark-1.3` (with `-internal` and
  `-contributor` forms) are the only `muse-spark-*` strings in the binary.
- `-c KEY=JSON` sets one setting for the run; an unknown key refuses the run.
  `-c run.developer_prompt="…"` reaches the model, but only until `/clear` (macOS
  measured: the second session's request carried no developer prompt). Koloft hands
  instructions over through a hook instead (§12).
- `muse --version` prints `Muse Code 1.4.7 (1.4.7-R6101.1)`; 1.4.9 prints
  `Muse Code 1.4.9 (1.4.9-R6297.1)`.
- `muse exec --json` prints one session-stream record per line; the answer is the
  `text` of the last `run.terminal.completed` record. `--no-session-log` keeps the run
  out of the session list; `--disable-reminders` skips muse's own reminder helpers. Both
  are `exec` flags only: the TUI given `--disable-reminders` prints its help and exits.
- The installer (`curl -fsSL https://dev.meta.ai/install.sh | bash`) puts a launcher
  script at `~/.local/bin/muse`. It ends with `exec "$binary" "$@"`, so the process a
  terminal spawns becomes the muse binary itself and keeps its PID.
- **The TUI draws inline, with no alternate screen and no screen clear**, so a line
  printed before muse starts stays on row 0 above its banner and input box (2026-10-25,
  1.4.13 in the `koloft-muse-probe` Docker image, `--provider echo`, a python pty
  answering the terminal's queries, output replayed into `@xterm/headless`; inside a
  tmux pane too, PLATFORM§35).
- **On Linux muse 1.4.11, `TERM_PROGRAM=Apple_Terminal` changes nothing in what muse
  draws; only a terminal it knows by name gets synchronized output.** muse asks no
  DECRQM 2026. With no `TERM_PROGRAM` and with `Apple_Terminal` (the name in a local
  Koloft tab's environment) it wrote no `?2026h` at all, so none of its redraws was
  framed, and it wrote 160 OSC 8 links for a 160-line answer with links, 3 of 3 runs
  each. With `TERM_PROGRAM` set to `iTerm.app`, `WezTerm` or `ghostty` (1 run each) it
  wrapped its redraws in 379–386 `?2026h … ?2026l` windows, no redraw drew outside
  one, and it sent the same 160 links. Read from the binary's strings, not run: those
  names sit next to `xterm-ghostty`, `wezterm` and `alacritty` (likely `TERM` values),
  and no variable that forces frames shows up. 2026-11-08, muse 1.4.11
  (`1.4.11-R6667.1`, `koloft-muse-probe-1411`, Linux arm64, no network), a python pty
  answering like xterm.js (DA1, DA2, CPR, DSR, XTVERSION, DECRQM, OSC 10/11), a fake
  `/responses` model streaming the answer in 4-line pieces 60 ms apart, then 60 wheel
  notches and 8 PageUp/PageDown. Not run: macOS muse, muse 1.4.14. A remote tab's muse
  sees `TERM_PROGRAM=tmux` instead (§17).
- **Those unframed redraws are small, and none was shown half drawn in a Koloft
  terminal.** The same scroll recorded again (2026-11-09, same image and fake model,
  `TERM_PROGRAM=Apple_Terminal`): run straight in the pty (3 runs) muse sent 228–231
  redraws of 48.6–49.3 KB in all, 256–262 bytes for the middle one and 808 for the
  largest; inside a tmux 3.3a pane (2 runs) the outer terminal got 170–171 of 40.4 KB,
  246 and 645 bytes. Each recording was replayed 3 times, at its own pace, into a shell
  tab of a built Koloft (xterm.js `6.1.0-beta.302`, WebGL), with a marker before and
  after every redraw, once with nothing else running and once beside 6 shell tabs each
  printing `seq 1 4000` every 30 ms (load 4.5–11): 0 of 703–1392 screen paints per
  recording came between a redraw's start and end, and 0 redraws were split across two
  writes to xterm, in all 10 replays.
- **Every way a person quits the TUI exits 0**: `/exit`, `/quit`, Ctrl+C twice and
  Ctrl+D twice at an empty input box (Ctrl+C pressed 0.3 s and 0.8 s apart, Ctrl+D
  0.3 s apart). Measured
  2026-10-29, 1.4.11 in the `koloft-muse-probe-1411` Docker image, `--provider echo`,
  inside a tmux pane, the exit code read from the shell that started it. The same on
  macOS: all five exited 0, 3 of 3 runs each (2026-11-09, 1.4.14 in a throwaway macOS
  26.6.2 tart VM with no screen, `--provider echo --trust-workspace`, a python pty
  answering the terminal's queries, each quit sent 10 s after launch with the input box
  drawn, the code read by `waitpid`).

## §2 Where Muse keeps its data

- museHome (sessions, live registry) is `$XDG_DATA_HOME/muse`, else
  `~/.local/share/muse`, on macOS too.
- Settings, credentials and trust live in `$XDG_CONFIG_HOME/muse`, else
  `~/.config/muse`: `settings.json`, `auth.json`, `trust.json`, a user-scope
  `AGENTS.md`.
- Sessions live at `museHome/sessions/YYYY/MM/DD/<session-uuidv7>/session.jsonl`; a
  resumed session appends to the same file.
- `session.jsonl`: line 0 is a wrapper record; every other line is
  `{…, "payload_type": "<type>", "payload": {…}}`. The user's words of a turn are in a
  `runtime.command_intake.received` record at `payload.record.command.prompt`; the
  reply is in a `runtime.session` record with `payload.kind == "run"` and
  `payload.event.kind == "assistant_message_committed"`, at `payload.event.text`,
  written once, whole (echo and fake model). A rename is a `session.name.changed`
  record with `payload.new_name` and `payload.source: "user"`, written within 20 ms of
  `/rename`; muse also names every new session by itself (`source: "automatic"`, a
  made-up name like `iron-libra`). A
  `model_request_configured` record re-embeds the whole assembled context; it is not
  the user's words.
- Muse has no full-text search: `session/list`'s `filter.text` matches name or title
  prefixes only, and `session-index.db` holds only the first prompt.
- **No folder of the session's own drafts or plans.** 2026-10-31, `Muse Code 1.4.11
  (1.4.11-R6667.1)` in Docker (`koloft-muse-probe-1411`, no network), `muse exec
  --approval-mode never` against a fake model server: the session folder held
  `session.jsonl`, `subagent/<child>/`, `cron.db`, `approval-review/`, a `cli-*.log` and
  `.session.lock`, all Muse's own records, and the work folder stayed empty. The
  binary's own prompt text lists a session folder as `session.jsonl`, `subagent/` and
  `tool-outputs/` (large tool outputs). Its `image_generation` tool says "Results are
  saved under generated_images/", but that tool was not offered to the fake model even
  with `supports_image_generation: true` in its catalog row, so where `generated_images/`
  sits is **not probed yet** (it needs a Meta account).
- **Tokens per model call** (2026-10-19, Muse Code 1.4.9 Linux arm64, `muse exec` in
  Docker against a fake model server, numbers checked against what it sent): one
  `runtime.session` record with `payload.kind == "run"` and `payload.event.kind ==
  "model_completed"` per call, with `payload.event.model` and `payload.event.usage
  {input_tokens, output_tokens, cached_tokens, cache_read_tokens, cache_write_tokens,
  reasoning_tokens}`; `payload.run_id` is the turn. Per call, not running totals. The
  same numbers are written again as `payload.event.kind == "goal_usage_attribution"`
  (`record.usage_family: "provider"`), so reading both doubles the total. A subagent's
  calls are only in its own `subagent/<child>/session.jsonl`.
- Muse's own list cannot carry a name Koloft gives (checked 2026-10-22 on 1.4.9 in
  Docker, echo provider, a pty-driven TUI and `muse serve`): `session/list` gives
  `title` = the first prompt and `name` = the made-up name; `/rename Docs cleanup`
  changes only `name`, stored lowercased (`docs cleanup`), never `title`, and
  `nameOrigin` stays `null` after it, so the list cannot tell an owner's name from
  `cyan-pollux`. Muse has no `--name` flag. `session/rename` over `muse serve` (it
  needs a `commandId`) answers `sessionInUse` for a session a TUI holds and
  `sessionNotLoaded` for one nobody holds, with or without the `sessionRename`
  capability and `experimentalApi`. The binary also has a model-written title
  (`session.description.generated` with `short_title`, `TBH_AUTO_SESSION_TITLE`), not
  reached with the echo provider, so `title` is not always the first prompt.

## §3 Status: OSC 7501

- Muse speaks the terminal "program status" protocol, OSC 7501 (the same one Claude
  Code 2.1.295+ sends, CC ledger). At startup it writes the query `ESC ] 7501 ; ? ESC
  \` once per process. It sends states only after the terminal answers exactly `ESC ]
  7501 ; ? : states=idle,working,done,blocked,error : kinds=permission,question,auth
  ESC \`. A terminal that never answers (tmux, §6) gets no states.
- State frames look like `ESC ] 7501 ; state=<state>[:kind=<kind>]:app=muse ESC \`.
  Seen: startup `idle`; a turn `working` then `done` (also when started with a first
  prompt: `idle`, then `working` 40 ms later); `/clear`, `/new` and in-TUI `/resume`
  `clear` then `idle`; `/exit` a bare `clear`; a failed turn or a failing `!cmd`
  `error`.
- `blocked` kinds, all measured: `kind=auth` (muse's login screen, no login),
  `kind=permission` (a shell command asking to leave the sandbox, a new network
  target; fake model), `kind=question` (the model's `request_user_input`; fake model).
- A turn muse starts by itself — a background command finished or a subagent handed
  back its result after the turn — sends **no** 7501 frames; its hooks fire (§11).
- The first `idle` comes only after the trust question (§10) is answered, and it can
  arrive before the live-registry file (§4) is written.
- Muse has no status-line hook. Its footer (1.4.9, `/hud`) shows only built-in fields,
  each switched by a boolean `tui.hud.<field>` in `settings.json` or `-c` (lost after
  `/clear`): `model`, `effort`, `path`, `permissions` (on by default), `context`,
  `branch`, `tokens`, `cost`, `quota`. No key takes text of its own: `tui.hud.custom`,
  `tui.hud.command`, `tui.status_line`, `tui.footer` and the like refuse the run as
  unknown (fake model, Docker).

## §4 Which session a process holds: the live registry

- For every live session Muse writes
  `museHome/runtime/muse/sessions/<sessionId>.json`:
  `{"schema_version":1,"session_id":"…","process_generation_hint":"pid=<pid>",…}`.
  The pid is the TUI process (§1). That is where Linux 1.4.9 writes it (Docker). On
  macOS 1.4.10 the folder is `/tmp/tbh-<uid>-rt/muse/sessions` instead, the same file
  in the same shape, whatever `HOME`, `XDG_CONFIG_HOME` or `XDG_RUNTIME_DIR` say, beside
  the session sockets `ms-*.sock` (real Meta account, macOS, 2026-10: `lsof` on the
  running TUI). Without it Koloft binds a resumed tab only at its first prompt. macOS
  1.4.14 started over ssh wrote it under `museHome` as on Linux, and nothing under
  `/tmp/tbh-*` (§17). Whether the newer version or the ssh start made that difference
  was not separated: a 1.4.14 TUI started at the Mac's own desktop was not tried, so
  Koloft keeps looking in both folders.
- macOS 1.4.10 also writes `~/Library/Application Support/Muse/session-name-authority/
  session-names.db` in the real user's home, whatever `HOME` says.
- A fresh TUI writes its file at launch, before any prompt, so its session exists from
  the start (unlike AGY§8). 2026-10-26, muse 1.4.11 in Docker (`koloft-muse-probe-1411`),
  `--provider echo --trust-workspace`, a pty driver that answered the terminal's
  queries and typed nothing for 8 s: the registry file and
  `sessions/<date>/<id>/.session.lock` were both there.
- On `/clear`, `/new` and in-TUI `/resume` the old file goes and the new session's
  file appears with the same pid. `muse resume <id>` writes the resumed id. After
  `/exit` the last file stays behind, stale.
- **A second `muse resume` of a held session neither refuses nor opens.** 2026-11-02,
  `Muse Code 1.4.11 (1.4.11-R6667.1)` in Docker (`koloft-muse-probe-1411`,
  `--network none`), two TUIs on `--provider echo --trust-workspace`, each in a pty
  driver that answered the terminal's queries: the first TUI's registry file named its
  own pid (`pid=15`, `/proc/15/comm` `muse-bin-1.4.11`) and it held the session's
  `.session.lock` (a `FLOCK WRITE` in `/proc/locks`). `muse resume <id>` of that session
  from a second pty stayed on "Validating session data" for the 45 s watched, typed
  text changed nothing, it wrote no registry file and the first file kept `pid=15`; it
  was still stuck 10 s after the first TUI was killed with SIGKILL. With the first TUI
  killed before the resume, the same command went on through "Restoring conversation"
  to its prompt and rewrote the file with its own pid. So the registry file plus a live
  pid whose `/proc/<pid>/comm` names muse is the check on Linux too, read over ssh for a
  session on another machine: the file outlives its muse (above), and a container that
  restarts hands low pids such as 15 out again.
- **Muse must create `runtime/muse/sessions` itself**: when that folder already existed
  before muse started, muse wrote no registry file at all (Linux).
- Subagent logs sit under `<session>/subagent/<child>/session.jsonl`.

## §5 `muse serve`: listing, reading, pending asks

- `muse serve` speaks MSP (Muse Session Protocol): JSON-RPC 2.0 over stdio, one JSON
  object per line. Handshake: `initialize {clientInfo:{name,version}}` (`name` matches
  `[a-z0-9_]+`), then the notification `initialized`.
- `session/list {limit?, cursor?}` → `{sessions:[…], nextCursor}`, every folder's
  sessions, without a login. A session carries `sessionId`, `path`, `createdAt`,
  `updatedAt`, `workspaceRoot`, `title`, `name`, `firstUserPrompt`, `kind`, … A new
  session is missing from the list for 3–5 s. `path` is the session's own
  `session.jsonl` (§2): checked 2026-10-20 on Muse 1.4.9 in Docker, by `session/list`
  after a `muse exec --provider echo` run.
- A deleted session leaves `session/list` at once (2026-10-24, Muse 1.4.13 in Docker,
  three `muse exec --provider echo` runs, a Node client on `muse serve`): removing a
  session's folder, or only its `session.jsonl`, dropped it from the next listing; the
  other sessions stayed. Muse has no way of its own to delete or archive a session: no
  such subcommand in `muse --help`, and no such `session/*` method in `muse schema
  generate-ts`.
- What changes under `museHome/sessions/` while a new session starts (2026-10-27, Muse
  1.4.13 in Docker, `muse exec --provider echo` with a recursive `fs.watch` on that
  folder and a `muse serve` client listing every 250 ms): the session's folder and its
  `session.jsonl` appeared 0.3 s after the start; `session/list` held the session 2.1 s
  after the start. The same start also wrote, much of it going again within the run:
  `.session.lock`, `.session.jsonl.permission-init`, `cli-<uuid>.log`, `cron.db` and
  `cron.db-journal`, an `approval-review/` folder and
  `subagent/<child>/{.session.lock,session.jsonl}` inside the session's folder, plus
  `.msp-view-g6/<sessionId>/` (snapshot, `HEAD.json` and `.tmp` files rewritten many
  times) and `.msp-maintenance-owner.lock` at the top. Removing the session's folder
  reported only the folder and its `.session.lock` on Linux. So only the top-level
  `session.jsonl` appearing, or a session or date folder going, says the list changed.
- `muse serve --provider echo` (no login needed) can read a session another muse
  process holds: `session/read` returns its items (`userMessage`, `agentMessage`, … with
  `itemId`, `recordedAt`), and `approval/listPending {sessionId}` returns what it waits
  on: `approvals:[{approvalId, availableChoices:[{choiceId, decision, label}], rawArgs,
  …}]` and `userInputs:[{questions:[{id, header, question, options:[{label,
  description}], selection:{mode}}], …}]` (fake model). It cannot act on it:
  `approval/decide`, `userInput/answer`, `view/subscribe`, `session/resume` are refused
  (`-32021 sessionInUse` / `-32024 sessionNotLoaded`). Neither can the TUI attach to a
  host Koloft would run.
- **What a session waits on is in `approval/listPending` by the time its `blocked` frame
  arrives.** Measured 2026-11-06 on `Muse Code 1.4.11 (1.4.11-R6667.1)`
  (`koloft-muse-probe-1411`, `MUSE_NO_AUTO_UPDATE=1`), Docker `--network none`, the TUI in
  a python3 pty (160×50) answering the cursor, colour and 7501 queries, a fake
  `/responses` model at `--base-url` whose first `main` turn called `muse.bash` with
  `sandbox_permissions: "require_escalated"` (`blocked:kind=permission`) or
  `muse.request_user_input` (`blocked:kind=question`), `--approval-judge off
  --trust-workspace`, fresh `XDG_CONFIG_HOME` and `XDG_DATA_HOME` per run; from the frame
  on, a new `muse serve --provider echo` every 250 ms for 3 s, the session id read from
  `museHome/runtime/muse/sessions/<id>.json`. The first such client, started at the
  frame, had the approval (4 of 4) or the question (3 of 3) 120–170 ms after it; all 84
  clients of the 7 runs had it. A cold `muse serve` answered `initialize` in
  120–760 ms (6 runs). A client that looks the id up through `session/list` instead
  finds nothing for a while: there the new session showed up 2.75 s after the frame.

## §6 tmux swallows OSC 7501

- Inside tmux 3.3a (the multiplexer Koloft's remote tabs run in) the 7501 query never
  reaches the outer terminal, also with `allow-passthrough on`, so Muse on its own sends
  no states at all. §17 has what makes them flow.

## §7 No way to post into a live session from outside

- `muse session-message send` refuses a sender that is not itself a muse session. The
  `ms-*.sock` socket the registry names is not MSP. So the only way in is typing into
  the terminal.
- While a turn runs the TUI drops an Enter (macOS); a bracketed paste lands in the
  input box unsent until the next Enter.
- A line feed (`\n`) inside typed text is a new line in the input box, not an Enter:
  `first line\nsecond line\nthird line` written in one go, with or without
  bracketed-paste marks, then `\r` 300 ms later, is one `turn_submit` whose prompt keeps
  all three lines (muse 1.4.11, `1.4.11-R6667.1`, `--provider echo`, Docker, Linux, a
  python pty driver, October 2026; 2 of 2 tries plain, 1 of 1 pasted). Not probed on
  macOS.
- Esc during a turn stops it and puts the prompt back in the input box: with the fake
  model server holding `POST /responses` open, the screen read "◇ Thinking (4s · esc to
  interrupt)"; one Esc removed that line and left `please list the files` in the box,
  unsent; text typed next was added after it, and Enter sent both as a new turn
  (2026-10-31, muse 1.4.11, `koloft-muse-probe-1411` Docker image `--network none`,
  tmux 3.3a, the fake model server of the preamble). macOS: not probed.

## §8 Shell commands inside Muse (macOS)

- Measured with `!cmd`: the command runs under `/bin/sh -c`, not a login shell, with
  the TUI's environment intact (nothing removed; a PATH-prepended folder stays first)
  plus `MUSE_SESSION_ID` and proxy variables. The sandbox lets it write `/tmp`,
  `$TMPDIR` and the workspace, read but not write `~/Library/Application Support`,
  and not write `~/Library/Caches` or other home folders.
- Network, by `--sandbox-network` mode: `proxy-only` (the default) allows only what
  goes through muse's own per-launch proxy (`HTTP_PROXY`, `NODE_USE_ENV_PROXY=1`);
  direct TCP to 127.0.0.1 and every unix socket are refused (`EPERM`). `enabled` opens
  TCP and unix sockets but keeps the file rules. `restricted` closes everything.
- A git `include` from `GIT_CONFIG_COUNT`, a credential helper on that include, and a
  `gh` wrapper first on PATH all work in every mode but `restricted`, talking to
  Koloft through a folder in `/tmp`.
- Playwright's CDP client ignores the proxy, and writes under `~/Library/Caches`: with
  `--sandbox-network enabled` and `PWTEST_DAEMON_SESSION_DIR`, `PWTEST_SOCKETS_DIR`,
  `PWTEST_SERVER_REGISTRY` and `PLAYWRIGHT_BROWSERS_PATH` pointed at `/tmp`,
  `playwright-cli` reaches Koloft's relay. Under `--permission-profile :unrestricted`
  it works with no change.
- `kill -0` on a process outside the sandbox is refused (`EPERM`).
- A variable in muse's environment is visible to every shell command, `META_API_KEY`
  included.
- The model's own `bash` tool behaves like `!cmd` on every point above (fake model,
  macOS VM, under `--approval-mode never`, `never` + `--sandbox-network enabled` and
  `:unrestricted`): same `/bin/sh -c`, PATH order and variables (`XDG_CONFIG_HOME`
  too); a `koloft`-style command first on PATH talking to Koloft through a folder in
  `/tmp`, and a `gh` wrapper, work in all three; `playwright-cli` reaches the relay
  only with the network `enabled`. A token the model's command prints reaches the
  model as `[REDACTED]`.
- Processes the `bash` tool starts (1.4.9, macOS VM, fake model, `ps` and `lsof` run
  outside the sandbox): a command left running through `yield_time_ms` is a direct
  child of the muse pid (`node srv.mjs …`, no shell or sandbox process between), and
  carries `MUSE_SESSION_ID` and `MUSE_THREAD_ID` (the session's id) and
  `CLAUDE_CODE_TOOL_USE_ID`, never `CLAUDE_CODE_SESSION_ID`. The tool refuses a
  trailing `&`, `nohup` or `disown`. Listening on a port fails (`listen EPERM`) under
  the default sandbox network; with `--sandbox-network enabled` or `:unrestricted` it
  works and `lsof` shows the child listening. A clean `/exit` stops all of them, even
  one a script started with `nohup` that launchd had already adopted; only when muse
  itself is killed (`kill -9`) do they stay, under launchd, still listening.
- On 1.4.10 (real Meta account, macOS, 2026-10): a background `python3 -m http.server
  8765` is a direct child of the muse pid whose command line is the interpreter's own
  file, `…/Python3.framework/…/Python.app/Contents/MacOS/Python -m http.server 8765`,
  not the `python3` the model typed. Asked only to start a server "in the background",
  the real model once launched it so that it ran under launchd (parent pid 1) while
  muse kept running, with no background item for it; asked to keep it as the bash
  tool's own background job, it did.
- **A `bash` command has no terminal unless the model asks for one, and the macOS
  sandbox refuses sudo itself.** 2026-11-05, `Muse Code 1.4.14 (1.4.14-R7309.1)` on macOS
  27 (official installer, a throwaway HOME, the TUI under `expect`) and `Muse Code 1.4.11
  (1.4.11-R6667.1)` in Docker (`koloft-muse-probe-1411`, tmux, sudo 1.9.13p3 added, a
  user with a password), the fake model of the opening note calling `bash`, Koloft's sudo
  wrapper first on `PATH`. The tool's parameters are `command`, `workdir`, `shell`,
  `login`, `tty` ("Allocate a PTY for interactive commands."), `yield_time_ms`,
  `timeout_ms`, `max_output_tokens`, `description`, `sandbox_permissions`,
  `unix_socket_paths`. Without `tty` the command's shell led a session of its own with no
  terminal (`??`/`?`, stat `SNs`; muse held `ttys111 Us+` / `pts/0 Ssl+`), and the
  wrapper's `sudo -A` called `koloft secret sudo …` (`:unrestricted` on both, and the
  sandbox flags of §15 with `sandbox_permissions: "require_escalated"`). With `tty: true`
  the command got a pty of its own (`ttys113` / `pts/1`), `/dev/tty` opened, and the real
  sudo asked there; the TUI drew `Password: (ctrl+b to send to background)`. Under the
  sandbox flags on macOS, exec of `/usr/bin/sudo` failed `Operation not permitted` with
  and without `tty` (and `/bin/ps` too), so sudo runs only in a command the model marks
  `require_escalated`; in Docker the sandbox failed first (§17).

## §9 Hooks

- `TBH_MANAGED_HOOKS_PATH=<file>` in muse's environment loads `{"hooks":{…}}` from that
  file (`<Event>: [{hooks:[{type:"command", command}]}]`); the hooks fire for every
  session of that process, `/clear` and in-TUI `/resume` included. `-c hooks=…` and
  `-c managed_hooks_path=…` are lost after `/clear`. Hooks in the user's own
  `settings.json` run too, in no fixed order.
- A hook command's environment is only `HOME`, `PATH`, `PWD`, `TERM`,
  `MUSE_SESSION_ID`, `MUSE_THREAD_ID`; it runs outside the sandbox. Its stdin is one
  JSON object with `session_id`, `cwd`, `hook_event_name` and the event's fields. For
  what a subagent or one of muse's reminder helpers does (their `SubagentStart`, their
  tool calls, their `Stop`), `session_id` is that child's own id, the one
  `SubagentStart` names as `child_session_id` (fake model).
- Events Koloft reads: `SessionStart {source: "startup"|"clear"}` at the first prompt
  of a session (never at idle, never on `muse resume` or in-TUI `/resume`; `/new` says
  `startup`); `UserPromptSubmit {prompt, turn_id}`; `Stop {last_assistant_message,
  turn_id}`; `StopFailure {error, last_assistant_message}`; `PreToolUse` / `PostToolUse`
  `{tool_name, tool_input, tool_response}`; `PostToolUseFailure`;
  `SubagentStart` / `SubagentStop {subagent_id, child_session_id}`; `SessionEnd`.
- **`UserPromptSubmit`'s stdin is compact JSON with non-ASCII text left as UTF-8.**
  2026-10-28, muse 1.4.14 (`koloft-muse-probe-1411`, which updated itself), Docker,
  `muse exec --provider echo --trust-workspace "[Discord] 你好 \"a\" <b> é<TAB>x"`, the hook
  given through `TBH_MANAGED_HOOKS_PATH`, one run: the hook read
  `"prompt":"[Discord] 你好 \"a\" <b> é\tx"` — only the quote and the tab escaped, as
  Node's `JSON.stringify` does.
- Tool shapes (fake model): `write_file` and `edit_file` → `PostToolUse.tool_response
  {filePath, structuredPatch:[{lines:["+…","-…"], oldStart, oldLines, newStart,
  newLines}]}`; `bash` with `yield_time_ms` that outlives it → `tool_response` holds
  `"execution_state":"background_running"` and a `work_id`. A real subagent has a UUID
  `subagent_id`; muse's own reminder helpers say `skill-reminder`, `goal-reminder`,
  `verify-reminder`.
- More tool shapes in 1.4.9 (fake model, Docker, 2026-10): `read_file {path}`, its
  `tool_response` a plain string. `monitor {command, description, …}` →
  `tool_response` a JSON string `{work_id: "work.v2.monitor.…", timeout_ms,
  persistent, message}`. `cron_create {cron, prompt, recurring}` → `tool_response`
  the plain string `Scheduled <8 hex id> (<when>)`; `cron_delete {id}`. When a
  scheduled job fires, the session log gets a `runtime.session` record whose `event`
  is `{kind: "inbox_item_queued", source: {source: "scheduled", job_id}}`; a finished
  background command gets one with `source: "background_task_terminal"`
  and `registered_work_id`.
- 1.4.9 answers a bare greeting (`hello`, `hi`, `Hello`, `hello!`, `HELLO`) by itself
  when it is the first prompt of a session, with a fixed line such as "Hello! How can I
  help you today?" and no model request. That turn fires `SessionStart` and
  `UserPromptSubmit` but no `Stop`; the 7501 frames go `working` → `done` as usual
  (fake model, Docker). Every turn, this one too, writes its replies to the session
  log as `runtime.session` records `{kind: "run", run_id: <the turn_id of
  UserPromptSubmit>, event: {kind: "assistant_message_committed", text}}` and ends
  with one whose `event` is `{kind: "terminal", terminal: "completed"}`.
- A manual `/compact` (1.4.9, fake model, Docker) sends no 7501 frame and fires no
  `PreCompact`; when it is done, `PostCompact {trigger: "manual", turn_id}` and then
  `SessionStart {source: "compact"}` fire. The session log marks its start with a
  `runtime.command.accepted` record whose `command_kind` is
  `context.compact.manual`, and its end with a `context.compact.manual.outcome`
  record (`terminal_outcome: "compacted"`, or `"failed"` with a reason). Its summary
  request carries no `stream` field and expects a plain JSON reply.
- `!cmd` is a tool named `shell`. `request_user_input` fires no `PreToolUse`.
- A `PreToolUse` hook printing `{"hookSpecificOutput":{"hookEventName":"PreToolUse",
  "permissionDecision":"deny","permissionDecisionReason":"…"}}` or
  `{"decision":"block","reason":"…"}` blocks the tool before it runs, and the model
  reads `tool blocked by hook: <reason>`. Measured on `!cmd` and (fake model, Docker)
  on every model tool tried: `write_file`, `edit_file`, `bash`, `web_fetch`,
  `subagent_spawn`, `send_session_message`, `cron_create`, `add_memory`, `workflow`,
  `monitor`; no file changed, no subagent started.
- The model's tools in 1.4.7: `bash`, `bash_input`, `work_status`, `read_file`,
  `search`, `read_skill`, `write_file`, `edit_file`, `read_memory`, `add_memory`,
  `edit_memory`, `web_fetch`, `web_search`, `monitor`, `subagent_spawn` and the other
  `subagent_*`, plus `request_user_input`. `write_file {path, content}` and
  `edit_file {path, find, replace}` take a `path` relative to `cwd` or absolute. The
  reminder helpers answer through a tool `submit_reminder_decision`, which fires
  `PreToolUse` too (fake model).
- A `PreToolUse` hook cannot spare the user a question. 1.4.9 rejects a bare
  `"permissionDecision":"allow"` ("requires updatedInput"); with `updatedInput` it is
  taken, that object replaces the tool's input (`{}` empties it), and the question is
  still asked as before (macOS VM, fake model).
- `PermissionRequest` fires for a shell command's question, not for a network fetch's
  (1.4.9).
- A `PermissionRequest` hook can deny with `{"hookSpecificOutput":{"hookEventName":
  "PermissionRequest","decision":{"behavior":"deny","message":"…"}}}` but never
  approve (fake model).
- Hook stdout is capped at 16 384 bytes; above it the hook fails and nothing it
  printed is used.
- **A `PreToolUse` hook may hold a command for 10 minutes; at its timeout the command
  runs.** 1.4.9 in Docker (`koloft-muse-probe7`), fake model, `muse exec … --approval-mode
  never --disable-sandbox --trust-workspace`, a hook that slept then exited 0 printing
  nothing, the model asking `bash` for `echo hi > out.txt`, 2026-10-19: a 75 s sleep with
  no timeout and a 130 s sleep with `"timeout": 3600` let it run (turn 80 s, 135 s); a
  15-minute sleep with no timeout was killed at 600 s and the command then ran; a 20 s
  sleep with `"timeout": 5` was killed at 5 s (`status="timed_out"` in muse's trace) and
  the command ran, the model seeing a normal result. No model request was made while a
  hook held. The per-entry field is `timeout`, in seconds: writing `timeout_ms` instead
  made muse read the whole file as a schema needing `schema_version`
  (`Hooks: 0 runnable · 1 warning … missing_schema_version` on stderr), and every hook in
  it silently stopped running.
- **A `Stop` hook printing `{"decision":"block","reason":"<text>"}` keeps the turn going
  with `<text>`.** 2026-10-20, muse 1.4.9 and 1.4.11 in Docker, fake model server, hooks
  through `TBH_MANAGED_HOOKS_PATH`, the hook acting once; `muse exec … --json` and the TUI
  through a pty driver: one more model request in the same turn, `<text>` bare inside the
  first `developer` message; Stop fired again with the same `turn_id`,
  `stop_hook_active: true` (`false` the first time) and the new reply as
  `last_assistant_message`; no second `UserPromptSubmit`; the TUI sent `working` then one
  `done`, none in between; the session log records `context_block_updated {reason:
  "hook:stop", …}`; the next turn's request no longer holds `<text>`. A `Stop` hook printing
  `hookSpecificOutput.additionalContext` is marked failed (`unsupported
  \`additionalContext\` in hookSpecificOutput of Stop hook output`) and nothing happens.
- **A turn whose last message has no words ends with a `Stop` whose
  `last_assistant_message` is `null`.** 2026-11-07, muse 1.4.11 (`koloft-muse-probe-1411`,
  `--network none`, `MUSE_NO_AUTO_UPDATE=1`), Docker, fake model server, `muse exec
  --approval-mode never --disable-sandbox --trust-workspace`, hooks through
  `TBH_MANAGED_HOOKS_PATH`, one run each: the model ran `bash` once and then answered a
  message whose only `output_text` was `""`; `Stop` fired twice with the same `turn_id`,
  both times `"last_assistant_message": null`, the session log held no
  `assistant_message_committed` for that run, and it ended `terminal: "completed"`. A
  reply with no output item at all is not taken: muse retried the request (up to 10
  tries, 1 s doubling to 60 s apart). A model server answering 500 every time ended the
  turn after the 10th try with `StopFailure` carrying the turn's `turn_id`,
  `error: "server_error"` and `last_assistant_message: "API error 500: boom
  (server_error)"`, and a log record `terminal: "failed"` with that reason.

## §10 Workspace trust

- The TUI in a folder with no recorded decision first asks "Do you trust this
  workspace? … 1 Trust and continue 2 Quit". The answer is saved in
  `$XDG_CONFIG_HOME/muse/trust.json`:
  `{"schema_version":1,"projects":{"<path>":{"decision":"trusted"}}}`, keyed by the
  folder's real path.
- An entry another program wrote first is honoured (no question), and muse keeps the
  other entries when it adds one (it rewrites the file pretty-printed).
- "2 Quit" (↓ then Enter), or Esc, exits with code 0 within 0.3 s, erases the
  question from the screen and writes nothing to `trust.json` (Muse Code 1.4.13 on
  Linux in Docker, `--provider echo`, 2026-10-26; macOS not probed yet).
- `--trust-workspace` trusts the folder for that run only and saves nothing.
- `muse resume <id>` asks the same question when the folder has no decision, and
  writes no live-registry file (§4) until it is answered, so nothing tells which
  session the tab holds while the question is on screen (1.4.10, a real Meta account,
  macOS, 2026-10).

## §11 Approvals and questions in the terminal

- (fake model) `blocked:kind=permission` shows "1. Yes, proceed (y)  2. No … (esc)";
  a network target adds "2. Yes, don't ask again this session (p)". `y`, `1` or Enter
  approve, Esc rejects. `blocked:kind=question` shows the options; Enter picks the
  first, `<n>` then Enter or Down then Enter another, Esc cancels. A key sent within
  half a second of the `blocked` frame was applied only a minute later; two seconds
  after it, at once. (On 1.4.11 such a key is dropped instead: next bullet.)
- **A key sent before the approval box is drawn is dropped, and an answer taken leaves
  `blocked` at once.** Measured 2026-11-05 on `Muse Code 1.4.11 (1.4.11-R6667.1)`
  (`koloft-muse-probe-1411`, `MUSE_NO_AUTO_UPDATE=1`), Docker `--network none`, muse in a
  python3 pty (160×50) that answered the 7501 query with §3's reply and timestamped every
  frame, `--base-url` to a fake SSE `/responses` model, `--approval-judge off
  --trust-workspace`, a fresh `XDG_CONFIG_HOME` per run; 26 runs, times from the
  `blocked` frame. The model asked a `bash` call with `sandbox_permissions:
  "require_escalated"` (`blocked:kind=permission`) or a one-question `request_user_input`
  (`blocked:kind=question`). The approval box was drawn 400–405 ms after its frame (5 of
  5), the question box with it (1 of 1). `y` at 2.5 s: `state=working` 40–71 ms after the
  key (4 of 4), then `done`; the command ran. Esc at 2.5 s: `working` 177–190 ms after it
  (3 of 4) or `done` at 237 ms (1 of 4); the model got "tool denied: approval aborted".
  `2` then Enter 300 ms apart at 2.5 s: no frame on the digit, `working` 13–31 ms after
  the Enter (4 of 4), `selected_label: "Banana"`; the same at 0.2 s / 0.5 s was taken too
  (1 of 1). A `y` at 0.02 s (1), 0.2 s (3) or 0.3 s (1) was dropped: no frame in the
  30–90 s watched, nothing left in the input box, and a second `y` then gave `working`
  53–70 ms later. A `y` at 0.4 s, 0.5 s, 0.7 s, 1.0 s (2) and 2.0 s (2) gave `working`
  32–77 ms later. So the frame leaving `blocked` says an answer was taken, and one muse
  missed leaves it at `blocked`.
- **The same question asked again right after an answer comes after a `working` frame.**
  Measured 2026-11-08 on `Muse Code 1.4.11` (`koloft-muse-probe-1411`,
  `MUSE_NO_AUTO_UPDATE=1`), Docker `--network none`, a python3 pty (160×50) answering the
  cursor, colour and 7501 queries, `--approval-judge off --trust-workspace`, a fake
  `/responses` model that answered the first question's result with the very same
  one-question `request_user_input` at once; `2` then Enter 300 ms apart, 2.5 s after each
  frame; 2 runs: `blocked:kind=question`, `working` 21–25 ms after the Enter, the second
  `blocked:kind=question` 106–114 ms after that, `working`, `done`.
- **A question takes the owner's own words, and several questions are answered in turn,
  then on a review page.** Measured 2026-10-29 on the Muse the TUI drew as `Muse Code
  1.4.11` (the `koloft-muse-probe-1411` image, launcher 1.4.14, `MUSE_NO_AUTO_UPDATE=1`),
  in Docker with no network, in tmux 160×50, a fake model at `--base-url` with
  `META_API_KEY` and `MUSE_MODEL`: an SSE `POST /responses` server whose
  `response.created` carries a whole response object (`id`, `object`, `created_at`,
  `model`, `status`, `output`; a bare `{id}` fails as `error_kind: "decode"`), answering
  with a `request_user_input` function call. Under the options every question shows `N+1.
  None of the above  Optionally, add details in notes (tab)`; the tool's own description
  tells the model not to add one ("interactive clients add the appropriate escape
  answer"). Down to that row, Tab ("Note (optional):"), the words, Enter put up "Review
  answers before submit" with "Fruit: None of the above; note: …" and "Submit answers"
  picked; Enter there sent the tool result `{"status":"answered","answers":[{"id":"fruit",
  "free_text":"None of the above","note":"A ripe mango, please"}]}`. With two questions
  ("1 of 2", "←/→ to switch question"), `2` Enter moved to question 2, and its digit Enter
  or its note led to the same review page, whose Enter sent both answers (`selected_label`
  for a pick); a note on question 1 (Down, Down, Tab, words, Enter) moved to question 2 the
  same way. One question answered `2` Enter showed no review page and sent
  `{"id":"fruit","selected_label":"Banana"}` at once. Keys were sent by `tmux send-keys`,
  some in one burst (`Down Down Tab <words> Enter`), all taken. So the review page shows
  when the dialog has more than one question or any note, and Koloft presses one more
  Enter then. `muse schema generate-ts` (1.4.14) lists `userInput/answer` answers as
  `selectedLabel`, `selectedLabels` or `freeText`, plus `note`; §5's refusal of a second
  client's answer was not rechecked.
- **A question waits for the owner with every permission flag Koloft passes.** Measured
  2026-11-03 on `Muse Code 1.4.11 (1.4.11-R6667.1)` (`koloft-muse-probe-1411`,
  `MUSE_NO_AUTO_UPDATE=1`), Docker with no network, tmux 160×50, the fake model above
  answering with a one-question `request_user_input` call: with `--permission-profile
  :unrestricted` (footer `YOLO`) and with `--approval-judge off --sandbox-network enabled`,
  2 of 2 runs each drew the box ("◇ Request user input Fruit — running", the options,
  "None of the above", "Enter to select · ↑/↓ to move · Tab for an optional note · Esc to
  interrupt"), sent no model request for 22–70 s, and after `2` then Enter sent
  `{"status":"answered","answers":[{"id":"fruit","selected_label":"Banana"}]}`. The `❯`
  input row stayed drawn under the box. The tool's schema has an optional
  `auto_resolution_ms` (60000–240000) and says: "On a goal-carried run, omitting
  auto_resolution_ms still arms a fixed 300000 millisecond whole-prompt safety deadline;
  other runs keep no deadline when it is omitted." A call that sets it was not tried.
- **A question the person already pressed keys in.** Measured 2026-11-05 on `Muse Code
  1.4.11 (1.4.11-R6667.1)` (`koloft-muse-probe-1411`, `MUSE_NO_AUTO_UPDATE=1`), Docker
  `--network none`, a python3 pty 160×50 answering the cursor, colour and 7501 queries,
  the screen read through `pyte`, the fake `/responses` model above, `--approval-judge
  off --trust-workspace`, a fresh `XDG_CONFIG_HOME` per run; one question (Apple /
  Banana) or two (fruit, color); the person's keys 0.5 s apart, then Koloft's 300 ms
  apart; one run per line, two where marked.
  - A digit picks by its number wherever the highlight is: after Down ×1, ×2, ×3 (Down
    from the last row wraps to row 1), Up ×1 (wraps to row 3), Home or PageUp (neither
    moves it), or a bracketed paste (it lands nowhere), `2` Enter sent `selected_label:
    "Banana"`.
  - With the note open (Down ×2, Tab, ×2; with `hello` typed in it, ×2), `2` went into
    the note and Enter put up the review page with "note: 2" (`hello2`) and "Submit
    answers" picked; nothing was sent in 15 s and the frame stayed `blocked`.
  - Koloft's own-words keys count from where the highlight is: from row 2, `Apple` with
    the note; from row 3 or after Up, `Banana` with it (×2); with the note open and
    `hello` in it, `Banana` with `note: "helloPurple"` (×2).
  - With two questions, question 1 answered in the terminal (×2) or → pressed to
    question 2 (×2): Koloft's first `2` Enter answered question 2, and the rest submitted
    the review page with question 1 as the person left it (`Apple`, taken from its
    highlight when unanswered); the last Enter landed in the empty input box.
  - So once the person pressed a key in a question since it was asked, Koloft leaves it
    to them and presses nothing.
- Network approvals fire no hook at all; only the 7501 frame and
  `approval/listPending` (§5) show them.
- The input box is the one row between the last two full-width `────` rules, starting
  with `❯` (bare when empty, `❯ <draft>` with text in it); the status row, and any
  background-task rows, come below the second rule. An approval box takes its place:
  several rows between the rules and no `❯` row (1.4.9, fake model, Docker, 2026-10,
  read from the rendered screen). Slash-command menus were not looked at. In 1.4.10
  (real Meta account, macOS) the upper rule carries a title, `── Voice input (⌥ + v to
  start) ────…`, and an empty box can show a hint after `❯`, such as `Press Ctrl+O to
  expand collapsed tool output`.
- **An Esc and the Enter after it, read in one go, are Alt+Enter: the Enter adds a line
  and the command is not sent.** Measured 2026-10-25, muse 1.4.11
  (`Muse Code 1.4.11 (1.4.11-R6667.1)`), Docker, `--provider echo`, a python pty
  (120×40), the screen read through `pyte`: `/usage` (its menu shows "/usage  Show session
  usage" under the `❯` row), then `ESC` and CR in one write 0.3 s later, closed the menu
  and left the box as two rows, `❯ /usage` and an empty one, in 3 of 3 tries; a lone CR
  3 s later ran it (3 of 3, the "Session usage" panel), and so did one 2 s later (3 of
  3). `ESC` then CR in two writes
  0.3 s apart ran it at once (2 of 2). So a box can hold empty rows under the `❯` row.

## §12 Handing muse instructions

- A `SessionStart` hook (§9) that prints
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}`
  puts that text into the developer message of the model request (fake model: read
  from the request body). It fires again after `/clear`; after `muse resume` the text
  comes back from the session log without the hook firing.
- The same shape with `"hookEventName":"UserPromptSubmit"` lands as a developer message
  in that turn's request, and with `"PostToolUse"` in the next request after the tool
  (1.4.9, fake model, Docker, 2026-10: read from the request body).

## §13 Credentials

- `muse login` signs in with a device code in the browser; `muse auth set --provider
  meta --api-key-stdin` stores an API key. `META_API_KEY` in the environment beats
  both.
- On macOS a stored credential goes into the login Keychain (service
  `ai.meta.dev.credentials`, account `meta`), one item for the whole user whatever
  `XDG_CONFIG_HOME` says: a logout in one config folder logs every folder out. With
  `TBH_CREDENTIAL_BACKEND=file` the credential is a file, `auth.json` in that config
  folder (mode 0600), and two folders hold two credentials. A finished device-code
  login with `TBH_CREDENTIAL_BACKEND=file` writes that same `auth.json`
  (`providers.meta` with an access token, the user's name and email) and nothing to
  the Keychain (1.4.10, a real Meta account, macOS, 2026-10). macOS 1.4.14 over ssh read
  an `auth.json` holding an API key already in the folder with or without the variable
  (§17); one from a Meta-account login was not tried that way.
- A config folder whose `muse/trust.json`, `settings.json` and `AGENTS.md` are symlinks
  to the user's own files works: muse keeps each symlink and rewrites the file it
  points to (trust answers, `/theme`, `/permissions`), drops empty `.<name>.lock` files
  beside the symlinks, and `auth set` writes a real `auth.json` (0600) in the folder
  itself. A symlink to a file that does not exist is different per file: muse
  creates `trust.json` or `settings.json` through it, but a missing `AGENTS.md`
  stops the TUI before it draws anything ("runtime host failed to start: failed to
  read rules file at …/AGENTS.md: No such file or directory", 1.4.10, macOS).
  A `settings.json` without `"schema_version"` stops both the TUI and
  `muse serve` ("malformed settings file"). Sessions stay in museHome (§2) whatever
  `XDG_CONFIG_HOME` says (Docker and macOS); for the live registry see §4.
- `muse serve` (experimental capability) `account/read` → `state:
  "loggedOut"|"apiKey"|"envKey"|"accountLogin"`; `account/loginStart {type}` returns
  the device code and URL.
- `auth set --provider meta --api-key-stdin` does not check the key: a made-up one
  exited 0 with "credentials saved for provider meta" and was written to `auth.json`
  (0600) as `{schema_version, providers: {meta: {api_key}}}`. `account/read` then
  answered `{state: "apiKey", label: "stored key"}`, and with `META_API_KEY` set
  `{state: "envKey", label: "META_API_KEY"}`; `usage/read` answered `{}` either way
  (1.4.14, Linux arm64, Docker, `TBH_CREDENTIAL_BACKEND=file`, 2026-10-28). That a wrong
  stored key then ends the launch the way a rejected `META_API_KEY` does (below) is
  inferred, not checked.
- How much of a Meta account's quota is used showed only inside a live session: the
  TUI's `/usage` draws a box (screen only, §11), while a fresh `muse serve` answers
  `usage/read` with nothing in it and `muse exec --json` prints no usage record
  (1.4.10, a real Meta account, macOS, 2026-10). The box needs no model call: typed as
  the first thing in a fresh session (0 turns), it shows `Subscription · <plan>`,
  `Current  4% used · Resets at 4:11 AM`, `Weekly  1% used · Resets Oct 18 at 5:00
  PM` and `as of 12:31 AM`.
- That works in a TUI started with `--no-session-log --trust-workspace`: it writes no
  session folder, so `session/list` never shows it, and leaves no process once its pty
  is closed. In the first second or two after start the box has only the session lines;
  typed again a moment later it has the Subscription block (1.4.10, real Meta account,
  macOS, 2026-10). An API-key account (`account/read` state `apiKey`) shows no
  Subscription block (inferred from the box's layout, not checked: no real API key on hand).
- `muse schema generate-ts --experimental` lists `usage/read` and `usage/changed` with
  `SubscriptionUsage {tier, window {usedPercent, resetsAtMs, windowDurationMins},
  weekly {usedPercent, resetsAtMs}, observedAtMs}`, the window described as "the
  provider's 5-hour-class block". A fresh `muse serve` still answers `usage/read` with
  `{}` after `account/read`, `model/list` and `session/start` (which writes an empty
  session `session/list` then shows). The box prints no window length; Koloft takes the
  current window as 5 hours from that description, and the reset times seen (4:11 AM
  from a window that began before 11:15 PM) fit it.
- A rejected `META_API_KEY` ends the launch before the TUI: "failed to fetch model
  catalog: authentication failed: your API key from META_API_KEY was rejected".

## §14 Updates

- The launcher updates muse itself: unless `MUSE_NO_AUTO_UPDATE=1`, at most once an
  hour it fetches a newer build in the background; the next start prints "Muse Code
  updated X -> Y". `MUSE_SYNC_UPDATE=1` checks and downloads before starting (about
  15 s for 311 MB, no login); offline it exits 1 at once, and its curl has no connect
  timeout. There is no `muse update` command.

## §15 Approval and sandbox flags

- `--permission-profile :read-only|:ask-me|:auto-review|:unrestricted`; with no flag a
  new session runs `:auto-review`, where a second model call decides whether to
  approve (fake model: `role=judge` requests).
- `--permission-profile` refuses to combine with `--sandbox-network`, `--approval-mode`,
  `--approval-judge`, `--disable-approval` and `--yolo` (exit 2).
- `--approval-judge off` with `--sandbox-network enabled` (no profile): no judge, a
  shell command leaving the sandbox still asks the user, a network fetch runs without
  asking (fake model). Without the network flag a network fetch asks the user too, and
  on macOS 1.4.7 so did file writes and other commands the judge would have reviewed.
  On macOS 1.4.9 `write_file` and `edit_file` inside the folder no longer ask; a
  network fetch (without the network flag), a command leaving the sandbox and a write
  outside it still do, and so did a shell command of several stages (`a; b`) on 1.4.9.
  1.4.14 no longer asks for that: `echo a; echo b` ran with no question (macOS and
  Linux, TUI, 2026-11-03).
- **git inside the sandbox, with these two flags** (2026-11-03, `Muse Code 1.4.14
  (1.4.14-R7309.1)`, official installer, a throwaway macOS 27 tart VM and a throwaway
  Ubuntu 24.04 tart VM with unprivileged user namespaces allowed; the TUI driven by
  `expect`, which answered the terminal queries and the 7501 query and counted
  `blocked:kind=permission` frames; the fake model of the opening note calling `bash`
  with one command per call; Koloft's bundled git 2.53.0 on macOS, Ubuntu's 2.43.0 on
  Linux): in a repository, and in a worktree at
  `<repo>/.claude/worktrees/<name>` whose git folder lies outside the workspace,
  `git commit -am …` and then `git push` over http to a server that wants a token ran
  with no question. Each VM copied the git setup one kind of Koloft tab has. On macOS,
  a local tab's: an `include.path` given in `GIT_CONFIG_COUNT` names the account's
  config, whose credential helper asks an answerer through a folder in `/tmp`. On
  Linux, a remote tab's: the `include.path` comes from `GIT_CONFIG_PARAMETERS` and the
  helper reads a token file under `~/.koloft`. The commit carried the account's
  `user.name` and `user.email`, the server saw the token, and the remote-tracking
  branch moved. `touch .git/x` worked while `touch ../x` was refused ("Operation not
  permitted" on macOS, "Read-only file system" on Linux); the binary names a
  `git_sandbox_relaxation` feature and `active_git_storage_roots`. `muse exec` under
  the same flags gave the same results (macOS). Not probed yet: a push over ssh, a
  helper that writes in the home folder (Git Credential Manager refreshing a token).
- A `bash` call with `sandbox_permissions: "require_escalated"` (the tool's way to ask
  for one run outside the sandbox) shows "Would you like to run the following command?"
  with `blocked:kind=permission`, and `y` runs it (same runs).
- No 1.4.9 launch flag makes Muse ask before `write_file` or `edit_file` (macOS VM,
  fake model, one tool per turn): not `--approval-mode untrusted` (with the judge on or
  off), `on-request --approval-judge off`, `--permission-profile :ask-me` or the
  default. `untrusted` asks before every shell command, a plain `echo` too, and
  `PermissionRequest` carries its `tool_input.command`; `on-request` and `:ask-me` ask
  only for a command leaving the sandbox and a network fetch; the default lets the
  judge pass the fetch.
- `--approval-mode never` (alone, with `--sandbox-network enabled` or with
  `--approval-judge off`): nothing ever asks the user and no judge runs; every tool
  runs inside the sandbox, `web_fetch` included, and a shell command asking to leave
  the sandbox is refused with "unsandboxed execution requires human approval, but
  approval prompts are disabled" (fake model, Docker and macOS).
- `--permission-profile :unrestricted`: no sandbox, no prompts; a command asking to
  leave the sandbox is refused rather than asked.

## §16 Skills

- 1.4.9 loads a user skill from `$XDG_CONFIG_HOME/muse/skills/<id>/SKILL.md` and a
  project skill from `<workspace>/.agents/skills/<id>/SKILL.md` (only in a trusted
  folder). No `skills/.muse` folder is needed; `muse skills install` makes one. No
  flag, `-c` key or environment variable points muse at another skills folder
  (fake model, Docker).
- A skill folder that is a symlink to a folder elsewhere loads like a real one; a real
  folder whose `SKILL.md` alone is a symlink is not loaded and gives no diagnostic
  (fake model, Docker).
- The model is handed only each skill's frontmatter `description`, in the first
  developer message of every session, `/clear` included; it reads the body with
  `read_skill`. A `SKILL.md` over 262 144 bytes is not loaded.
- A skill is switched off per user with `skills.activation.user` in `settings.json`,
  keyed by its display path (`"$CONFIG_DIR/skills/<id>/SKILL.md": "off"`); the same
  map given with `-c` holds only until `/clear`, and keyed by bare id it does nothing.

## §17 Muse on another machine, inside tmux

How established: muse 1.4.9 (`Muse Code 1.4.9 (1.4.9-R6297.1)`), official installer, in a
Linux Docker container reached over a real `ssh`, inside tmux 3.3a, with the fake model
server of the opening note and with `--provider echo`; October 2026.

- Hooks inside tmux fire exactly as outside it (§9). Their environment has no `TMUX`,
  no `TMUX_PANE` and nothing Koloft put in muse's environment, so a hook cannot learn
  which tab or tmux session it belongs to except from its own command line.
- A process between tmux and muse that owns muse's terminal (a python3 `pty` wrapper)
  and answers the 7501 query itself with the reply of §3 makes every state flow.
  The wrapper must not pass the query on. Re-sent to tmux as a DCS passthrough
  (`ESC P tmux;` + the frame with every ESC doubled + `ESC \`), the frames reach the
  terminal outside tmux when tmux has `set -g allow-passthrough on`, and on tmux before
  3.3 with no setting at all (PLATFORM§35). Measured on tmux 3.2a and 2.6 (Ubuntu 22.04
  and 18.04 in Docker, python 3.10 and 3.6 running the wrapper, muse 1.4.11 on
  `--provider echo`, 2026-11-09): the states reached the outer terminal, the wrapper's
  mirror file got the same ones, and the session was renamed for the bound session id.
- Attaching to the tmux session again replays no 7501 frame.
- **Inside tmux muse frames nothing.** muse asks no DECRQM 2026 and, in a tmux 3.3a pane
  (`TERM_PROGRAM=tmux`), wrote no `?2026h` while it streamed a 160-line answer and
  scrolled (4 of 4 runs; every one of its 171–174 redraws after the answer reached the
  outer terminal unframed), so under that name there is nothing for a relay to carry
  past tmux. Given `TERM_PROGRAM=WezTerm` in the pane it wrote 314 frames, and tmux
  3.3a passed none of them on (PLATFORM§35); a relay built like `STATUS_RELAY_PY`
  would not carry them either, since it takes over the frames only after the program's
  own DECRQM 2026, which muse never sends. It wrote 160 OSC 8 links in all 5 runs; none
  reached the outer terminal. 2026-11-08, muse 1.4.11 (`1.4.11-R6667.1`, `koloft-muse-probe-1411`, Debian
  12, Koloft's tmux.conf, no network), a fake `/responses` model streaming the answer
  in 4-line pieces 60 ms apart, then 60 wheel notches and 8 PageUp/PageDown; a python
  pty answering like xterm.js as the outer terminal, muse's own bytes logged by a pty
  between it and tmux.
- `TBH_TMUX_RUN_STATUS_PATH` writes nothing Koloft can use.
- `ssh <machine> muse serve --provider echo` speaks §5 over the ssh pipe: `initialize`
  answers in about 0.3 s, `session/list`, `session/read` and `approval/listPending` are
  fast and need no login. In 1.4.9 `session/read` returns items only with
  `excludeItems: false`. A session a TUI holds shows in the list after a few seconds,
  `status: notLoaded`.
- An `auth.json` copied from one config folder into another (§13) signs muse in there;
  on Linux no keyring and no `TBH_CREDENTIAL_BACKEND` is needed. `META_API_KEY` shows
  in `account/read` as `envKey`.
- The installer (`curl -fsSL https://dev.meta.ai/install.sh | MUSE_NO_MODIFY_PATH=1 bash`)
  takes about 18 s and 331 MB, puts a static binary under `~/.local/bin`, and has builds
  for Linux and macOS on x86_64 and aarch64.
- A recorded `trust.json` answer or `--trust-workspace` keeps the trust question away
  in tmux too, and across `/clear`.
- `muse session-message send` exits 1 with `external_agent_ingress_closed` in every
  variant tried; the only way to put words into a running TUI is typing.
- Measured end to end through Koloft (Docker lab, real `ssh`, tmux 3.3a with
  `allow-passthrough on`, muse 1.4.9 on `--provider echo`): the wrapper's numbered
  passthrough frames reach Koloft and light the row; `tmux rename-session -t $TMUX_PANE`
  run by the wrapper renames the session the tab is in; a hook command written as
  `bash "$HOME/…"` gets `$HOME` expanded, so muse runs hook commands through a shell;
  `/clear` writes the new session's registry file with the same pid, so the wrapper
  follows it. Typed text followed by Enter in one write lands in the input box unsent;
  an Enter sent a second later submits it.
- The gap Koloft's `typeKeys` leaves between a text and its Enter is enough: muse 1.4.10
  (`1.4.10-R6427.1`) on `--provider echo` inside tmux 3.3a (Docker, Linux, a pty attached
  with `tmux attach`, October 2026), text then Enter 0 ms apart stays in the box (2 of 2
  tries), 300 ms apart it submits (2 of 2), 1000 ms apart it submits (2 of 2).
- On Linux, muse 1.4.10 (`Muse Code 1.4.10 (1.4.10-R6427.1)`, official installer, Docker,
  `--provider echo`) still writes the live registry of §4 under
  `museHome/runtime/muse/sessions`, with `process_generation_hint: "pid=<pid>"`; nothing
  appears under `/tmp/tbh-*`. Only macOS 1.4.10 moved it (§4).
- The `auth.json` of a finished device-code login on macOS (§13: `providers.meta` with
  `access_token`, `obtained_via`, `mechanism`), copied into a config folder on a Linux
  machine, signs muse 1.4.9 in there with the real Meta model: it answered a prompt,
  with `SubagentStart` and `SubagentStop` hooks around its work (Docker, real `ssh`,
  tmux 3.3a, through Koloft, October 2026).
- **On Ubuntu 24.04 as it ships, Muse's sandbox cannot start.** There
  `kernel.apparmor_restrict_unprivileged_userns` is 1, and muse 1.4.14 (`1.4.14-R7309.1`,
  a throwaway Ubuntu 24.04.5 tart VM, kernel 7.0, the runs of §15) fails every shell
  command it sandboxes with `bwrap: setting up uid map: Permission denied`; its status
  line says "The Linux sandbox uses Bubblewrap and needs access to create user
  namespaces." Installing Ubuntu's `bubblewrap` package, which comes with an AppArmor
  profile, changes nothing: muse runs its own copy. So under §15's flags `git commit`
  and `git push` fail, and a command marked `require_escalated` asks once and then runs
  outside the sandbox, the push still under Koloft's account. That the real model
  retries a failed command that way is inferred, not checked. With the setting at 0 the
  sandbox works and git behaves as in §15. The Docker lab fails the same way
  (`No permissions to create a new namespace`; `setting up uid map` with seccomp and
  AppArmor unconfined, or `--privileged`).
- **How Koloft tells whether that sandbox can start** (2026-11-04, an Ubuntu 24.04.4
  host with the setting at 1, the Docker containers on it, muse 1.4.14 `1.4.14-R7309.1`
  in one of them): `unshare -Ur true` fails in the same places muse's sandbox failed
  above — on stock Ubuntu 24.04 ("write failed /proc/self/uid_map: Operation not
  permitted"), in a default container and in a `--privileged` one — and passes on the
  host once the setting is 0. Two checks that look closer do not work. `muse serve`'s `initialize` answers
  `sandboxAvailability: "available"` in a container where `unshare -Ur true` fails.
  The machine has no `bwrap` of its own: muse's strings name an embedded Bubblewrap it
  runs from its own binary, behind private markers (`TBH_INTERNAL_MODE=__tbh_internal_bwrap`
  alone exits 125, "invalid private Linux invocation markers"), so neither a system
  `bwrap` nor muse's copy can be run as a check. Not probed yet: an AppArmor profile
  for muse's binary, and whether it makes muse's sandbox start.
- **A copy reaches the Mac only as OSC 52.** The 1.4.11 Linux binary holds `pbcopy`,
  `wl-copy`, `tmux load-buffer -w` and an OSC 52 sequence wrapped for tmux passthrough
  (`]52;c;` next to `Ptmux;`); a machine with no display has none of the system tools,
  so only the escape code and tmux's own `load-buffer -w` can reach the terminal
  (read from `strings` of `muse-bin-1.4.11-R6667.1` in the `koloft-muse-probe-1411`
  image, 2026-11-05). Run: that muse on the echo model, in a Koloft tab on the Docker lab
  machine through real ssh and Koloft's tmux, answered a prompt, and `/copy` then put
  `echo: <prompt>` on the Mac clipboard (main's `clipboard.writeText` stubbed and read
  back; 2026-11-05).
- **A Mac as the other machine runs a remote Muse tab.** muse 1.4.14 (`1.4.14-R7309.1`,
  official installer) in a macOS 26.6 VM reached over ssh, Homebrew's tmux 3.8 (`tmux
  -V`), Koloft's own tab script, `ensure.sh`, tmux.conf, wrapper and hook script,
  `--provider echo --trust-workspace` with muse's own approval and sandbox defaults, not
  Koloft's flags (2026-11-09). `ensure.sh muse` exited 0. Run once by the Command Line Tools' python
  3.9.6 and once by Homebrew's 3.15 (the tab's `PATH` puts `/opt/homebrew/bin` first),
  the wrapper sent idle, working and done out through tmux and into its mirror, bound
  the session from the registry under `museHome` (§4), and tmux renamed the session;
  the hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `SubagentStart`/`Stop`) reached
  the mirror through `bash "$HOME/…"`, and attaching again showed the screen. An
  `auth.json` holding an API key, carried as `$T.auth.json` and moved into the
  account's config folder by the tab script, signed `muse serve` in: `account/read`
  answered `apiKey` / `stored key` in 0.6 s with `TBH_CREDENTIAL_BACKEND=file`, with no
  Keychain prompt. Without the variable it answered the same, and no Keychain item
  `ai.meta.dev.credentials` appeared. A real Meta account was not tried there.
- **Where Muse's sandbox works, a command in it cannot write `~/.koloft`.** muse 1.4.14
  under `--approval-judge off --sandbox-network enabled`, the TUI in tmux over ssh
  (2026-11-09). On an Ubuntu 24.04 VM with `kernel.apparmor_restrict_unprivileged_userns`
  at 0, `!touch ~/.koloft/hook-sessions/x` got `Read-only file system`, while the
  workspace and `/tmp` took writes (the real `/tmp`, seen from outside). On the macOS VM
  the same `!touch` got `Operation not permitted`, with `/tmp` and `$TMPDIR` writable.
  The model's own `bash` tool (the fake model, Linux) is asked first only when the path is
  in the command's own text: `touch $HOME/.koloft/hook-sessions/x; echo …` showed "Would
  you like to run the following command?" (`blocked:kind=permission`, "Stage 1/2", the
  `touch` argv), while a script on `PATH` that writes there (Koloft's `koloft`) ran with
  no question and its write failed. A `bash` call marked `require_escalated` asked once
  and, after `y`, ran outside the sandbox and the write went through.
- **`--workspace <PATH>` adds no writable folder**: it takes one folder only, and given
  twice muse refuses ("the argument '--workspace <WORKSPACE>' cannot be used multiple
  times"; 1.4.14, Linux, 2026-11-09).

## §18 MCP servers and a project's instruction files

2026-10-23, `Muse Code 1.4.11 (1.4.11-R6667.1)`, Docker, `muse exec` against a fake model
server (`--base-url`, `META_API_KEY=FAKE`, `MUSE_MODEL=fake-model`); each MCP server a
tiny stdio server that logged its start; marker words in instruction files, looked for
in the model request.

- **No `mcp list`:** `muse mcp` has only `login` and `logout`.
- **Everywhere:** `mcpServers` in `<config>/muse/settings.json` (`{"schema_version":1,
  "mcpServers":{"<name>":{"type":"stdio","command","args"}}}`) started in every folder.
- **One project:** `mcpServers` in `<workspace>/.mcp.json`, and only in a trusted
  workspace (`--trust-workspace` or `trust.json`): folder A trusted started both, A
  untrusted and B trusted started only the settings one. `<A>/.muse/settings.json` and
  `<A>/.agents/settings.json` were not read.
- **Which folders' `.mcp.json`:** the workspace's and every folder above it up to the
  nearest one holding `.git` (a folder, or the file of a linked worktree), that one
  included; outside any repository only the workspace's own. A linked worktree did not
  reach its main checkout, a repository inside another did not reach the outer one, and
  `--trust-workspace` for the cwd alone was enough for the files above it to load.
  Measured 2026-10-28, `Muse Code 1.4.11 (1.4.11-R6667.1)`, Docker, `muse exec --provider
  echo --trust-workspace`, MCP servers that logged their start.
- **Instruction file:** `AGENTS.md` in a trusted workspace (as `<rules-file
  scope="project" path="AGENTS.md">`; untrusted, muse says it skips it). `CLAUDE.md` is read
  only where there is no `AGENTS.md` ("CLAUDE.md is ignored this session because
  AGENTS.md takes precedence"). `MUSE.md` is never read. `<config>/muse/AGENTS.md` is
  read everywhere, as `scope="user"`.

Koloft dependents: `koloft todo`'s list of MCP servers (`src/main/mcpServers.ts`) and the
butler's to-do method, which names the files each agent reads.

## §19 What a slash command prints

- **It is drawn on the screen only; no store Koloft can read holds it.** First seen on
  1.4.9 (fake model): the session log held none of `/usage` or `/status`. Rechecked
  2026-10-26 on `Muse Code 1.4.13 (1.4.13-R6996.1)`, Docker (`koloft-muse-probe` image,
  Linux), `muse --provider echo --trust-workspace` in a python pty (120×40, the screen
  read through `pyte`): one prompt, then `/status`, `/usage` and `/help`, each typed, then
  Esc and Enter as separate writes. `/status` drew a box (MODEL, WORKSPACE, ACCESS, USAGE,
  CONTEXT, SESSION, ACTIVITY), `/usage` a "Session usage" box, `/help` a panel under the
  input box. None of their words were in the session's `session.jsonl`, in the MSP view
  store `sessions/.msp-view-g6/<id>/` (its journal and snapshots), or in what
  `muse serve --provider echo` returned for `session/read` and `view/page {limit: 1000}`;
  the prompt and its echoed reply were in every one of them.
- **`/diff` is not a Muse command.** Typed the same way, it went to the model as a prompt:
  a `userMessage` "/diff" and the reply "echo: /diff".

## §20 `/fork`

How established: 2026-11-01, `Muse Code 1.4.14 (1.4.14-R7309.1)` (the
`koloft-muse-probe-1411` image after `muse --version` with `MUSE_SYNC_UPDATE=1`), Linux
Docker with `--network none` and `MUSE_NO_AUTO_UPDATE=1`, `muse --provider echo
--trust-workspace` in a tmux 3.3a pane (160×50), every hook event of §9 logged through
`TBH_MANAGED_HOOKS_PATH`, the registry folder (§4) and `muse serve` (§5) read after each
step: `/fork` alone in four runs, `/fork <text>` in three, the same each time; the
30-second listing below in one. OSC 7501 frames were not seen (tmux, §6). macOS: not
probed.

The command menu shows `/fork [prompt]` — "Branch this session from the latest message".
It has two forms that behave differently.

- **`/fork` alone makes a copy and stays where it was.** Below the last reply it prints
  `Fork created: <new id>`, `Source session stays active.`, `Continue the fork:` and
  `muse resume <new id>`. No hook fires, the registry file keeps the old id, and the next
  prompt goes to the old session (its `UserPromptSubmit` and `Stop` carry the old id).
  The copy's folder holds only `.session.lock` and `session.jsonl`.
- **`/fork <text>` moves the terminal onto a new copy and sends `<text>` there.** The
  screen redraws with `resumed session <new id>` and the copied turns, then the prompt
  and its reply. Hooks, in order: `SessionEnd` (whose `session_id` is the new id),
  `SessionStart` with `source: "fork"`, then `UserPromptSubmit` and `Stop`, all with the
  new id. The old id's registry file goes and the new id's file appears with the same
  pid, as on `/clear` (§4). Every later prompt goes to the new session.
- **The copy's `session.jsonl` starts with a `session.fork.created` record** (about
  700 bytes, compact JSON with `"payload_type":"session.fork.created"` in its first
  300 bytes), payload `{fork_session_id, source_session_id, source_cut_cursor,
  created_by_command_id, …}`, then `session.fork.model_prefix` and one
  `session.fork.turn` per copied turn. The copied turns' own records follow only as
  `{"retained_marker":"omitted_live_only", …, "omitted_record":{…}}` lines, with no
  top-level `payload_type`; the moved-onto copy then has
  `runtime.session_start.intake_v3` with `activation_source: "fork"`. A session started
  fresh or by `/clear` starts with another record. On `/fork <text>` this file was
  written about 0.25 s before the registry swap (its `createdAt` against the registry
  file's mtime, one run). The source's own log gets
  `command.invoked {command: "/fork"}` and `runtime.command_intake.branch.received
  {command: {kind: "session_fork", requested_fork_session_id}}`.
- **`session/list`**: the copy is `kind: "root"` with `workspaceRoot: null` and
  `forkedFrom: {sessionId: <source id>, commandId, cutCursor, cutExplicit: false}`;
  `title` and `firstUserPrompt` are the source's first prompt; `path` is its own
  `session.jsonl`. A `/fork` copy has no `name` and is listed within seconds. A
  `/fork <text>` copy is **not listed at all while the TUI holds it** (15 listings over
  30 s), and is listed after `/exit` with a made-up `name` and `turnCount` counting the
  copied turns too. The source stays listed either way.

## §21 An MCP server's environment, and the asks before its tools

How established: 2026-11-04, `Muse Code 1.4.14 (1.4.14-R7309.1)`, the official installer
into a scratch HOME on macOS 27, scratch `XDG_CONFIG_HOME`,
`TBH_CREDENTIAL_BACKEND=file`; the TUI under a Python pty that answered the terminal and
7501 queries, the fake model server of the opening note calling one MCP tool per prompt,
and a tiny stdio MCP server with three tools: `browser_navigate` (`destructiveHint:
true`), `browser_snapshot` (`readOnlyHint: true`), `ping` (no hints), named `playwright`
and `probe` in `settings.json` `mcpServers`. Muse was started with Koloft's env.

- **A stdio MCP server gets almost nothing of muse's environment**: only `HOME`, `LANG`,
  `MUSE_SESSION_ID`, `PATH`, `TERM`, `TMPDIR`, `__CF_USER_TEXT_ENCODING`, in Koloft's
  default flags and in `:unrestricted`, after `/new` and after a restart — plus its
  entry's `env` map.
- **`"env": {"X": "${X}"}` in a `settings.json` entry is filled from muse's own
  environment** (the server saw the `ws://` value), although muse's bundled guide says
  it does not expand `${VAR}`. An entry whose `env` names a `${VAR}` that is not set does
  not start at all, with nothing on stderr (`muse exec`).
- **`-c` cannot reach a `settings.json` entry**: `-c 'mcpServers.<name>.env.X="${X}"'` →
  `refusing run: the server name is reserved` (exit 1); a literal value → `secret leaves
  need exactly one whole-value ${VAR} naming a set variable` (exit 2);
  `-c mcpServers.<new>={…}` → `unknown key: no such setting` (exit 2).
- **Asks**: in Koloft's default flags (§15) a tool not marked `readOnlyHint` asks on every
  call ("Would you like to allow this tool action? 1. Yes, proceed (y) / 2. Yes, don't ask
  again this session (p) / 3. Always allow this MCP tool / 4. No … (esc)", 7501
  `blocked:kind=permission`), again after `/new` and a restart; `browser_snapshot` did
  not ask. `p` held for that session only. `3` wrote
  `$XDG_CONFIG_HOME/muse/approval-policy.json` `{"schema_version":2,"rules":[{"effect":
  "allow","durability":"local_persistent","rule":{"kind":"tool_action","tool_name":
  "mcp__playwright__browser_navigate"}}]}`, and that tool stopped asking after `/new` and
  a restart. The same file written before launch works the same; `mcp__playwright__*`
  does not match. The rule kinds in the binary are `exact_raw`, `argv_prefix`,
  `tool_action`, `filesystem`, `network`, `unix_socket` — none covers a whole server.
  `:unrestricted` asked nothing.
- **Rechecked and extended 2026-11-05**, the same build and rig, `settings.json` a regular
  file (not a symlink):
  - Two `${VAR}` lines (`PLAYWRIGHT_MCP_CDP_ENDPOINT`, `…_ALLOW_UNRESTRICTED_FILE_ACCESS`)
    both reached the server, at start and after `/new`; a second server without them saw
    neither. A variable set to the empty string reaches the server as `''` and the server
    starts (TUI; `muse exec` not probed).
  - 25 `tool_action` allow rules written before launch for server `playwright`:
    `playwright/browser_navigate` never asked (3 calls, also after `/new`), while
    `probe/browser_navigate` and `probe/ping` asked each time.
  - **An unknown field in a rule stops muse from starting**: `"source":"koloft"` beside
    `effect` → "runtime host failed to start: policy persistence failed: unknown field
    'source', expected one of 'effect', 'durability', 'rule', 'reason'". `"reason":
    "koloft"` is taken, the rule still works, and it is kept when muse rewrites the file.
    From the binary: `durability` is `session` or `local_persistent`, `effect` is `allow`,
    `deny` or `prompt`.
  - When muse saves "Always allow" itself, it keeps the rules already there in order, adds
    `"reason": null` to each rule without one, appends its own last, and drops an
    `approval-policy.lock` beside the file.
  - A server named `my-pw` becomes `mcp__my_pw__<tool>` in the ask and in the rule muse
    writes: a dash turns into an underscore. Other characters: not probed.
  - Muse did not rewrite `settings.json` at a TUI start and `/exit` (byte for byte).
- **Which `@playwright/mcp` tools are not read-only** (0.0.84, `tools/list` over stdio
  with `--caps=vision,pdf,devtools`, 2026-11-05): of 45 tools, 25 carry `readOnlyHint:
  false` — the 18 of CODEX§26 plus `browser_resume`, `browser_mouse_move_xy`,
  `browser_mouse_click_xy`, `browser_mouse_drag_xy`, `browser_mouse_down`,
  `browser_mouse_up` and `browser_mouse_wheel`.

Koloft dependents: the account folder's `settings.json` and `approval-policy.json`
(`src/main/museAccounts.ts`); the Playwright variables, empty without the Workbench
browser, in every muse Koloft starts on that folder (`museAccountEnv`) and in the shim's
`muse exec` (`src/main/shim.ts`).
