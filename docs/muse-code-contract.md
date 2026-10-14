# Muse Code contract ledger

Measured facts about Meta's Muse Code CLI (`muse`) that Koloft depends on and that
**reading Koloft's own code cannot reveal**. Claude Code, Codex and the platforms have
their own ledgers. Each entry says how it was established; a disproven entry is
corrected in place, never kept for history. Code cites a section with a `// MUSE§N`
marker.

**How everything here was established, unless a bullet says otherwise**: muse 1.4.7
(`Muse Code 1.4.7 (1.4.7-R6101.1)`), installed with its official installer, run with
`--provider echo` (a built-in model that echoes the prompt; no account, no network) in
a Linux Docker container and in a throwaway macOS 27 virtual machine, October 2026. A
terminal was simulated with a pty driver that answers the TUI's queries. Nothing that
needs a Meta account (a real model) has been run: a bullet that depends on one says
"inferred, not checked".

## §1 The command line

- `muse [OPTIONS] [PROMPT]` starts the TUI (text user interface); a prompt becomes the
  first message. `muse resume <session-uuid-or-name>` reopens a session in the TUI.
  `muse exec [OPTIONS] [PROMPT]` runs one prompt headless (subcommand first, its flags
  after). Root options may sit on either side of `resume` (`muse resume --help` says
  so).
