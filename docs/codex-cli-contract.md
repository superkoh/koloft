# Codex CLI contract ledger

Facts measured outside Koloft, and the limits of those measurements. These facts can
change when Codex changes. Koloft behavior belongs in its tests; this ledger does not
replace those tests or claim that every user configuration has been tested.

Sections 1–7 were checked on **2026-09-09**, on macOS arm64, using the independently
installed npm package **`@openai/codex@0.153.4`** (`codex-cli 0.153.4`), not the binary
bundled with the ChatGPT app. The relay probes used Node 24.13.0 and a Python PTY driver,
and every probe drove the real Codex TUI.

Protocol shapes were checked against that binary's `app-server generate-json-schema`
output and the [official app-server documentation](https://learn.chatgpt.com/docs/app-server).
Schema availability is distinguished from behavior actually seen on the wire.

## 1. Transport and initialization

**Measured with a real TUI and a separate read-only client.**

- `codex app-server --stdio` exchanges one JSON object per line on stdin/stdout.
- `codex --remote unix:///absolute/path/rpc.sock -C /absolute/workspace` connects using
  WebSocket over a Unix socket. A relay can forward this connection to one dedicated
  stdio app-server. Both the original TUI requests and server responses pass through
  that connection; a second observer connection is unnecessary.
- The TUI sends `initialize`, waits for its result, then sends `initialized` before
  normal requests. An independent client using this handshake successfully called
  `thread/list`; the response contained `data` and `nextCursor`.
- Koloft's history reads send `thread/list` with `archived` (true/false) and
  `sourceKinds: ["cli","vscode","appServer"]`; that these values select every user
  thread is not probed yet.
- Request IDs are strings **or numbers, including zero**. Startup and temporary title
  requests used strings; the real command approval request used numeric `0`.
- The TUI made its own `config/read` and `account/read` requests through the relay.
  Reading history through a different app-server is not evidence that it subscribes
  to a running TUI's events.
- **Checked on 2026-09-25 with the standalone 0.153.4 binary**, in a Python PTY at
  120×40, with a fresh `CODEX_HOME` holding only a trusted folder, a test provider on
  an unused localhost port, and a `version.json` whose `latest_version` was `0.156.1`
  (the value the real home had cached). The TUI drew an "✨ Update available! 0.153.4
  -> 0.156.1" box over its start screen. The same start with
  `-c check_for_update_on_startup=false` drew no such box. The key is a top-level
  config field in that binary's strings. Not probed yet: a `--remote` start — Koloft's
  only mode — with the same cached `version.json` and the key passed to the TUI alone.
  Under `--remote` the TUI reads its config from the app-server (`config/read`, above),
  so whether the TUI-side `-c` reaches the check is open.

## 2. Foreground identity and native operations

**Measured by driving the actual TUI, waiting for each result, and recording request
and response IDs.** The sequence was initial session → `/new` → `/fork` →
`/resume <original UUID>` → `/exit`.

| Native operation | Observed wire behavior |
| --- | --- |
| Initial session | `thread/start`, with `ephemeral:false` and `threadSource:"user"`; its matching result supplied the foreground `thread.id` |
| `/new` | Two `thread/unsubscribe` requests for the old thread occurred before `thread/start`; the start response supplied a different ID |
| `/fork` | `thread/fork` targeted the current thread; its response supplied a new foreground ID; the old thread was unsubscribed afterward |
| `/resume <UUID>` | `thread/resume` returned that existing thread ID; the previous foreground thread was unsubscribed afterward |
| `/exit` | The foreground thread was unsubscribed, then the TUI disconnected and exited |

`thread/unsubscribe` returned `{ "status": "unsubscribed" }` in the real trace.
Unsubscribe also occurs during switching and temporary work: its presence alone does
not prove that the user exited. Two unsubscribes during `/new` is an observation, not
a requirement for recognizing that operation.

The same TUI connection created temporary title-generation threads using `thread/start`
with `ephemeral:true` and `threadSource:"system"`. They emitted their own turn events,
completed and were unsubscribed while the foreground thread went on, so a
`thread/start` on that connection is not always the foreground thread.

A fresh, empty session returned a non-null rollout `path` whose file **did not yet
exist**. A path in a start response does not prove that a session can already be
restored from disk. This was checked before submitting any prompt in the worktree probe.

**Archived history is not directly resumable.** A separate probe archived one of its
own persisted threads with `thread/archive`, then launched the real TUI with
`resume <that UUID>`. The TUI sent `thread/resume` and received error `-32600`, stating
that the session is archived and must first be unarchived with `codex unarchive`.
It did not automatically send `thread/unarchive`. So a record that `thread/list`
returns with `archived:true` cannot be resumed as it is.

**A thread resumes in another folder without a question.** Checked 2026-10-08 with
codex-cli 0.159.3: `codex exec` (own `CODEX_HOME` with a copy of this Mac's login and
trust tables for two folders, deleted afterwards) started a thread in folder A; the
real TUI in a Python PTY then ran `codex -C <folder B> resume <id>` (no `--remote`).
It showed "Resuming session…", drew the old turn, and its footer named folder B; no
question about which folder to use came up in 12 s. The binary also holds a
`tui.resume_cwd` setting (`"session"` / `"current"`) and the labels "Always use session
directory" / "Always use current directory", so a question does exist somewhere; when
it shows was not found. The same line with `--remote` was not run.

**Native input and resize were checked separately.** Sending first-line text, LF,
second-line text, then CR through the PTY produced one user `turn/start`; its text
contained the two lines separated by `\n`: LF adds a line, CR submits. A `TIOCSWINSZ` change to 26 rows × 90 columns kept the TUI responsive,
and `/exit` still completed normally. This is a functional check, not a visual audit
of every terminal size or input method.

## 3. Approval, settings and login

**Measured with an isolated CODEX_HOME and a real write requiring approval.**

The TUI was started with `-a on-request -s read-only`. The model requested a shell
command that wrote `approved` to one file in the temporary probe repository. The server
sent `item/commandExecution/requestApproval`, carrying its request ID, `threadId`,
`turnId`, `itemId`, command, cwd, reason and `availableDecisions`. The original TUI
displayed the approval. Pressing **y** there produced a client reply with the same ID
and `{ "decision": "accept" }`; the file was then written and the turn completed.
The relay never answered the approval itself.

The approval dialog takes single keys, with no Enter after them: `y`, `1` or Enter
approve; `3` or Esc decline. Recorded from the Discord design round's probe notes
(2026-10-02, Codex 0.159.3, a real TUI); the setup was not re-run here.

Not probed yet: `…/requestApproval` for other item kinds. `item/tool/requestUserInput`
and `mcpServer/elicitation/request` were seen on the wire later (section 20).

The real model probes used a fresh temporary `CODEX_HOME`, populated with a local copy
of an available test login. Credentials were not printed or put in evidence files;
the source login was not changed and no login/logout action was performed. The TUI and
app-server used the same home and accepted its native configuration. An unauthenticated,
separate home also supported initialization and empty history reads.

For the small model probes, `features.apps=false` and `features.plugins=false` avoided
unrelated connector startup. The child-agent probe enabled `features.multi_agent`.
These probes **do not establish compatibility with every plugin, hook, connector or
custom model provider**.

## 4. Background commands and child agents

**Measured with the real TUI and model, without a second observer connection.**

### Background command

The main task ran `sleep 12; printf BG_COMMAND_FINISHED` with a short tool yield, then
gave its final response without waiting. The relay saw:

1. `item/started` for a `commandExecution` item, with `status:"inProgress"`,
   `source:"unifiedExecStartup"`, an item ID and a `processId`.
2. The main thread became `idle` and emitted `turn/completed` while the command was
   still running.
3. About nine seconds after the main turn completed, `item/completed` arrived for the
   same thread, turn and item, with `status:"completed"`, `exitCode:0` and the output.

Thus `turn/completed` does not imply that all commands are done. A command item can
outlast its turn; its later completion remains observable on the TUI connection.
The string `processId` is a tool handle, **not proof of an operating-system PID**.

### Child agent

The main task spawned a child that ran `sleep 12`, then immediately returned its own
final response without waiting. The relay saw:

1. A parent `collabAgentToolCall` for `tool:"spawnAgent"` began and completed. Its
   completed item supplied `receiverThreadIds:[childId]` and
   `agentsStates[childId].status:"pendingInit"`.
2. The child emitted its own `thread/status/changed` → `active`, `turn/started` and
   command item events through the same relay.
3. The parent emitted `idle` and `turn/completed` while the child was still working.
4. About fifteen seconds later, the child command completed, then its thread became
   `idle` and emitted `turn/completed`.

The completed **spawn tool call** is not completion of the **spawned child**.
The parent-child relationship comes from the collab item, not from treating every
other thread on the wire as a child. Temporary title threads share that wire too.

### Schema limits

The 0.153.4 generated schemas declare:

| Shape | Fields relevant to activity |
| --- | --- |
| `ThreadStatus` | `notLoaded`, `idle`, `systemError`, or `active` with `activeFlags` |
| `ThreadActiveFlag` | Only `waitingOnApproval` and `waitingOnUserInput` |
| `commandExecution` | Item ID, command, cwd, status; optional process ID, exit code, duration and output |
| `CommandExecutionStatus` | `inProgress`, `completed`, `failed`, `declined` |
| `TerminalInteractionNotification` | Thread ID, turn ID, item ID, process ID and stdin text |
| `collabAgentToolCall` | Tool, sender thread ID, receiver thread IDs, tool-call status and last-known agent states |
| `CollabAgentStatus` | `pendingInit`, `running`, `interrupted`, `completed`, `errored`, `shutdown`, `notFound` |
| `thread/backgroundTerminals/list` | Per-thread entries with command, cwd, item ID and process ID; optional OS PID, CPU and RSS |

The background-terminal list and terminal-interaction shapes were inspected in the
schema, **not used as evidence for the lifecycle tests above**. No inspected field
reliably distinguishes a finite background job from a resident development server.
Command text, low CPU, an open terminal or `ThreadStatus.active` do not prove that
distinction either. A still-open command does not by itself show that the agent is
still reasoning.

## 5. Process exit and crash boundaries

**Measured with the real 0.153.4 app-server running a streaming `command/exec`
(`sleep 30`, not a model turn); its Node host was killed with SIGKILL.** The host's
pipe closed. After 1.5 seconds, host, app-server and command PID were all gone, with no
stop code run by the host.

The schema describes command processes as connection-scoped and says connection
closure terminates them; the result confirms that case. It does not establish the same
behavior for a detached shell daemon, an MCP server or a nested tool, so nothing here
says Codex reclaims a descendant that has left its process group.

**An app-server whose host was killed outlives it and keeps its thread locked.** Measured
2026-10-09, codex 0.162.0, a hidden Koloft build in a scratch `HOME` and `CODEX_HOME`:
one Codex tab ran one turn, then Koloft's main process got SIGKILL. The TUI died at once;
the detached `codex app-server --stdio -c tui.status_line=…` was re-parented to pid 1 and
exited on its own 13.7–13.9 s later. A relaunched Koloft that resumed the same thread
while it lived (1.1 s after the kill, two runs) got, within 0.4 s, "This conversation is
open in another app — Close it there and press R to continue here"; pressing `r` after
the old app-server had exited resumed in 0.2 s, and a resume ~20 s after the kill was
normal. With four app-servers resuming one thread at once, three showed the same lock.

Koloft's own stop, ownership and retry rules are product rules, covered by
`test/unit/codexTransport.test.ts`, not Codex facts.

## 6. Worktree boundary

**Measured without a model call.** In a temporary repository with a committed baseline,
Git created a linked worktree. The real TUI and app-server ran in that checkout using
`-C`. The returned thread cwd matched it. After native `/exit`, the checkout directory,
branch and HEAD were still present and unchanged.

## 7. Rechecking a CLI upgrade

Each dated section names the binary it ran: mostly 0.153.4, some 0.159.3. Koloft treats
the minor line of its minimum (`MIN_CODEX_VERSION` in `src/main/cliMinimums.ts`) as
verified (`verified` in `src/main/codexRuntime.ts`, pinned by
`test/unit/codexRuntime.test.ts`) and warns on anything newer. **The owner raised the
minimum from 0.153.4 to 0.161.0 on 2026-10-08 without redoing the live checks below on
0.161**; that the sections still hold on 0.161 is inferred, not checked. Those checks
are: section 1 (handshake and the update-notice key), 2, 3, 4, 5, 8 (status-line item
ids), 9 (the trust question before connecting), 11 (trust table, approval flags), 12
(`fileChange` / `commandActions` shapes, the `open` shim), 13 (token-usage fields), 14
(first prompt, `-m`, `model_reasoning_effort`) and 15 (`account/read`,
`account/rateLimits/read`, per-home state).

Keep worktree tests inside a temporary repository. Record version, executable source,
matching request IDs, thread IDs and event order; redact login/account contents. Fixture
tests cannot replace these external checks.

## 8. Native status line

**Checked on 2026-09-10 with standalone Codex CLI 0.153.4, without a model call.**
The real TUI ran in a temporary Git repository with an isolated `CODEX_HOME` and
an unauthenticated test provider pointing at an unused localhost port. Both ordinary
startup and `--remote unix://…` against a separate real app-server were checked.
The PTY output was decoded with pyte at 120 and 55 columns.

- `tui.status_line` selects ordered built-in item IDs. Passing it with `-c` to the
  server and remote TUI displayed the selected items. A separate `config/read`
  probe confirmed that server startup overrides supersede the file's list without
  rewriting that file.
- The footer occupied one line. Long content ended in an ellipsis at both widths;
  shrinking the terminal did not wrap it. A `"\n"` item produced an invalid-item
  warning and was ignored. The picker had no `newline` item. These checks establish
  that the tested native configuration cannot reproduce a three-line footer.
- The TUI displayed `context-used`, `git-branch`, `codex-version`, `model`,
  `reasoning`, `model-with-reasoning` and `current-dir` from the empty test session.
- `account` and `git-worktree` produced invalid-item warnings; searching the picker
  for account and worktree returned no matches.
- The picker describes `branch-changes` as **committed** changes against the
  default branch. It is not a substitute for working-directory change counts.
- The picker describes `pull-request-number` as the open PR number for the current
  branch, omitted when unavailable. It does not describe review or check status.
- The picker describes `estimated-thread-cost` as an estimate in USD for
  **Enterprise workspaces only**, omitted when unavailable. Its preview contains
  sample cost and PR values; those are not evidence of actual account data.
- The picker offers `Use theme colors` (`tui.status_line_use_colors`). No per-item
  background colors or Powerline separator settings were exposed by the tested
  configuration or picker.

## 9. Confirmation before remote resume

**Checked on 2026-09-10 with standalone Codex CLI 0.153.4.** A saved rollout was
copied into an isolated `CODEX_HOME` and resumed in the real Electron/xterm UI,
against a test provider on an unused localhost port. The native TUI displayed the
directory trust question before connecting to the remote app-server or binding a
thread. A resume-loading overlay therefore hides a required interaction, and a
connection deadline can expire while the user is deciding. Waiting more than 15 seconds before confirming still
resumed the original thread and rendered its history with no connection deadline;
closing the owning PTY still tears down its unused server.

Inferred, not checked: a run waiting on the native "resume this thread?" question has
not opened a thread yet, so it publishes no session entry for as long as the user
takes to answer. The check above covered the directory trust question only.

## 10. Runtime markers from an enclosing app

Inferred, not checked: these variables are set by the app that encloses Codex, not
by the user's own configuration of a new CLI, and a child Codex that inherits them
acts as part of the enclosing run: `CODEX_APP_TOOLS_PIPE_PATH`,
`CODEX_INTERNAL_ORIGINATOR_OVERRIDE`, `CODEX_MCP_NODE_PATH`,
`CODEX_PERMISSION_PROFILE`, `CODEX_SAGE_BACKFILL_TRACKER_TAB_REUSE`,
`CODEX_SESSION_ID`, `CODEX_THREAD_ID`, `CODEX_SHELL` and `CODEX_CI`. (The list came
from a Koloft code note already in the repository's first commit; where the names were
found, and on which version, was not recorded.)

Checked 2026-09-24 with `strings` on the standalone codex-cli 0.153.4 binary: it names
`CODEX_CI`, `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`, `CODEX_PERMISSION_PROFILE`,
`CODEX_SESSION_ID` and `CODEX_THREAD_ID`. It holds no literal
`CODEX_APP_TOOLS_PIPE_PATH`, `CODEX_MCP_NODE_PATH`,
`CODEX_SAGE_BACKFILL_TRACKER_TAB_REUSE` or `CODEX_SHELL`; that the CLI does not read
those four, and what sets them, is inferred, not checked.

**The model's shell commands run with the env the app-server was started with.**
Measured 2026-10-08 with Codex CLI 0.161.0, a real model turn, a `CODEX_HOME` whose
`config.toml` set only folder trust (no `shell_environment_policy`, from there or from
Koloft's `-c` overrides): with
`KOLOFT_PORT_OFFSET` in the `codex app-server` spawn env, the model's
`echo "$KOLOFT_PORT_OFFSET"` ran as `["/bin/zsh","-lc",…]` in the thread's worktree and
printed the value; the rollout's `item_completed` event holds it as a `CommandExecution`
item with `aggregated_output` (also `stdout`, `formatted_output`). Established by
`agent-tools-real-smoke.spec.ts` › "a real Codex in a worktree Koloft made gets the
ignored files .worktreeinclude lists, and echoes, with its shell tool, the port offset of
that worktree’s name".

## 11. Folder trust and the approval flags

**Checked on 2026-09-24 with standalone Codex CLI 0.153.4 (`codex-cli 0.153.4`), without
a model call.** The TUI ran in a Python PTY (120×40, answering its cursor, colour and
keyboard queries) with an isolated `CODEX_HOME` holding a test provider on an unused
localhost port, so no login screen came first. The test repository had one commit and a
linked worktree at `<repo>/.claude/worktrees/probe`. Each run lasted 8 seconds and pressed
no key.

- With no `projects` entry, the TUI asked "Do you trust the contents of this
  directory?" both in the repository and in the linked worktree.
- A `[projects."<repo real path>"]` table with `trust_level = "trusted"` in
  `config.toml` stopped the question in the repository **and** in its linked worktree.
  A table for the worktree path alone stopped it in the worktree. The worktree sat
  inside the repository folder, so whether the table covers it as a sub-folder or as a
  linked worktree was not told apart; a linked worktree outside the repository is not
  probed yet.
- **Codex CLI 0.159.3 (2026-10-02) asks again in the linked worktree**: an e2e run on
  the real binary, with `[projects."<repo real path>"]` `trust_level = "trusted"` in its
  `CODEX_HOME/config.toml` (written by the test and by Koloft), showed "Folder access …
  Trust this folder?" for `<repo>/.claude/worktrees/<name>`. A second table for the
  worktree path itself stopped it.
- Unanswered, the question left `config.toml` byte-for-byte unchanged.
- What Codex writes when a person answers **No** was not tried. That it writes a
  table for the folder (so Koloft, which leaves any existing table alone, never
  overrides the answer) is **inferred, not checked**.
- The same table shape (`[projects."<absolute path>"]` / `trust_level = "trusted"`) is
  what Codex itself had written into this Mac's own `~/.codex/config.toml`, read on the
  same day.

These runs started the TUI without `--remote`. Section 9 saw the same question under
`--remote`; section 14 then checked that a `config.toml` table also stops it there.

**Approval flags, read from `codex --help` on the same binary.** `-a/--ask-for-approval`
takes `on-request` or `never`; `-s/--sandbox` takes `read-only`, `workspace-write` or
`danger-full-access`. There is **no `--full-auto`**: `codex --remote ws://127.0.0.1:9
--full-auto` stopped with `error: unexpected argument '--full-auto' found`, while the
same line with `-a never -s danger-full-access` or `-a on-request -s workspace-write` got
past argument parsing (it then stopped at "stdin is not a terminal"). In section 3's
run, `-a on-request -s read-only` led to an approval request. That `never` /
`danger-full-access` and `workspace-write` take effect the same way was **not
exercised against a model — inferred, not checked**.

**Codex CLI 0.162.0 refuses the approval flags on a resume under `--remote`, and the
app-server's own config sets them instead.** Measured 2026-10-09 with `codex-cli
0.162.0`: a Python PTY (120×40, answering the TUI's cursor and colour queries) ran
`codex app-server --listen unix://<socket>` and the TUI `codex --remote unix://<socket> -C
<folder> …`, with a throwaway `CODEX_HOME` holding only `auth.json` and the folder's trust
table, real model turns, and each turn's settings read from the `turn_context` record in
the thread's rollout file. The test asked the model to `touch` a file outside the folder.

- `… resume <thread>` with `-a never`, with `-s workspace-write`, with both, or with
  `-c approval_policy="never" -c sandbox_mode="workspace-write"` on the TUI: the TUI drew
  "Resuming session…", then ended with "Error: Permission overrides are not supported
  when resuming a remote task." (exit code 1 where the driver caught the exit). The check runs after the TUI connects:
  against a socket that does not exist, every form fails first with "failed to connect to
  remote app server". The same `-a`/`-s` on a new thread (no `resume`) are taken.
- A bare `resume` (no flags) works. What it ran under, from `turn_context`: a thread
  started with `-a never -s workspace-write` came back `never` / `workspace-write`; one
  started with `-a never -s danger-full-access` came back `never` / `workspace-write`, and
  its `touch` outside the folder was refused; one started with no flags (`on-request` /
  `read-only` in that folder) came back `on-request` / `workspace-write`. So the approval
  policy comes back with the thread, and the sandbox comes back as `workspace-write`
  whatever it was. Where that `workspace-write` comes from is **inferred, not checked**.
- The same bare `resume`, with `-c approval_policy="never" -c sandbox_mode="danger-full-access"`
  given to `codex app-server` instead: `turn_context` showed `never` /
  `danger-full-access` and the `touch` outside the folder worked with no question. With
  `sandbox_mode="workspace-write"`: `never` / `workspace-write`, the `touch` was refused,
  no question.
- `workspace-write` lets the model's shell write in `/tmp` and in `$TMPDIR`: a `touch` in
  a folder under `/private/tmp` worked under it, and was refused once `config.toml` held
  `[sandbox_workspace_write]` with `exclude_slash_tmp = true` and
  `exclude_tmpdir_env_var = true`. The e2e homes live under `$TMPDIR`, so a real-binary
  case that checks a write outside the workspace sets those two.

So Koloft hands a launch's approval and sandbox choice to the TUI as `-a`/`-s` on a new
thread, and to that run's own app-server as `-c approval_policy=…` /
`-c sandbox_mode=…` on a resume. Established again through Koloft by
`discord-real-smoke.spec.ts` › "a real Codex conductor whose tab closed is resumed by the
owner’s next message, …" (before the change: "The conductor closed before it was ready")
and `agent-tools-real-smoke.spec.ts` › "a real Codex session launched with approvals and
the sandbox bypassed, resumed after its tab closed, …" (before the change: `turn_context`
`never` / `workspace-write`, the write refused). A new thread with the choice on the
app-server alone, and no `-a`/`-s` on the TUI, is not probed yet.

## 12. Files a turn touched, and a command that opens a file

**Checked on 2026-09-24 with standalone Codex CLI 0.153.4 (`codex-cli 0.153.4`), one real
model turn.** A Node script ran `codex app-server` on stdio and sent `initialize`,
`initialized`, `thread/start` (`approvalPolicy: "never"`, `sandbox: "workspace-write"`) and
one `turn/start`, in a temporary Git repository. `CODEX_HOME` was a temporary folder with
`features.apps=false`, `features.plugins=false`, a trust table for the repository and a
copy of this Mac's own login file, deleted after the run. The prompt asked for one patch
(two edits and one new file), then `cat notes.txt`, then `open ./missing-report.html` (a
file that did not exist, so no app opened), then `echo hello > shellwrite.txt`. Every
server frame was saved and read.

- A patch arrived as one `fileChange` item: `item/started` with `status: "inProgress"`,
  then `item/completed` with `status: "completed"`, both carrying the full `changes`
  list. Each change had an **absolute** `path`, a `kind` (`{type: "add"}` or
  `{type: "update", move_path: null}`) and a `diff`. For an update the diff was a unified
  hunk (`@@ -1 +1 @@`, `-old`, `+new`, no `---`/`+++` file lines); for an added file it
  was the file's text with no `+` signs.
- A shell command arrived as a `commandExecution` item whose `command` was wrapped in the
  user's shell: `/bin/zsh -lc 'cat notes.txt'`. Its `commandActions` list held the
  command without the wrapper. `cat notes.txt` came as `{type: "read", path: <absolute>}`;
  `cat notes.txt sub/deep.txt`, `open ./missing-report.html` and `echo hello >
  shellwrite.txt` each came as `{type: "unknown", command: …}`. So a file written through
  the shell shows up nowhere as a file.
- `open ./missing-report.html` really ran: the item completed with `status: "failed"`,
  `exitCode: 1` and the system `open` tool's "file … does not exist" message. Nothing on
  the wire lets a client stop it, so a real file would also open in its own app.
- `item/completed` for a command that ran fine had `status: "completed"`.

Not seen on the wire, read from the generated schema only: the `delete` kind, a
non-null `move_path`, and the `failed` / `declined` patch statuses. How they arrive is
**inferred, not checked**. `open <url>`, and `open` under `read-only` or with
`on-request` approval, were not tried (a URL would have opened a browser on this Mac):
that they reach the wire the same way is **inferred, not checked**.

**`thread/resume` hands back the old turns in its reply, not as frames.** Checked
2026-09-29 with codex-cli 0.153.4: one real turn (`thread/start` with
`sandbox: "workspace-write"`, `approvalPolicy: "never"`) wrote a file with a patch; a
second `codex app-server` then answered `thread/resume` with `thread.turns` holding that
turn (`status: "completed"`, items `userMessage, agentMessage, fileChange, agentMessage`),
its `fileChange` item the same shape as the live `item/completed` one. No
`item/completed` frame came in the 3 s after the reply. The reply also carried
`initialTurnsPage: null` and `turnsBackwardsCursor` / `itemsBackwardsCursor`; with one
turn, whether a long session's reply holds only some of its turns was not seen. Koloft
takes `open` only from live frames, and seeds the file list from the reply's turns on
every bind, without counting them as live writes.

The same day, without a model, `codex sandbox -c 'sandbox_mode="workspace-write"'
/usr/bin/open nosuchscheme98765://x` (a scheme no app claims, so nothing could open)
failed with Launch Services error `-10661` (`kLSExecutableIncorrectFormat`), while the same
line outside the sandbox failed with `-10814` (`kLSApplicationNotFoundErr`).

**Inside the sandbox, `open` of a file that exists fails too, so nothing opens on the
Mac.** Checked 2026-09-25 with codex-cli 0.153.4 on macOS 27.0, three ways: `codex
sandbox -c 'sandbox_mode="workspace-write"' /usr/bin/open report.txt` (a plain text file
in the folder), the same under `read-only`, and one real model turn (`thread/start` with
`sandbox: "workspace-write"`, `approvalPolicy: "never"`) whose `open ./report.txt`
`commandExecution` item completed with `status: "failed"`, `exitCode: 1` and the same
`-10661` message in `aggregatedOutput`. No app opened. So under `read-only` and
`workspace-write` the system `open` never shows anything, and Koloft's own open (from the
frame or from the shim below) is the only one the person sees. Under
`danger-full-access` there is no sandbox and `open` behaves as it does in any shell:
**inferred, not checked** (running it would have opened an app on this Mac).

**Which `open` the model's shell picks.** The item's `command` is `/bin/zsh -lc '…'`,
a login shell, so the `path_helper` PATH order and the `ZDOTDIR` wrapper in `PLATFORM§2`
apply to it. Checked 2026-09-25 in a real turn: a shim folder put first in the
app-server's `PATH` lost to `/usr/bin/open`, and with the wrapper's `ZDOTDIR` in the
app-server environment the turn found the shim, with the user's own `PATH` additions
kept. The app-server hands `PATH` and `ZDOTDIR` from its own environment to the turn's
shell unchanged (both showed up in `echo "$PATH"` and in the shim's log). The shim ran
(`status: "completed"`, `exitCode: 0`) and could write under the turn's folder and under
`/tmp` but not under `~/Library/Application Support` (`Operation not permitted`). Under
`read-only` the shim could write nowhere, in the folder or `/tmp`. Not probed yet: a
user whose login shell is not zsh (for bash or fish `ZDOTDIR` means nothing,
**inferred, not checked**).

So Koloft handles an `open` three ways. Under `workspace-write` and `danger-full-access`
its own shim (put first through `ZDOTDIR`) writes the request into `/tmp`, never runs the
system `open`, and prints `koloft-open:sent`, and Koloft then skips that item's frame
(the shim under `danger-full-access` was not run: **inferred, not checked**). Under
`read-only` the shim can write nowhere, prints `koloft-open:blocked`, and Koloft opens the
file from the `item/completed` frame. A shell that is not zsh never reaches the shim, so
its item has neither line and Koloft opens from the frame too.

**Where a command may write, by sandbox.** Checked 2026-10-08 with codex-cli 0.159.3, one
real model turn each through `codex exec --ephemeral --ignore-user-config -C <folder>
-s <mode>`, running a script that wrote into a `/tmp/koloft-cx-open-*` folder, into
a folder outside `/tmp` that was not `-C`, and into the `-C` folder:

| `-s` | `/tmp` folder | other folder | `-C` folder |
| --- | --- | --- | --- |
| `read-only` | refused | refused | refused |
| `workspace-write` | written | refused | written |

A refused write failed with `Operation not permitted`. On 0.159.3, `codex sandbox -C
<dir>` stops with "the following required arguments were not provided:
--permission-profile <NAME>", and `-P read-only` with "default_permissions requires a
`[permissions]` table", so the no-model route used on 2026-09-25 no longer takes a
folder.

**`workspace-write` has no network; reading files outside it works.** Checked 2026-10-09
with codex-cli 0.159.3, one real turn through `codex exec -s workspace-write
--skip-git-repo-check -C <scratch folder>` (approval `never`), this Mac's own config:
`gh pr view 389 --repo superkoh/koloft --json state,mergedAt` exited 1 with "error
connecting to api.github.com", and `git -C <a repo outside the folder> log -1 --oneline`
printed the commit. Through the app-server (`thread/start` with the same sandbox), as a
conductor runs: **inferred, not checked**.

Browser control (an agent driving a Workbench web tab through Koloft's CDP (Chrome DevTools
Protocol) relay) was not tried for Codex. Whether a command inside Codex's sandbox can
reach the relay's local socket at all is **inferred, not checked** either way, so browser
control stays pending for Codex.

## 13. Token counts and the price table

**Token counts checked on 2026-09-24 with standalone Codex CLI 0.153.4**, reading the
`thread/tokenUsage/updated` frames saved from section 12's real model turn (model
`gpt-6-astra`, `modelContextWindow: 258400`).

