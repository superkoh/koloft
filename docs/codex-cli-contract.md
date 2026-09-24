# Codex CLI contract ledger

Facts measured outside Koloft, and the limits of those measurements. These facts can
change when Codex changes. Koloft behavior belongs in its tests; this ledger does not
replace those tests or claim that every user configuration has been tested.

Sections 1–7 were checked on **2026-09-09**, on macOS arm64, using the independently
installed npm package **`@openai/codex@0.153.4`** (`codex-cli 0.153.4`), not the binary
bundled with the ChatGPT app. The relay probes used Node 24.13.0 and a Python PTY driver;
the TUI was never replaced with a custom chat interface.

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

Koloft's socket access checks, frame bounds, UTF-8 decoding and stop behavior are
covered in `test/unit/codexTransport.test.ts`; those are product rules, not Codex facts.

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
completed and were unsubscribed. They must not replace the foreground thread or make
its activity appear finished.

A fresh, empty session returned a non-null rollout `path` whose file **did not yet
exist**. A path in a start response does not prove that a session can already be
restored from disk. This was checked before submitting any prompt in the worktree probe.

**Archived history is not directly resumable.** A separate probe archived one of its
own persisted threads with `thread/archive`, then launched the real TUI with
`resume <that UUID>`. The TUI sent `thread/resume` and received error `-32600`, stating
that the session is archived and must first be unarchived with `codex unarchive`.
It did not automatically send `thread/unarchive`. Consequently, records returned by
`thread/list` with `archived:true` must not be offered as ordinary resumable history.
This observation does not authorize silently changing a user's archive state.

**Native input and resize were checked separately.** Sending first-line text, LF,
second-line text, then CR through the PTY produced one user `turn/start`; its text
contained the two lines separated by `\n`. This matches Koloft's LF for Shift+Enter
and CR for Enter. A `TIOCSWINSZ` change to 26 rows × 90 columns kept the TUI responsive,
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
custom model provider**. Koloft passes through native Codex configuration and login;
Claude permission and account settings are not Codex settings. Environment filtering
itself is verified by transport tests, not inferred from this experiment.

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
Command text, low CPU, an open terminal or `ThreadStatus.active` must not be presented
as proof of that distinction. A still-open command can be shown as background activity
with an unknown kind; it cannot alone prove that the agent is still reasoning.
This limit does not prevent tracking observed child activity.

## 5. Process exit and crash boundaries

These are distinct experiments and must not be merged into one shutdown guarantee.

| Experiment | Observed result |
| --- | --- |
| Normal TUI disconnect through Koloft transport | Dedicated app-server and a known tool child in a separate process group were stopped; tests verified both PIDs had gone |
| Simulated app-server killed with SIGKILL after spawning a detached tool | The original stop-time-only scan leaked the child; a regression test reproduced it. Runtime PID/start-time records now let stop find and terminate that observed child after reparenting |
| Real 0.153.4 app-server running streaming `command/exec`; its Node host killed with SIGKILL | The host's pipe closed. After 1.5 seconds, host, app-server and command PID were all gone without Koloft running a stop callback |

The last probe used standalone `command/exec` running `sleep 30`, not a model turn.
Its schema describes command processes as connection-scoped and says connection closure
terminates them. The result confirms that case; it does not establish the same behavior
for every detached shell daemon, MCP server or nested tool.

Koloft retains confirmed process identities while alive, checks identity again before
signaling and allows failed stops to be retried. Limits remain:

- A child created, detached and orphaned between process samples may never acquire a
  provable ownership record. Polling cannot eliminate that window.
- SIGKILL of Koloft itself prevents its cleanup code from running. Its in-memory
  ownership records do not survive; the EOF result above is narrower than a guarantee
  that every possible descendant is reclaimed.
- Failed process inspection or unconfirmed termination is a stop failure. Unrelated
  user daemons must not be killed to make a run appear stopped.

The hard-crash and retry regressions are in `test/unit/codexTransport.test.ts`.

## 6. Worktree boundary

