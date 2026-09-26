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
  config field in that binary's strings. Only the plain local start was checked; the
  `--remote` start was not (inferred, not checked, that it reads the same key).

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

Koloft's own stop, ownership and retry rules are product rules, covered by
`test/unit/codexTransport.test.ts`, not Codex facts.

## 6. Worktree boundary

**Measured without a model call.** In a temporary repository with a committed baseline,
Git created a linked worktree. The real TUI and app-server ran in that checkout using
`-C`. The returned thread cwd matched it. After native `/exit`, the checkout directory,
branch and HEAD were still present and unchanged.

## 7. Rechecking a CLI upgrade

Measured version: **0.153.4** only. Koloft treats every 0.153.x as verified (the
`verified` flag from `resolveCodexRuntime`); later 0.153 patches are inferred, not
checked. After rechecking a newer line, change that flag's rule in
`src/main/codexRuntime.ts` and this line together.

Repeat the real TUI operations in section 2, approval in section 3, both background cases
in section 4 and the shutdown case in section 5. Keep worktree tests inside a
temporary repository. Record version, executable source, matching request IDs, thread
IDs and event order; redact login/account contents. Fixture tests cannot replace these
external checks.

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
`CODEX_SESSION_ID`, `CODEX_THREAD_ID`, `CODEX_SHELL` and `CODEX_CI`.

Checked 2026-09-24 with `strings` on the standalone codex-cli 0.153.4 binary: it names
`CODEX_CI`, `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`, `CODEX_PERMISSION_PROFILE`,
`CODEX_SESSION_ID` and `CODEX_THREAD_ID`. It holds no literal
`CODEX_APP_TOOLS_PIPE_PATH`, `CODEX_MCP_NODE_PATH`,
`CODEX_SAGE_BACKFILL_TRACKER_TAB_REUSE` or `CODEX_SHELL`; that the CLI does not read
those four, and what sets them, is inferred, not checked.

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
  A table for the worktree path alone stopped it in the worktree.
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

Only one live turn was watched; `thread/resume` was not tried. Koloft takes a file list
and an `open` only from live `item/completed` frames and starts the list empty on every
bind. That `thread/resume` does not send the old turns' `item/completed` frames again (the
schema puts them in the reply's `thread.turns[].items` instead) is **inferred, not
checked**; if it did, a resumed session would open its old files again.

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
a login shell, so `path_helper` runs (`PLATFORM§2`). Checked 2026-09-25 in a real
turn: with a shim folder put first in the app-server's `PATH`, `command -v open` inside
the turn still printed `/usr/bin/open`; the shim folder had moved behind the `/etc/paths`
entries. With `ZDOTDIR` in the app-server environment pointing at a folder whose
`.zprofile` sources the user's own `~/.zprofile` and then puts the shim folder first
again, the same turn printed the shim's path, the shim ran (`status: "completed"`,
`exitCode: 0`), the user's own `PATH` additions were still there (`command -v codex`
found `~/.local/bin/codex`), and the shim could write under the turn's folder and under
`/tmp` but not under `~/Library/Application Support` (`Operation not permitted`). Under
`read-only` the shim could write nowhere, in the folder or `/tmp`. The app-server hands
`PATH` and `ZDOTDIR` from its own environment to the turn's shell unchanged (both showed
up in `echo "$PATH"` and in the shim's log). A user whose login shell is not zsh was not
tried: for bash or fish `ZDOTDIR` means nothing, **inferred, not checked**.

So Koloft handles an `open` three ways. Under `workspace-write` and `danger-full-access`
its own shim (put first through `ZDOTDIR`) writes the request into `/tmp`, never runs the
system `open`, and prints `koloft-open:sent`, and Koloft then skips that item's frame
(the shim under `danger-full-access` was not run: **inferred, not checked**). Under
`read-only` the shim can write nowhere, prints `koloft-open:blocked`, and Koloft opens the
file from the `item/completed` frame. A shell that is not zsh never reaches the shim, so
its item has neither line and Koloft opens from the frame too.

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