- Each frame carries `total` and `last`, each with `inputTokens`, `cachedInputTokens`,
  `cacheWriteInputTokens` (0 in every frame), `outputTokens`, `reasoningOutputTokens` and
  `totalTokens`.
- In every frame `totalTokens = inputTokens + outputTokens` (for example 13535 = 13480 +
  55), with `cachedInputTokens` (11136) left out of the sum. So the cached tokens are a
  **part of** `inputTokens`, not extra to it. Koloft prices `inputTokens −
  cachedInputTokens` at the input price and the cached part at the cached price.
- `reasoningOutputTokens` was 0 in every frame, so whether it is a part of
  `outputTokens` (the way OpenAI's API counts it) is **inferred, not checked**. Koloft
  does not add it on top.

**Price table.** Read on 2026-09-24 from OpenAI's pricing page
(`developers.openai.com/api/docs/pricing`, reached from `platform.openai.com/docs/pricing`,
through a web fetch that summarized the page), standard tier, US dollars per million
tokens (input / cached input / output): `gpt-6-astra` 10 / 1 / 50, `gpt-6-sol` 2 / 0.2 /
10, `gpt-6-luna` 0.1 / 0.01 / 0.5, `gpt-5.6-sol` 4 / 0.4 / 20, `gpt-5.6-terra` 2 / 0.2 /
12, `gpt-5.6-luna` 0.2 / 0.02 / 1.2, `gpt-5.5` 5 / 0.5 / 30, `gpt-5.4` 2.5 / 0.25 / 15,
`gpt-5.3-codex` 1.75 / 0.175 / 14, `gpt-5.2` 1.75 / 0.175 / 14, `gpt-5.1` 1.25 / 0.125 /
10, `gpt-5` 1.25 / 0.125 / 10. OpenAI charges nothing to write the cache. The page lists
a higher "long context" price for prompts above 272K tokens; Codex's window on this Mac
(258400 on the wire, 272000 in `~/.codex/models_cache.json`) stays below it, so only
the short-context price is used. The model ids match the `slug`s in
`~/.codex/models_cache.json` on the same day. A ChatGPT plan login is not billed per token:
this cost is what the same tokens would cost on the API, not what the person pays.

## 14. A launch that starts with a task, a model and a thinking level

**Checked on 2026-09-24 with standalone Codex CLI 0.153.4 (`codex-cli 0.153.4`), no real
model.** `codex app-server --listen unix://<dir>/rpc.sock` ran with an isolated
`CODEX_HOME` whose `config.toml` pointed the model provider at a small local HTTP server
that saved every request body. The real TUI ran in a Python PTY (120×40, answering its
terminal queries) as `codex --remote unix://<dir>/rpc.sock -C <repo> -m probe-model-x -c
model_reasoning_effort="high" -a never -s danger-full-access "KOLOFT_FIRST_PROMPT_PROBE
say hi"`, in a fresh Git repository, for 15 seconds, pressing no key.

- With a `[projects."<repo>"]` `trust_level = "trusted"` table, the TUI sent the last
  argument as the first turn with no key pressed: the provider got a `/v1/responses`
  request whose `input` held the prompt text, `model: "probe-model-x"` and
  `reasoning: {effort: "high", …}`. A second request (a title thread, section 2) had the
  same model and no effort.
- Without that table, the same line showed "Do you trust the contents of this
  directory?" and sent **nothing** to the provider in 15 seconds: `-a never -s
  danger-full-access` does not skip the trust question. A scheduled run into a folder
  Codex never trusted waits there until Koloft's start deadline.
- `app-server --listen unix:///tmp/…` refused to start with "socket directory path exists
  and is not a directory: /tmp" (on macOS `/tmp` is a link to `/private/tmp`); a folder
  under `/private/tmp` worked.

The same run with the last argument `/daily-report KOLOFT_FIRST_PROMPT_PROBE` (a slash
word that is not a Codex command) also sent that text as the first turn, so a skill
name typed as a scheduled task reaches the model as plain text. Only `high` was tried; that `low`, `medium`, `xhigh` and `max` reach the wire the same
way is **inferred, not checked** (`~/.codex/models_cache.json` lists them, plus
`ultra`, as `supported_reasoning_levels` for `gpt-6-astra`). Codex has no flag that
names the session, so a scheduled Codex run gets its title from Codex itself.

## 15. One login per CODEX_HOME, and its rate limits

**Checked on 2026-09-24 with standalone Codex CLI 0.153.4 (`codex-cli 0.153.4`), no model
turn.** A Node script ran `codex app-server` on stdio twice, each time with its own
temporary `CODEX_HOME`: one empty, one holding only a copy of this Mac's `auth.json`
(a ChatGPT Pro login; deleted after the run) and a `config.toml` turning off apps and
plugins. Each run sent `initialize`, `initialized`, `account/read` and
`account/rateLimits/read`. Email and account ids were redacted before anything was saved.

- Empty home: `account/read` answered `{account: null, requiresOpenaiAuth: true}`;
  `account/rateLimits/read` answered error `-32600`, "codex account authentication
  required to read rate limits". `codex login status` printed "Not logged in" and exited 1.
- Home with the login: `account/read` answered `{account: {type: "chatgpt", email, planType:
  "pro"}, requiresOpenaiAuth: true}`; `codex login status` exited 0. `rateLimits` held
  `limitId: "codex"`, `primary: {usedPercent: 85, windowDurationMins: 10080, resetsAt:
  <epoch seconds>}`, `secondary: null`, `credits`, `planType: "pro"` and
  `rateLimitReachedType: null`. So this plan showed **one weekly window and no 5-hour
  window**; Koloft labels each window from `windowDurationMins`, never by position.
  `rateLimitsByLimitId` also held a second bucket, `base_model_inference` ("gpt-reserve",
  0%), which Koloft does not show.
- Section 12's live turn also sent `account/rateLimits/updated` notifications with the
  same `rateLimits` shape while the turn ran.
- Just starting an app-server wrote `state_5.sqlite`, `logs_2.sqlite`, `goals_1.sqlite`,
  `memories_1.sqlite`, `queue_1.sqlite`, `installation_id`, `skills` and `tmp` into the
  empty home: each home keeps its own state. Section 12's thread `path` lay under
  `<CODEX_HOME>/sessions/…`, so a session lives in the home it was started in, and only
  an app-server on that home can list, read or resume it.

**A shared config.toml.** Same day and version, no model: a home whose `config.toml` was
a symbolic link to a file elsewhere answered `config/read` with the model set in that
file. In the real TUI (Python PTY, section 11's setup) in a folder with no trust table,
pressing Enter on "Yes, continue" wrote the folder's trust table **into the linked file**
and left `config.toml` a link. So linked homes share folder trust. Only the trust answer
was seen going through the link; that every other save Codex makes to `config.toml` keeps
the link too (and so keeps settings shared) is **inferred, not checked**. Koloft's own
trust writer replaces the file it is given with a new one, so Koloft hands it the shared
file, never an account home's link.

**Who first writes a home's config.toml.** Checked 2026-10-04 with Codex CLI 0.159.3, no
model turn, each run in a fresh temporary `CODEX_HOME` and `HOME`, signed in with a dummy
API key. `codex login status`, `codex login --with-api-key` and a `codex app-server` that
answered `initialize`, `account/read` and `config/read` left the home with no
`config.toml`. The full-screen `codex`, started in a folder with no trust table, wrote
one **as it started**, before the trust question was answered (`[tui]
screen_reader_detection_done = true` and a `[tui.model_availability_nux]` table), and
added the folder's trust table to it on Enter. So a home that is not linked before its
first Codex start gets a file of its own and never shares settings or trust after that.
With `config.toml` a link to an empty shared file, the same start-up write and the trust
answer both went into the shared file and the link stayed a link. Hence Koloft makes an
empty shared file when there is none, rather than skip the link.

**A home finds a session by the file under its own `sessions/`, wherever that folder
really is.** Checked 2026-10-08 with Codex CLI 0.162.0, no model turn, no login in any
home. A Node script ran `codex app-server` on three throwaway `CODEX_HOME`s and sent
`thread/list`, `thread/read` and `thread/resume` for one real interactive (`source:
"vscode"`) rollout copied from this Mac's `~/.codex/sessions/YYYY/MM/DD/` (copies deleted
afterwards):

| home | listed | `thread/read` | `thread/resume` |
|---|---|---|---|
| empty | no | `-32600` "thread not loaded" | `-32600` "no rollout found for thread id" |
| rollout copied under `sessions/` | yes | ok | ok |
| `sessions/` a symlink to a folder holding it | yes | ok | ok |

A home whose `state_5.sqlite` had already been built from its own `sessions/`, with that
folder then swapped for a link to a shared one holding another rollout, listed both. So
Koloft links every account home's `sessions/` and `archived_sessions/` to the default
home's, lists history once from the default home, and resumes a session in whichever
account the picker chooses. A `codex exec` rollout (`source: "exec"`) is not in the
default listing, which asks for interactive sources only.

**A session started on one login takes a model turn on another.** Checked 2026-10-09
with Codex CLI 0.162.0 and two real ChatGPT logins (one Plus, one Pro, different
emails), each signed in with `codex login --device-auth` into its own throwaway
`CODEX_HOME`, whose `sessions/`, `archived_sessions/` and `config.toml` were links into
a third throwaway default home. Login A's app-server ran `thread/start` and one
`gpt-6-luna` turn ("Reply with exactly: ONE" → "ONE"). Login B's app-server then ran
`thread/resume` on that id (ok, the rollout path inside the shared folder) and a turn
asking what it had replied before: it answered "ONE … TWO" and `turn/completed` with
status `completed` — the earlier turns carried over, and the rollout's
`creator_account_id` did not stop it. The shared folder still held one rollout. Both
plans' `model/list` included `gpt-6-luna`.

**The Assist one-shot runs in such a home.** Same day and setup, login B's home:
`codex exec --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules -s
read-only -m gpt-6-luna -C /tmp -` with the system text and task on stdin exited 0 in
about 2 s, printed only the title on stdout, reported 2,538 tokens on stderr, and wrote
no rollout into the shared `sessions/`.

Not tried, because they need a second real login or would open a browser on this Mac:
- that `codex login` with `CODEX_HOME` set signs in only that home and exits 0 once
  done (Koloft types `codex login && exit` into the sign-in terminal, so the tab closes
  only on exit 0) — **inferred, not checked**;
- that two homes with two different logins each use their own login, so moving new
  sessions between homes spreads use across the two accounts — **inferred, not checked**.

## 16. Codex on a remote machine

**Checked on 2026-09-24.** On the Mac: standalone Codex CLI 0.153.4 (`codex-cli 0.153.4`).
On the machine: an Ubuntu 24.04 x86_64 server reached with `ssh -o BatchMode=yes` (bash,
tmux, no node, no Codex, no Codex login). For the probe only, the official
`@openai/codex@0.153.4-linux-x64` npm package was unpacked into a new folder in the
machine's home (its `codex` and `rg`, not its bundled `bwrap`), run with a new empty
`CODEX_HOME` beside it, and the folder was deleted afterwards. No login or key was
copied to the machine.

What was tried is the "Codex runs on the machine, its screen runs on the Mac" shape: a
small Node probe relay on the Mac built like Koloft's (section 1), whose app-server was
`ssh -T <machine> 'cd <folder> && CODEX_HOME=<home> exec <codex> app-server --stdio'`.

- A Node script sent `initialize`, `initialized`, `account/read` and `thread/list` down
  that ssh line. All answered: `initialize` after about 4.4 seconds (ssh connect plus
  Codex start) with `platformOs: "linux"` and the machine's `codexHome`; `account/read`
  gave `{account: null, requiresOpenaiAuth: true}`; `thread/list` gave an empty `data`.
  Closing stdin ended the remote app-server (exit 0) in about 0.2 seconds, and `ps` on
  the machine showed nothing left over. Koloft's own `CodexProcess.stop()` ends stdin
  first too, but then at once sends SIGTERM to the processes it owns on the Mac — here
  the ssh client — and that path was not run against ssh; that the remote app-server
  still ends cleanly when the ssh client is killed is **inferred, not checked**. The app-server also sent a `configWarning` that
  bubblewrap was not on the machine's `PATH` and that it would use its bundled one. This
  probe did not unpack the package's `codex-resources/bwrap`, so there was none; a real
  launch must put that file on the machine or install `bubblewrap` there, and that the
  bundled one works on Ubuntu is **inferred, not checked**.
- The real TUI ran on the Mac in a Python PTY (120×40) as `codex -c
  check_for_update_on_startup=false --remote unix://<relay socket> -C <folder on the
  machine>`. That folder does not exist on the Mac, and the TUI still connected: it sent
  `config/read` with `cwd: <folder on the machine>` (its trust check) and
  `account/read`, and showed its sign-in screen. Before that answer came, its start card
  showed the Mac folder the TUI process was started in. With a folder missing on the Mac
  and no socket at all, it failed only with "failed to connect to remote app server".
  Closing the TUI closed the relay's connection and the remote app-server ended.
- Sign-in from that screen did not work on this machine. "Sign in with Device Code" sent
  `account/login/start {type: "chatgptDeviceCode"}` to the machine, which answered
  error `-32603`, "device code request failed with status 403 Forbidden". A plain `curl`
  to `https://auth.openai.com/` from the machine also got 403, so OpenAI refuses that
  machine, not Codex; that the cause is the machine's network or region is **inferred,
  not checked**. "Sign in with ChatGPT" answered
  an `authUrl` whose `redirect_uri` is `http://localhost:1455/…` — the machine's own
  localhost, which a browser on the Mac does not reach.

Not tried, and why:
- **A real model turn over ssh.** The machine has no login and this probe copied none, so
  no turn, tool call, approval or file edit ran on the machine. That turn frames look the
  same as section 12's when they cross ssh is **inferred, not checked**.
- **Signing in on a machine OpenAI does not refuse.** That `codex login --device-auth`
  (the flag is in `codex login --help` on 0.153.4) signs the machine in from an
  `ssh -t` terminal is **inferred, not checked**.
- **"Codex and its screen both on the machine"** (a relay that runs on the machine next
  to a TUI in tmux) needs a relay and node shipped to the machine; it was not built or
  run. `codex app-server --help` lists `--listen unix://PATH` and `app-server proxy
  --sock <SOCKET_PATH>` ("proxy stdio bytes to the running app-server control socket"),
  so an app-server that outlives one ssh line may not need Koloft's own relay there —
  **inferred, not checked** (only the help text was read).

So Koloft keeps Codex on a remote machine refused: the part that runs (transport, the
remote folder, stop) is checked, but no one has yet signed in and run a turn there.

## 17. Handing a session context and a command, and queuing a message into it

**Checked on 2026-09-26 with standalone Codex CLI 0.153.4, real model turns
(`gpt-5.6-luna`, low effort).** A Node client drove `codex app-server --stdio`, and a real
TUI connected with `--remote` for the lines that name it. Each run used its own
`CODEX_HOME` holding a copy of this Mac's login (deleted afterwards), `apps` and
`plugins` off, and a trust table for the folder.

- **`-c developer_instructions="…"` on the app-server command line reaches the model**:
  it said back a word that only that text held. It still did with a real TUI connected
  through `--remote` to that app-server. The TUI's own `thread/start` did not override it.
  The line lands at the top of the thread's developer message. That it replaces a
  `developer_instructions` in the user's `config.toml` rather than adding to it is
  inferred, not checked.
- **The developer instructions are saved with the thread and outlive a resume without
  them**, and **Codex names a thread from its first message, instructions left out.**
  Checked on 2026-10-07 with Codex CLI 0.159.3 and a real model: an app-server started
  with `-c developer_instructions=` naming a made-up parent session answered that name;
  the rollout file held the text; a second app-server started without the flag
  `thread/resume`d the thread and still answered the name. In a real TUI started by
  `koloft session new` with Koloft's handover note written before the task in the first
  message, Codex named the thread "Acknowledge session handoff" — a name drawn from the
  note, not the task (`agent-tools-real-smoke.spec.ts`). That the title thread never
  reads the developer instructions is inferred, not checked, beyond that spec passing.
- **Skills:** a folder under `$CODEX_HOME/skills/<n>/SKILL.md` was listed by
  `skills/list` (scope `user`) and used by the model. `-c 'skills.config=[{path=…}]'`
  with a path to a folder, or to a `SKILL.md`, outside those roots added nothing to
  `skills/list`.
- **Hooks:** `-c 'hooks.SessionStart=[{hooks=[{type="command",command=…}]}]'` shows in
  `hooks/list` with source `sessionFlags` and `trustStatus: "untrusted"`, and does not
  run. `-c 'hooks.state."<key>".trusted_hash=…'` did not change that. The same
  `[hooks.state."<key>"] trusted_hash = "<currentHash>"` table written into the home's
  `config.toml` made it `trusted`, and then its `additionalContext` reached the model.
- **A command put first on PATH through `ZDOTDIR` (section 12) ran without an approval
  request** under `approvalPolicy: "on-request"`, `sandbox: "workspace-write"`, and
  could write under `/tmp`.
- **`codex queue --thread <id> --message …`** put a message into a plain `codex` TUI
  session that was already running. The TUI showed it as a user message and answered
  it.
- **`thread/queue/add` sent by a client other than the TUI starts a turn on an idle
  thread.** A relay shaped like Koloft's (one TUI over `--remote`, one stdio app-server
  upstream) sent `{id:"koloft-…", method:"thread/queue/add",
  params:{threadId, clientUserMessageId, input:[{type:"text", text, text_elements:[]}]}}`
  upstream after the TUI's first turn ended. The reply held `queuedSubmission`. The
  server sent `thread/queue/changed` twice, then `turn/started` and `turn/completed` on
  its own, with no `thread/queue/start`. The TUI drew both the message and the answer.
  The method appears only in the `--experimental` schema.