**Measured without a model call.** In a temporary repository with a committed baseline,
Git created a linked worktree. The real TUI and app-server ran in that checkout using
`-C`. The returned thread cwd matched it. After native `/exit`, the checkout directory,
branch and HEAD were still present and unchanged.

This verifies use of an existing checkout. It does not claim Codex creates or rebuilds
Koloft worktrees, or provides Claude's Keep/Remove interaction. Koloft owns preparation
and recovery; its policy is to retain checkout, branch and recovery evidence when
ending a session. Those product rules are covered by the `sessionWorktrees`,
`sessionStore` and Codex session tests.

## 7. Rechecking a CLI upgrade

Verified version: **0.153.4–0.153.x**. Koloft runs any Codex CLI from 0.153.4 up, but
only 0.153.x has been through the checks below; anything newer starts a session and says
once that it is untested (`verified: false` from `resolveCodexRuntime`). After rechecking
a newer line, change that flag's rule in `src/main/codexRuntime.ts` and this line
together.

Repeat the real TUI operations in section 2, approval in section 3, both background cases
in section 4 and separate shutdown cases in section 5. Keep worktree tests inside a
temporary repository. Record version, executable source, matching request IDs, thread
IDs and event order; redact login/account contents. Fixture tests cannot replace these
external checks.

Initial local evidence lives under `/tmp/koloft-codex-cli-probe/run/`:
`native-evidence.json`, `background-evidence.json`, `eof-evidence.json` and
`worktree-evidence.json`, plus `input-archive-evidence.json`. These are temporary development artifacts without login tokens.
This ledger preserves the measured facts when those artifacts are removed.

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

Koloft's current Claude layout is defined in `src/main/statusline.ts`. Native Codex
can match some field meanings and their order, but not that three-line Powerline
layout. These probes do not establish a custom Koloft footer implementation.

## 9. Confirmation before remote resume

**Checked on 2026-09-10 with standalone Codex CLI 0.153.4.** A saved rollout was
copied into an isolated `CODEX_HOME` and resumed in the real Electron/xterm UI,
against a test provider on an unused localhost port. The native TUI displayed the
directory trust question before connecting to the remote app-server or binding a
thread. A resume-loading overlay therefore hides a required interaction, and a
connection deadline can expire while the user is deciding. These prompts must stay
visible and interactive. Waiting more than 15 seconds before confirming still
resumed the original thread and rendered its history with no connection deadline;
closing the owning PTY still tears down its unused server.

An earlier Koloft code note adds, with no measurement, date or version: a run waiting
on the native "resume this thread?" question has not opened a thread yet, so it
publishes no session entry for as long as the user takes to answer. It was not
re-measured, and the check above named the directory trust question, not this one.

## 10. Runtime markers from an enclosing app

**From an earlier Koloft code note; not measured.** These variables are set by the
app that encloses Codex, not by the user's own configuration of a new CLI:
`CODEX_APP_TOOLS_PIPE_PATH`, `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`,
`CODEX_MCP_NODE_PATH`, `CODEX_PERMISSION_PROFILE`,
`CODEX_SAGE_BACKFILL_TRACKER_TAB_REUSE`, `CODEX_SESSION_ID`, `CODEX_THREAD_ID`,
`CODEX_SHELL` and `CODEX_CI`. A child Codex that inherits them acts as part of the
enclosing run.

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
`--remote`; that a `config.toml` table also stops it there is **inferred, not checked**.

**Approval flags, read from `codex --help` on the same binary.** `-a/--ask-for-approval`
takes `on-request` or `never`; `-s/--sandbox` takes `read-only`, `workspace-write` or
`danger-full-access`. There is **no `--full-auto`**: `codex --remote ws://127.0.0.1:9
--full-auto` stopped with `error: unexpected argument '--full-auto' found`, while the
same line with `-a never -s danger-full-access` or `-a on-request -s workspace-write` got
past argument parsing (it then stopped at "stdin is not a terminal"). In section 3's
run, `-a on-request -s read-only` led to an approval request. That `never` /
`danger-full-access` and `workspace-write` take effect the same way was **not
exercised against a model — inferred, not checked**.
