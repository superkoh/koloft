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
- Muse has no status-line hook and no setting for its own footer.

## §4 Which session a process holds: the live registry

- For every live session Muse writes
  `museHome/runtime/muse/sessions/<sessionId>.json`:
  `{"schema_version":1,"session_id":"…","process_generation_hint":"pid=<pid>",…}`.
  The pid is the TUI process (§1).
- On `/clear`, `/new` and in-TUI `/resume` the old file goes and the new session's
  file appears with the same pid. `muse resume <id>` writes the resumed id. After
  `/exit` the last file stays behind, stale.
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
  session is missing from the list for 3–5 s.
- `muse serve --provider echo` (no login needed) can read a session another muse
  process holds: `session/read` returns its items (`userMessage`, `agentMessage`, … with
  `itemId`, `recordedAt`), and `approval/listPending {sessionId}` returns what it waits
  on: `approvals:[{approvalId, availableChoices:[{choiceId, decision, label}], rawArgs,
  …}]` and `userInputs:[{questions:[{id, header, question, options:[{label,
  description}], selection:{mode}}], …}]` (fake model). It cannot act on it:
  `approval/decide`, `userInput/answer`, `view/subscribe`, `session/resume` are refused
  (`-32021 sessionInUse` / `-32024 sessionNotLoaded`). Neither can the TUI attach to a
  host Koloft would run.

## §6 tmux swallows OSC 7501

- Inside tmux 3.3a (the multiplexer Koloft's remote tabs run in) the 7501 query never
  reaches the outer terminal, also with `allow-passthrough on`, so Muse on its own sends
  no states at all. §16 has what makes them flow.

## §7 No way to post into a live session from outside

- `muse session-message send` refuses a sender that is not itself a muse session. The
  `ms-*.sock` socket the registry names is not MSP. So the only way in is typing into
  the terminal.
- While a turn runs the TUI drops an Enter (macOS); a bracketed paste lands in the
  input box unsent until the next Enter.

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

## §10 Workspace trust

- The TUI in a folder with no recorded decision first asks "Do you trust this
  workspace? … 1 Trust and continue 2 Quit". The answer is saved in
  `$XDG_CONFIG_HOME/muse/trust.json`:
  `{"schema_version":1,"projects":{"<path>":{"decision":"trusted"}}}`, keyed by the
  folder's real path.
- An entry another program wrote first is honoured (no question), and muse keeps the
  other entries when it adds one (it rewrites the file pretty-printed).
- `--trust-workspace` trusts the folder for that run only and saves nothing.

## §11 Approvals and questions in the terminal

- (fake model) `blocked:kind=permission` shows "1. Yes, proceed (y)  2. No … (esc)";
  a network target adds "2. Yes, don't ask again this session (p)". `y`, `1` or Enter
  approve, Esc rejects. `blocked:kind=question` shows the options; Enter picks the
  first, `<n>` then Enter or Down then Enter another, Esc cancels. A key sent within
  half a second of the `blocked` frame was applied only a minute later; two seconds
  after it, at once.
- Network approvals fire no hook at all; only the 7501 frame and
  `approval/listPending` (§5) show them.
- The input box is the one row between the last two full-width `────` rules, starting
  with `❯` (bare when empty, `❯ <draft>` with text in it); the status row, and any
  background-task rows, come below the second rule. An approval box takes its place:
  several rows between the rules and no `❯` row (1.4.9, fake model, Docker, 2026-10,
  read from the rendered screen). Slash-command menus were not looked at.
- What a slash command prints (`/usage`, `/status`, …) is drawn on the screen only; the
  session log holds none of it (1.4.9, fake model).

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
  folder (mode 0600), and two folders hold two credentials. Measured for API keys;
  where a finished device-code login lands is not probed (needs a Meta account).
- A config folder whose `muse/trust.json`, `settings.json` and `AGENTS.md` are symlinks
  to the user's own files works: muse keeps each symlink and rewrites the file it
  points to (trust answers, `/theme`, `/permissions`), drops empty `.<name>.lock` files
  beside the symlinks, and `auth set` writes a real `auth.json` (0600) in the folder
  itself. A `settings.json` without `"schema_version"` stops both the TUI and
  `muse serve` ("malformed settings file"). Sessions and the live registry stay in
  museHome (§2) whatever `XDG_CONFIG_HOME` says (Docker and macOS).
- `muse serve` (experimental capability) `account/read` → `state:
  "loggedOut"|"apiKey"|"envKey"|"accountLogin"`; `account/loginStart {type}` returns
  the device code and URL.
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
  network fetch (without the network flag), a shell command of several stages (`a; b`),
  a command leaving the sandbox and a write outside it still do.
- `--approval-mode never` (alone, with `--sandbox-network enabled` or with
  `--approval-judge off`): nothing ever asks the user and no judge runs; every tool
  runs inside the sandbox, `web_fetch` included, and a shell command asking to leave
  the sandbox is refused with "unsandboxed execution requires human approval, but
  approval prompts are disabled" (fake model, Docker and macOS).
- `--permission-profile :unrestricted`: no sandbox, no prompts; a command asking to
  leave the sandbox is refused rather than asked.

## §16 Muse on another machine, inside tmux

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
  terminal outside tmux when tmux has `set -g allow-passthrough on`.
- Attaching to the tmux session again replays no 7501 frame.
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