- **The TUI opens a second, ephemeral thread** (`thread/start` with id
  `temporary-structured-…`) to write a title. `thread/queue/add` on it is refused:
  "ephemeral thread does not support queued submissions".
- **`thread/queue/add` sent while a turn is running waits for that turn to end, then
  starts its own turn.** Checked on 2026-10-03 with Codex CLI 0.159.3 and a real model
  (`gpt-6.1-sol`): a Node client drove `codex app-server --stdio` with its own
  `CODEX_HOME` (a copy of this Mac's login, deleted afterwards), ran `thread/start` with
  `approvalPolicy: "never"`, `sandbox: "read-only"`, and started a turn that ran
  `sleep 20`. 3 s after `turn/started` it sent `thread/queue/add` with
  `clientUserMessageId: "koloft-conductor-1"`. The reply came back within about 8 ms:
  `{queuedSubmission: {id, input, clientUserMessageId}}`. `thread/queue/changed` (params
  only `{threadId}`) fired then and again mid-turn. The running turn finished its
  command and its own answer with no extra `userMessage` in it. About 25 ms after its
  `turn/completed` the server sent `turn/started` for a new turn by itself, with no client
  `turn/start`; that turn's first item was the queued `userMessage` with
  `clientId: "koloft-conductor-1"`, and the model answered it there. Thread status went
  `idle`, then `active` (`activeFlags: []`) between the two turns. On an idle thread the
  same call started a turn at once.

## 18. Which command lines open the full-screen TUI

**Read on 2026-09-27 from `codex --help` and each subcommand's `--help`, standalone Codex
CLI 0.153.4.** Koloft's Workbench terminal uses this to tell a command that opens
Codex's own full-screen screen from one that prints and exits.

- **Bare `codex`, or `codex <prompt>`, opens the TUI** ("If no subcommand is specified,
  options will be forwarded to the interactive CLI").
- **Subcommands that open it too:** `resume` and `fork` (a picker by default),
  `agents` ("Browse all agent sessions"; it takes `--no-alt-screen`, a TUI flag), and
  bare `cloud` ("Browse tasks"). `cloud exec | status | list | apply | diff` print and
  exit (`cloud exec`: "without launching the TUI").
- **Subcommands that print or run and exit:** `exec` (alias `e`, "Run Codex
  non-interactively"), `review` ("non-interactively"), `login`, `logout`, `mcp`, `plugin`,
  `mcp-server`, `app-server`, `remote-control`, `app` (opens the Desktop app),
  `completion`, `update`, `doctor`, `sandbox`, `debug`, `apply` (alias `a`), `queue`,
  `archive`, `delete`, `migrate-rollouts`, `unarchive`, `exec-server`, `features`,
  `help`; also `-h`/`--help` and `-V`/`--version` anywhere.
- **Top-level options that take a value** (so the word after them is not a
  subcommand): `-c/--config`, `--enable`, `--disable`, `--remote`,
  `--remote-auth-token-env`, `-i/--image`, `-m/--model`, `--local-provider`,
  `-p/--profile`, `-s/--sandbox`, `-C/--cd`, `--add-dir`, `-a/--ask-for-approval`.
  `-i/--image` takes one or more files; only the first is skipped, so
  `codex -i a.png b.png` reads as a prompt, which opens the TUI anyway.
- That `login` opens no full-screen screen is read off its help text ("Manage login"),
  not checked by running it.

## 19. What a turn said, live and read back

**Checked on 2026-10-03 with Codex CLI 0.159.3, real model turns (`gpt-6.1-sol`).** A Node
client drove `codex app-server --stdio` with its own `CODEX_HOME` (a copy of this Mac's
login, deleted afterwards; `check_for_update_on_startup = false`; the work folder trusted),
`thread/start` with `approvalPolicy: "never"`, `sandbox: "read-only"`. Turn 1 asked for one
sentence, then `ls`, then `DONE`; turn 2 was sent with `thread/queue/add`.

- **Every message lands as an `item/completed` on the thread, before `turn/completed`.**
  The owner's text: `{type:"userMessage", id, clientId, content:[{type:"text", text,
  text_elements:[]}]}`. The model's text: `{type:"agentMessage", id, text, phase, …}`.
  `item/started` for an `agentMessage` carries `text: ""`; only `item/completed` holds the
  words.
- **A turn that runs a tool has more than one `agentMessage`.** Turn 1 gave two, in order:
  `phase: "commentary"` ("I’ll list the files in this folder.") before the
  `commandExecution` item, and `phase: "final_answer"` ("DONE\nhello.txt") after it. A turn
  with no tool gave one `final_answer`.
- **`turn/completed`'s `turn.items` is a summary** (`itemsView: "summary"`) holding only
  the `final_answer` message, not the commentary nor the user message.
- **`clientId` on a `userMessage` is the `clientUserMessageId` given to
  `thread/queue/add`** (`"koloft-probe-1"`); a message typed in the turn's own
  `turn/start` has `clientId: null`.
- **`thread/read` with `includeTurns: true` returns `thread.turns[]`**, each `{id, items,
  itemsView: "full", status, startedAt, completedAt, durationMs}`, the items in the order
  the live frames came, with the same shapes (`commandExecution` also carries
  `aggregatedOutput` here). The same call to a second, fresh `codex app-server` (nothing
  loaded, `status: {type:"notLoaded"}`) returned the same turns and items.
- **It is deprecated.** Both reads were preceded by a `deprecationNotice` notification:
  "Full-history hydration is deprecated for paginated threads; omit `includeTurns` or set
  it to `false`, then page with `thread/turns/list` and `thread/items/list`." (the thread
  said `historyMode: "paginated"`). Those two methods are not on the list `CodexRpc` lets
  through; if a later Codex drops `includeTurns`, reading a closed Codex session breaks
  there first.
- **A Plan-mode turn writes no plan file; the plan is a `plan` item** `{type, id, text}`
  on `item/completed`, streamed before that by `item/plan/delta` (72 deltas adding up to
  the same 362 characters). It is not `turn/plan/updated`, which is `update_plan`'s step
  list. The saved rollout holds the plan twice: an `item_completed` event whose
  `item.text` is the plan, and the final assistant message, which wraps it in
  `<proposed_plan>` tags. Checked 2026-10-03 with Codex 0.159.3: one `turn/start` with
  `collaborationMode: {mode: "plan", …}` in a fresh `CODEX_HOME`, in a folder holding
  only `README.md`; `collaborationMode/list` answered `Plan` and `Default`.
- That the TUI's ephemeral title thread (section 17, its own `temporary-structured-…` id)
  never sends items under the session's thread id is inferred from section 17, not
  re-run here: no TUI was attached in this probe.

## 20. A question the model asks, and an MCP server's form

**Checked on 2026-10-04 with standalone Codex CLI 0.159.3, real model turns
(`gpt-6.1-sol`).** Each run used its own `CODEX_HOME` (a copy of this Mac's login,
deleted afterwards; `apps` and `plugins` off; the work folder trusted). First a Node
client drove `codex app-server --stdio` (`initialize` with `experimentalApi: true`,
`thread/start` with `approvalPolicy: "on-request"`, `sandbox: "read-only"`). Then the
real TUI ran in a Python pty at 120×40 with `--remote` to a Node relay shaped like
Koloft's (one TUI connection, one stdio app-server upstream, every frame logged).

- **`item/tool/requestUserInput` comes only in Plan mode.** In the default mode the
  same prompt ("use your request_user_input tool to ask me …") made the app-server log
  `request_user_input is unavailable in Default mode`, and the model asked in plain
  text. A `turn/start` carrying `collaborationMode: {mode: "plan", settings: {model,
  reasoning_effort, developer_instructions}}`, or `/plan` typed in the TUI (it sent
  `thread/settings/update` with a `collaborationMode`), raised it. The feature flag
  `default_mode_request_user_input` (under development, off) was not tried.
- **A turn started by `thread/queue/add` keeps the Plan mode `/plan` set.** Checked on
  2026-10-05 with Codex CLI 0.159.3 through Koloft itself (`discord-real-smoke`'s Codex
  conductor case): a real TUI connected over `--remote` to Koloft's relay, `/plan` typed
  in it after its first turn, then an owner message sent by Koloft with
  `thread/queue/add`. That queued turn raised `item/tool/requestUserInput`; a digit sent
  to the TUI answered it and the turn went on with the picked option.
- **Its shape:** `{id: 0, method: "item/tool/requestUserInput", params: {threadId,
  turnId, itemId: "call_…", questions: [{id: "colour", header: "Colour", question:
  "Which colour do you prefer?", isOther: true, isSecret: false, options: [{label:
  "Red", description: "Choose red."}, {label: "Green", description: "Choose
  green."}]}], isBlocking: true, autoResolutionMs: null}}`. Just before it,
  `thread/status/changed` went `active` with `activeFlags: ["waitingOnUserInput"]`.
- **Its answer:** `{id: 0, result: {answers: {colour: {answers: ["Green"]}}}}`. The
  server then sent `serverRequest/resolved` `{threadId, requestId: 0}`, the flag
  cleared, and the turn went on to its answer ("Green").
- **The TUI draws it as "Question 1/1"** with the options as `1.`…`N.` and `N+1. None of
  the above` (with `isOther`), "tab to add notes", "enter to submit answer". **A digit
  picks that option and sends it at once**: `2` sent exactly the answer above, and the
  history then read "Questions 1/1 answered … answer: Green".
- **An answer sent upstream by the relay, not by the TUI, is a trap.** In two runs the
  relay wrote the answer above to the app-server 8 s after the request, and dropped
  nothing (the TUI never sent one of its own). The server took it, sent
  `serverRequest/resolved`, and the turn finished; the TUI took the question off the
  screen and drew the answer. But a line typed into the TUI 3 s after `turn/completed`
  (text, then CR 0.5 s later) never reached the app-server and was not drawn, over 35 s
  of waiting, in both runs. The same line after a digit answer started a turn at once.
  Not tried: Esc or other keys after such an answer. So Koloft answers by the digit.
- **`mcpServer/elicitation/request`** came from a stdio MCP server listed in
  `config.toml` whose tool, when called, sent MCP `elicitation/create` with
  `{message: "Which colour do you prefer?", requestedSchema: {type: "object",
  properties: {colour: {type: "string", enum: ["Red", "Green"]}}, required:
  ["colour"]}}` (in the default mode; the tool had `readOnlyHint: true` and needed no
  approval). Codex passed it on as `{id: 0, method: "mcpServer/elicitation/request",
  params: {threadId, turnId, serverName: "probe", mode: "form", _meta: null, message,
  requestedSchema}}` with the same schema. The TUI drew "Field 1/1 (1 required
  unanswered)", the message, the field name and its enum as `1.`…`N.`, "enter to submit",
  "esc to cancel"; `2` sent `{id: 0, result: {action: "accept", content: {colour:
  "Green"}, _meta: null}}`, followed by `serverRequest/resolved`, and the MCP tool got
  `{action: "accept", content: {colour: "Green"}}`.
- Not probed: several questions in one request, a free-text answer (`N+1` and notes),
  `isSecret`, a form with several fields or a field that is not an enum, and an
  elicitation `mode` other than `form`. Koloft refuses those from Discord.

## 21. Slash commands typed into the TUI

**Checked on 2026-10-04 and 2026-10-05 with Codex CLI 0.159.3, real model turns
(`gpt-6.1-sol`, low effort).** A real TUI ran in a pty connected with `--remote` to a
Node relay in front of `codex app-server --stdio` (section 1), with its own `CODEX_HOME`
(a copy of this Mac's login, deleted afterwards), `approval_policy = "never"`, the work
folder trusted. Text was typed in one write and CR in a second write 0.3–0.6 s later.

- **Slash commands live only in the TUI.** No app-server method takes a slash command.
  A `thread/queue/add` with the text `/compact` reached the model as that text and
  compacted nothing; so did a typed `/model <name>` with an argument (a plain
  `turn/start`). `/stauts/comapct` (two slashes) was sent to the model too.
- **`/compact` typed while idle** sent `thread/compact/start {threadId}` (result `{}`),
  then the server ran a turn of its own: `turn/started`, a `contextCompaction` item
  started and completed, `turn/completed` (2.8–5.4 s), on the same thread id. No
  `thread/compacted` notification came. The relay sending `thread/compact/start` itself
  did the same, and the TUI drew it and kept working.
- **An automatic compaction stays inside the turn it interrupts** (2026-10-09, Codex CLI
  0.162.0, `codex app-server` on stdio driven by a Node script, a temporary `CODEX_HOME`
  with `model_auto_compact_token_limit = 30000`, one real turn of four `seq` commands):
  after the third command a `contextCompaction` item started and completed (10.6 s), the
  fourth command and the reply followed, and one `turn/completed` for the same turn id
  ended it. No other turn started and no user message was added.
- **`/new` and `/clear`** each sent `config/read`, `thread/start` (a new id), then
  `thread/unsubscribe` of the old thread. `/clear` adds `sessionStartSource: "clear"`.
  A `-c developer_instructions=…` given to the app-server still reached the model in the
  new thread (the TUI's own `thread/start` sends `developerInstructions: null`).
- **Typed while a turn runs, `/compact` is refused** ("'/compact' is disabled while a task
  is in progress"), the box is emptied, and nothing runs afterwards. `/compact` then Tab
  instead of CR queues it inside the TUI (nothing on the wire) and it runs right after
  the turn.
- **CR runs the popup's first entry**: `/co` + CR compacted. **Esc after typing closes
  the popup and keeps the text, and CR then runs exactly what was typed**: `/co`, Esc,
  CR showed "Unrecognized command '/co'" and sent nothing; `/compact`, Esc, CR and
  `/new`, Esc, CR ran those commands. A trailing space closes the popup too (`/co `
  + CR: Unrecognized). Esc and CR must be separate writes: `\x1b\r` in one write is read
  as Alt+Enter and adds a line; 30 ms apart works.
- **An unknown command** (`/comapct`, `/stauts`, with or without a trailing space) shows
  "Unrecognized command '…'" and sends nothing, and the text stays in the box with the
  cursor at its start. Esc leaves it there; Ctrl-E then Ctrl-U empties the box; Ctrl-U
  alone does not, and the next typed line is joined to the leftover.
- **Menus**: `/model` with no argument sends `model/list` and opens a picker; one Esc
  closes it with nothing changed. Text typed into the open picker is lost and its CR
  picks the highlighted row. `/mention` opens a picker that one Esc closes, leaving `@` in
  the box. `/diff` runs git through `command/exec` and opens a pager that Esc does not
  close and `q` does. `/status` shows its answer only on the screen (it only calls
  `account/rateLimits/read`).
- **Esc at an idle prompt**: one shows "esc again to edit previous message"; a second
  one opens "Browsing transcript", where Enter rewinds.
- **Queued messages and idle**: two `thread/queue/add` sent during a turn ran as two
  more turns, one each, right after it; between turns the thread status went `idle`
  and `active` again within 3–4 ms. Each queued `userMessage` item carried the
  `clientUserMessageId` as `clientId`, and `thread/queue/list` was empty as soon as the
  last one's turn started.

## 22. `codex update`

How established: 2026-10-08 on this Mac, each run in a fresh temporary `HOME` with
`CODEX_HOME` unset and stdin closed. A standalone install of 0.153.4
(`CODEX_RELEASE=0.153.4 CODEX_NON_INTERACTIVE=1 sh install.sh`, the script at
`https://chatgpt.com/codex/install.sh`), and an npm one
(`npm install -g @openai/codex@0.153.4` into a user-writable prefix).

- **`codex update` asks nothing and exits 0**, and picks the way to update from how
  Codex was installed: standalone runs
  `curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh`, npm
  runs `npm install -g @openai/codex`. Both went 0.153.4 → 0.161.0. The binary also
  names `brew upgrade --cask codex`, `bun`, `pnpm` and `vp` ways (read with `strings`);
  none was run.
- **The standalone install lives under `$CODEX_HOME/packages/standalone`** (install.sh
  reads `CODEX_HOME`, falling back to `~/.codex`), so the update must run with the
  user's own `CODEX_HOME`, never an account home (§15). `current` moves to
  `releases/0.161.0-…` and `releases/0.153.4-…` stays.

## 23. A bracketed paste lands in the composer unsent

How established: first from the issue #4 design round's probe notes (Codex CLI 0.159.3,
the real TUI in a pty, early October 2026; a second reader re-ran them then). Re-run on
2026-10-08 with Codex CLI 0.161.0 (a standalone install made by the official
`install.sh` with `CODEX_RELEASE=0.161.0` into a scratch `CODEX_HOME`; Koloft refuses
this Mac's 0.159.3 as older than its minimum) through Koloft's own ✎ comment: one write
of 8 lines with 7 LFs inside the markers, a 5 s wait, then one CR written to the tab.
Established by `agent-tools-real-smoke.spec.ts` › "a real Codex holds the hunk comment
in its composer unsent, and the next Enter sends path, diff fence, hunk and note as one
message" (3 runs).

- **The TUI turns bracketed paste on at startup** (it writes `ESC[?2004h`; 0.159.3
  notes).
- **A write wrapped in `ESC[200~` … `ESC[201~` lands in the composer and is not sent.**
  The 8 lines (about 140 characters) showed in the composer as text, line by line, but
  for the one empty line, which the composer did not draw; 5 s later the rollout held no
  user message: LF inside the markers sends nothing.
- **The next CR sends it as one user message**: the rollout
  (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`) gained one
  `event_msg` `item_completed` whose `item.type` is `UserMessage` and whose text is the
  pasted text exactly, with no wrapping. The model followed the one-word request in the
  paste in 3 of 3 runs.
- **Text typed right after the paste's `ESC[201~` joins it in the composer** and is sent
  with it as one `UserMessage`, unwrapped; the model replied the one word asked for in 8
  of 8 runs. A raw LF in that text adds a line and does not send, inside one write and
  as a lone LF written 0.3 s after the line before it. One raw write of 1,148
  characters showed as `[Pasted Content 1148 chars]` in the composer and was still sent
  whole and unwrapped; the same text in pieces of 128 characters 0.3 s apart showed as
  text. Measured 2026-10-08, Codex CLI 0.161.0 (the standalone install above), a python
  `pty` probe in a scratch `HOME` whose `CODEX_HOME` held only a copied `auth.json` and
  a `config.toml` trusting the folder; a CR 4 s after the note.
- **A longer bracketed paste shows as `[Pasted Content N chars]`** and still waits:
  Koloft's Send failing checks for superkoh/koloft PR #3 (43 line breaks, the npm
  ERESOLVE log; claude showed the same paste as `[Pasted text #1 +43 lines]`) showed as `[Pasted Content 1817 chars]`, the rollout held no user message 5 s
  later, and the question typed after it went with it as one unwrapped `UserMessage` on
  the next Enter, answered `ERESOLVE` in 5 of 5 runs (2026-10-08, Codex CLI 0.161.0;
  established by `agent-tools-real-smoke.spec.ts` › "a real Codex holds the failing
  checks of PR #3 in its composer unsent …").
- Codex on a remote machine is not a tab Koloft starts yet (§16), so the paste over ssh
  and tmux is not probed for Codex.

## 24. Searching the words of every thread

How established: 2026-10-09 on this Mac, Codex CLI 0.162.0. The schema from
`codex app-server generate-json-schema --experimental` (`v2/ThreadSearchParams.json`,
`ThreadSearchResponse.json`), then a Node client on `codex app-server --stdio` in a
scratch `CODEX_HOME` holding only a copied `auth.json` and a `config.toml` (update check
off, the work folder trusted), deleted afterwards. One real turn (`thread/start` with
`approvalPolicy: "never"`, `sandbox: "read-only"`) asked the model to reply with the
word made of "ban" and "jo", with the marker `zebrafinch42` in the prompt; it answered
`banjo`.

- **`thread/search` takes `{ searchTerm, cursor, limit, archived, sourceKinds, sortKey,
  sortDirection }`** (only `searchTerm` required; `sortKey` `created_at` by default,
  `sortDirection` `desc`) **and answers `{ data: [{ snippet, thread }], nextCursor,
  backwardsCursor }`**; `thread` has the shape `thread/list` returns, and the pages
  follow `nextCursor` the same way.
- **It matches what the person typed and what the model answered, in any case.**
  `zebrafinch42` (only in the prompt), `banjo` (only in the reply) and `ZEBRAFINCH42`
  each returned the thread; a word in neither returned `{data: [], nextCursor: null,
  backwardsCursor: null}`. Each call took about 6–8 ms on the one-thread home (150 ms
  for the first call right after the turn).
- **One hit per thread.** `ban`, in both the prompt and the reply, gave one hit, whose
  snippet came from the prompt.
- **The snippet is plain text with no match range**: `... ban" followed by "jo", and
  nothing else. Marker: zebrafinch42`, cut with `... ` at the front and ` ...` at the end,
  not centred on the match. Whoever shows the match finds the term in it again.
- **The thread's name is not searched.** After `thread/name/set` named it "Pelican title
  only", `pelican` returned nothing; so a search by title is the caller's own.
- **It also matches text Codex adds itself**: the term `e` hit inside the
  `<environment_context>` block Codex puts before the first turn.
- **`archived` picks one side**: the schema says `true` gives archived threads only and
  `false` or null the rest; `archived: true` with `banjo` returned nothing, the thread
  not being archived. That `false` hides an archived thread was not run. An empty
  `searchTerm` is refused with `-32600 "thread/search requires a non-empty searchTerm"`.
- Not probed: how long it takes on a home with thousands of threads (no real home was
  searched), and Codex on a remote machine (§16).

## 25. The keys the TUI takes

How established: 2026-10-09, Codex CLI 0.162.0, this Mac's own login, `codex --no-daemon`
in a python `pty` (100×40) in a fresh scratch folder, each key one write about 1 s after
the one before, the screen read back through `pyte`.

- **In the composer:** `abcd`, then `ESC[D` twice and `DEL` (0x7f) left `acd`; `ESC[C`,
  `X`, a space and `Y` made `acX Yd`. Left, Right and Backspace move and delete as
  typed.
- **`/mod` then Tab** completed to `/model`; CR opened the "Select Model and Effort"
  list.
- **In a list:** `ESC[B` moved the `›` mark down one entry, `ESC[A` back up; in the
  three-entry "Background server" prompt `ESC[B` from the last entry wrapped to the
  first. ESC closed the model list and left the composer empty.
- **Shift+Tab (`ESC[Z`)** at the empty composer switched the session to Plan mode ("Model
  changed to … for Plan mode").
- Not run: the same keys through ssh and tmux, since Koloft starts no remote Codex tab
  (§16).

