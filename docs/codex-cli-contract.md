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