- Options Koloft uses: `--model <id>`, `--reasoning-effort
  none|minimal|low|medium|high|xhigh|max|ultra`, `--approval-mode
  untrusted|on-request|never` (default `on-request`), `--trust-workspace` (§10). There
  is no accept-edits mode. `--model` is refused with `--provider echo` ("--model
  requires --provider meta or local").
- `-c KEY=JSON` sets one setting for the run; an unknown key refuses the run.
  `developer_instructions` and `instructions` are unknown keys, so there is no measured
  way to hand Muse extra instructions. `--agents <JSON>` takes an agent-definition
  overlay and is accepted; whether its text reaches the model cannot be seen with the
  echo provider (inferred, not checked).
- `muse --version` prints `Muse Code 1.4.7 (1.4.7-R6101.1)`.
- The installer (`curl -fsSL https://dev.meta.ai/install.sh | bash`) puts a launcher
  script at `~/.local/bin/muse`. It ends with `exec "$binary" "$@"`, so the process a
  terminal spawns becomes the muse binary itself and keeps its PID (macOS: `lsof -p`
  on the spawned PID lists muse's own files).

## §2 Where Muse keeps its data

- museHome is `~/.local/share/muse` on both macOS and Linux (`serve`'s `initialize`
  reports it), and `$XDG_DATA_HOME/muse` when that is set (Linux measured).
- Sessions live at `museHome/sessions/YYYY/MM/DD/<session-uuidv7>/session.jsonl`.
- Settings and trust live under `~/.config/muse/` (§10).

## §3 Status: OSC 7501

- Muse speaks the terminal "program status" protocol, OSC 7501 (the same one Claude
  Code 2.1.295+ sends, CC ledger). At startup it writes the query `ESC ] 7501 ; ? ESC
  \` once per process (not again after `/clear` or a turn). It sends states only after
  the terminal answers exactly `ESC ] 7501 ; ? : states=idle,working,done,blocked,error
  : kinds=permission,question,auth ESC \`. A terminal that never answers (tmux, §6)
  gets no states.
- State frames look like `ESC ] 7501 ; state=<state>:app=muse ESC \`. Seen sequences:
  startup `idle`; a turn `working` then `done`; a failing `!cmd` shell command
  `working` then `error` and nothing after; `/clear` and `/new` `clear` then `idle`;
  `/exit` a bare `clear`.
- The first `idle` comes only after the trust question (§10) is answered, and it can
  arrive before the live-registry file (§4) is written (0.13 s before, measured once).
- With no login, muse (default provider, started with a first prompt) shows its login
  screen ("Log in with browser · Set an API key", then a device code) and sends
  `state=blocked:kind=auth:app=muse`; it has already written its live-registry file
  (§4). `blocked` with `:kind=permission|question` needs a real model to trigger
  (inferred, not checked).
- Started with a first prompt, muse is taken to report the state it is in (`working`)
  once the terminal answers the query; only the startup `idle` has been seen (inferred,
  not checked).
- Muse has no status-line hook: OSC 7501 and its own footer are all it shows.

## §4 Which session a process holds: the live registry

- For every live session Muse writes
  `museHome/runtime/muse/sessions/<sessionId>.json`:
  `{"schema_version":1,"session_id":"…","session_name":null,"endpoint_hint":"ms-….sock","workspace_label":"…","target_eligibility":"message_capable","process_generation_hint":"pid=<pid>"}`.
  The pid is the TUI process (§1).
- On `/clear` and `/new` the old file goes and the new session's file appears with the
  same pid (well within a second). `muse resume <id>` writes the resumed id. After
  `/exit` the last file stays behind, stale.
- **Muse must create `runtime/muse/sessions` itself**: when that folder already existed
  (made by another process) before muse started, muse wrote no registry file at all
  (waited 8 s, Linux).
- The process also keeps `museHome/sessions/…/<id>/.session.lock` open for the session
  it holds (`lsof -p`, 5–16 ms on macOS), switching on `/clear`, `/new` and resume.
  Subagent locks sit under `subagent/`.

## §5 `muse serve`: listing and reading sessions

- `muse serve` speaks MSP (Muse Session Protocol): JSON-RPC 2.0 over stdio, one JSON
  object per line. Handshake: request `initialize {clientInfo:{name,version}}` (`name`
  must match `[a-z0-9_]+`; a hyphen is refused; no `capabilities` needed), then the
  notification `initialized`. `muse schema generate-ts` exports the protocol types.
- `session/list {limit?, cursor?, workspaceRoot?}` → `{sessions:[…], nextCursor}`;
  without `workspaceRoot` it lists every folder's sessions; `nextCursor` is `null` on
  the last page. A session carries `sessionId`, `path`, `createdAt`/`updatedAt`
  (RFC 3339 strings), `workspaceRoot`, `title`, `name`, `firstUserPrompt`,
  `turnCount`, `kind` (`"root"`), `forkedFrom`. Listing works without a login. A
  session a TUI holds is listed with `status:"notLoaded"`.
- `session/read {sessionId, excludeItems:false}` → `history:{mode:"inline",
  items:[…]}` with items of kind `userMessage`, `agentMessage` (both with `text`),
  `reasoning`, `reminderChild`; every item carries `itemId`, `turnId`, `status` and
  `recordedAt` (RFC 3339), seen on macOS. Without a login a plain `muse serve` refuses it
  (`resume_refused_class_c`: the automated reviewer is unavailable). `muse serve
  --provider echo` reads echo-made sessions, including one a TUI holds right after
  its `done` (0.13 s). Reading a session made with the real model this way is
  inferred, not checked.

## §6 tmux swallows OSC 7501

- Inside tmux 3.3a (the multiplexer Koloft's remote tabs run in) the 7501 query never
  reaches the outer terminal, also with `allow-passthrough on`, so Muse sends no states
  at all. A remote Muse tab would have no status.

## §7 No way to post into a live session from outside

- `muse session-message send` refuses a sender that is not itself a muse session
  ("external agent ingress is unavailable"). With the experimental gate
  `MUSE_EXPERIMENTAL_EXTERNAL_AGENT_INGRESS=1`, `list` works but `send` is refused
  (`causal_metadata_invalid`). The `ms-*.sock` socket the registry names is not MSP
  (`malformed_hello`). So the only way in is typing into the terminal.

## §8 Shell commands inside Muse

- `!cmd` (a shell command the user runs from the TUI), macOS VM, both default and
  `--approval-mode never`: it keeps the TUI's PATH and environment (a PATH-prepended
  script ran; a custom variable survived), the network works, `/tmp` is writable, and
  `~/Library/Application Support/…` is not ("Operation not permitted", Muse's
  sandbox). Whether the model's own shell tool gets the same is inferred, not checked.
- In Docker, `!cmd` fails because Muse's Linux sandbox (bubblewrap) cannot make
  namespaces there, even with `--privileged`.

## §9 Hooks

- Hooks passed per run (`-c hooks=…`, `-c managed_hooks_path=…`) fire for the first
  session only and are lost after `/clear`. Only hooks in the user's own
  `~/.config/muse/settings.json` survive it. Hook commands get a cleared environment
  (HOME, PATH, PWD, MUSE_SESSION_ID, MUSE_THREAD_ID). `muse resume` fires no
  SessionStart; SessionEnd always says `reason:"other"`.

## §10 Workspace trust

- The TUI in a folder with no recorded decision first asks "Do you trust this
  workspace? … 1 Trust and continue 2 Quit". The answer is saved in
  `~/.config/muse/trust.json`:
  `{"schema_version":1,"projects":{"<path>":{"decision":"trusted"}}}`, keyed by the
  folder's real path (a TUI started in a symlinked folder saved the resolved path).
- `--trust-workspace` trusts the folder for that run only and saves nothing. `muse
  exec` in an untrusted folder still runs.
