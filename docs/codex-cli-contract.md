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
  thread is not probed yet. On 0.162.1 (2026-10-11, a Node client on a stdio
  app-server in a throwaway `CODEX_HOME`, no login): the result is `{data, nextCursor,
  backwardsCursor}` (the last key new), each item carries `id, sessionId, preview,
  source, status, path, cwd, cliVersion, originator, historyMode, model, name, turns,
  …` (32 keys, counted again on 0.162.1 and 0.163.0 on 2026-10-16: `id, environments,
  extra, sessionId, forkedFromId, parentThreadId, preview, ephemeral, section,
  sectionEnteredAt, projectId, historyMode, modelProvider, model, reasoningEffort,
  createdAt, updatedAt, recencyAt, status, path, cwd, cliVersion, originator, source,
  canAcceptDirectInput, threadSource, agentNickname, agentRole, gitInfo, name,
  daybreakEnabled, turns`; `status {type: "notLoaded"}`, `turns []`, `historyMode
  "paginated"`); a rollout the full-screen TUI wrote has `source: "vscode"`, one `codex
  exec` wrote has `source: "exec"` and is left out by that list; `initialize` now also
  brings a `remoteControl/status/changed` notification. **0.163.0 adds `readStates` to
  the `thread/list` result** (a map from thread id to `{firstUnread: {type: "turn",
  turnId}, revision}`; the result keys are `data, readStates, nextCursor,
  backwardsCursor`), a `thread/readState/changed` notification (`{threadId,
  readState}`) sent just before each `idle` status, the methods
  `thread/readState/update` and `thread/items/read` (strings), and a `thread/list`
  param `excludedThreadIds` (one real id drops that thread; more than 100 entries or a
  non-UUID is refused with `-32602`); 0.162.1 ignores that param without a word, so
  Koloft cannot lean on it below 0.163.0 (2026-10-16, a Node client on a stdio
  app-server in a throwaway `CODEX_HOME`).
- Request IDs are strings **or numbers, including zero**. Startup and temporary title
  requests used strings; the real command approval request used numeric `0`.
- **Each line starts with what kind of message it is** (0.162.0, 2026-10-17: a Node
  client and a real `codex --remote` TUI on a stdio app-server in a throwaway
  `CODEX_HOME` holding a copied `auth.json`). The app-server writes a reply as
  `{"id":…,"result":…}` or `{"id":…,"error":…}`, a notification as `{"method":…,
  "params":…}`, and a request to the client with `method` first:
  `{"method":"item/commandExecution/requestApproval","id":0,"params":…}`. A line it
  cannot read gets an error with no `id` at all (`{"error":{"code":-32600,…}}`). The
  TUI writes its requests as `{"id":…,"method":…,"params":…}` and `initialized` as
  `{"method":…}`, all on one line. Koloft reads only these first keys to decide whether
  a line is worth parsing, and parses any line that starts some other way.
- **A signed-in start brings very large replies.** The TUI asks `plugin/list` (ids
  `plugin-list-…`) with no prompt typed; each reply was 16.5 MB (the OpenAI curated
  marketplace), and three came within about 75 seconds. A home with no login gets
  `{"marketplaces":[],…}` (101 bytes). On 2026-10-29 (0.162.0, a ChatGPT-signed-in
  `CODEX_HOME` in the real-model e2e case where a reopened Codex Alfred gets a Claude
  helper's report, measured with a log in
  `createCodexTransport`) a TUI resuming a thread asked four times as it opened; each
  reply was 24,187,552 bytes and three reached Koloft within 60 ms, faster than the TUI
  took them off its socket, so more than 64 MB waited to be sent to it at once.
  0.166.0 has a feature flag `plugin_discovery_prefetch` (`stable`, on), turned off with
  `--disable plugin_discovery_prefetch` (its notes: "Allow disabling plugin discovery
  prefetch at app-server startup"; read from `codex features list`, 2026-10-30); whether
  turning it off stops the TUI's `plugin/list` asks was not run.
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

### No Monitor; a server left in a background terminal

**Measured 2026-10-28, codex-cli 0.162.0 (`~/.codex/packages/standalone/current/bin/codex`),
macOS, `codex app-server --stdio` driven by a Node script, a fresh `CODEX_HOME` whose model
was a fake Responses-API server on localhost, `sandbox_mode = "danger-full-access"`, no
login, 1 run.**

- `codex features list` has no Monitor-like feature, and section 32's tool list has no
  tool that wakes the model on a running command's output; a command that outlives its
  turn ends with `item/completed` and starts no turn. The thread's only way to wait is
  `clock.sleep` inside a turn (section 32).
- The fake model answered with one `exec_command {cmd: "python3 -m http.server 18799",
  yield_time_ms: 1000}`, then a message. The item was `/bin/zsh -lc 'python3 -m
  http.server 18799'`, `inProgress`, `processId` `"71962"`; the turn completed with it
  still `inProgress`. `ps` then showed the server as a direct child of the app-server
  pid, its command line the interpreter's own file (`…/Python.app/Contents/MacOS/Python
  -m http.server 18799`, as in MUSE§8).
- `thread/backgroundTerminals/list {threadId}` (an experimental method: it is in
  `codex app-server generate-json-schema --experimental` only, and `initialize` sent
  `capabilities.experimentalApi: true`) answered one entry `{itemId: "call_1", processId:
  "71962", command: "python3 -m http.server 18799", cwd, osPid: null, cpuPercent: null,
  rssKb: null}`: no OS PID on macOS.
- `thread/backgroundTerminals/clean {threadId}` answered `{}`, the item then completed
  `failed` with `exitCode: -1`, the process was gone and the list was empty. The binary's
  strings hold "thread/backgroundTerminals/clean failed in TUI", "/ps to view" and
  "/stop to close"; the TUI's `/ps` and `/stop` were not run.

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
the detached `codex app-server --stdio -c …` was re-parented to pid 1 and
exited on its own 13.7–13.9 s later. A relaunched Koloft that resumed the same thread
while it lived (1.1 s after the kill, two runs) got, within 0.4 s, "This conversation is
open in another app — Close it there and press R to continue here"; pressing `r` after
the old app-server had exited resumed in 0.2 s, and a resume ~20 s after the kill was
normal. With four app-servers resuming one thread at once, three showed the same lock.

**Every way a person quits the TUI exits 0**: `/exit`, `/quit`, Ctrl+C and Ctrl+D at an
empty composer (one press is enough; it prints the `codex resume <id>` line first).
Measured 2026-10-29, codex 0.166.0, a python pty 80×24, the owner's own `CODEX_HOME`.

**From 0.166.0 the npm `codex` is one process.** Its `bin/codex.js` replaces itself with
the native binary (`execve`), so the pid that ran `node …/.bin/codex` becomes
`…/codex-darwin-arm64/vendor/…/bin/codex` with the same arguments; on 0.165.0 the same
command was a `node` process with the native binary as its child (2026-10-30, `ps` of a
running TUI and app-server per build). Koloft kills a tab's process group by pid, and
finds a left-over or remote app-server by its `app-server --stdio` arguments, which
`ps` showed kept; that both still work, and that a Workbench shell's title now shows
`codex` where it showed `node`, is inferred from that `ps`, not run (the real-binary
e2e specs passed on 0.166.0, section 7).

Koloft's own stop, ownership and retry rules are product rules, covered by
`test/unit/codexTransport.test.ts`, not Codex facts.

## 6. Worktree boundary

**Measured without a model call.** In a temporary repository with a committed baseline,
Git created a linked worktree. The real TUI and app-server ran in that checkout using
`-C`. The returned thread cwd matched it. After native `/exit`, the checkout directory,
branch and HEAD were still present and unchanged.

**Codex 0.162.0 makes worktrees of its own ("managed worktrees"), on by default.**
Read 2026-10-11 from Codex CLI 0.162.1: `codex features list` prints `worktrees stable
true` (on 0.164.0, 2026-10-23, `worktrees removed true` — the flag is gone and the
feature always on, while `--worktree` is still in `codex --help` and `resume --help`);
`codex`, `exec`, `resume` and `fork` take `--worktree` ("Run the session in a new
managed Git worktree"); the model gets the MCP tools `codex_worktrees/create_worktree`
("Defaults to the repository's remote default branch, not the current branch"),
`get_worktree_creation_status` and `list_worktrees`; and the TUI's strings hold a
picker "Where should the new conversation run?" / "Where should the forked conversation
run?" with "Use current Git worktree", "Create new Git worktree", "Continue current
conversation" and "Start new conversation", and "Managed worktrees are only supported
for local sessions" / "require a local Git repository" / "The source project is not
trusted". Where it puts them is not in the strings (only Desktop keys
`desktop.git-worktree-root`, `desktop.worktree-auto-cleanup-enabled`), and whether the
picker shows on `/new` in a TUI connected with `--remote` was not seen in the e2e run
of that day (the Playwright MCP case does a `/new` and passed), so it is read, not
run: **inferred, not checked**.

**A thread goes on in a worktree deleted and made again at the same path.** Checked
2026-10-25 with codex-cli 0.162.0 and this Mac's own login: `codex app-server` (stdio)
started a thread in a linked worktree `<repo>/.claude/worktrees/lost` on branch
`worktree-lost`, and one turn was told a code word. The app-server was stopped, the
folder deleted, `git worktree remove` and `git worktree add <path> worktree-lost` made
it again, and a new app-server's `thread/resume {threadId, cwd: <same path>}` returned
the same thread id and cwd; the next turn answered the code word. The thread was
archived afterwards.

## 7. Rechecking a CLI upgrade

Each dated section names the binary it ran: 0.153.4, 0.159.3, 0.161.0, 0.162.x, 0.163.0,
0.164.0, 0.165.0 or 0.166.0. Koloft
treats the minor line of its minimum (`MIN_CODEX_VERSION` in `src/main/cliMinimums.ts`)
as verified (`verified` in `src/main/codexRuntime.ts`, pinned by
`test/unit/codexRuntime.test.ts`) and warns on anything newer. The owner raised the
minimum from 0.153.4 to 0.161.0 on 2026-10-08 without redoing the live checks on 0.161;
since then, on 0.162.0–0.162.1 (2026-10-09 to 2026-10-11, each entry dated where it
sits): section 1 (handshake, `thread/list` shape), 5 (the app-server lock), 11 (approval
flags on a resume, `turn_context` fields), 15 (`auth.json`, the shared `sessions/`, a
turn on another login, and the read-after-resume limit, issue #486), 17 (the handover
note naming the thread), 19 (message phases), 21 (auto-compaction), 23 (paste), 24, 25
and 26 were measured again, and the real-binary e2e specs that stand on 10, 11, 17, 23
and 26 passed on 0.162.1. On 0.163.0 (2026-10-16): sections 1 (`thread/list` shape),
10 (the command line after the zsh backend went), 11 (a resume's permissions — changed,
see there), 13/14 (`model/list`, the default model), 17 (a message queued mid-turn), 20
(the waiting question), 21 (the slash popup) and 25 (the TUI's startup bytes, OSC 7501,
the leader key) were measured again, and the same e2e specs passed; they passed again on
0.163.0 on 2026-10-17, 2026-10-19, 2026-10-20, 2026-10-21 and 2026-10-22 (no newer
Codex on any of those days). On 0.164.0 (2026-10-23): sections 1 (`thread/list` shape),
6 (the `worktrees` flag), 11 (a model and thinking level on a resume, `-c` at two
levels), 13 (the token-usage fields, and reasoning tokens as a part of output), 15
(`auth.json` keys, `login status`, compressed rollouts), 20 (the waiting-question flag),
27 (two new hook events) and 28 (the start race, not fixed) were measured again, and
the same e2e specs passed, the remote ones (E-SSH-23/24/25) too with 0.164.0 as the
Mac's codex (that the Linux lab machine then ran 0.164.0 as well is inferred from the
install script taking a version, not checked). On 0.165.0 (2026-10-28, an app-server
over stdio per build in a throwaway `CODEX_HOME` and `HOME`, three real `gpt-6-luna`
turns each against 0.164.0): sections 1 (`thread/list` keys `data, readStates,
nextCursor, backwardsCursor`, 32 keys per row, the same notification set in a turn;
the experimental schema adds only the client method `thread/memory/read`,
`ThreadForkParams.attachToSource` and `ThreadListParams.attachedToThreadId`, and no
server notification or request), 11 (a resume's `never` / `danger-full-access`, the
`-c` given ignored; with no `approvals_reviewer` set `thread/start` answers
`approvalsReviewer: "user"` on both), 13/14 (`model/list`: the same eight models on
both builds, `gpt-6.1-terra` new to this ledger, the default still `gpt-6.1-sol`), 15
(`login status`, `auth.json` unchanged by a turn, the sign-in read once at start), 17
(a message queued mid-turn starts the next turn within 14 ms, `clientId` kept), the
rollout records of section 13 (one new record, see there) and 27 (the same four events, order and stdin keys) were measured
again, and the same e2e specs passed. `codex --help`, `app-server --help`, `exec
--help` and `resume --help` are byte-identical to 0.164.0's. On 0.166.0 (2026-10-30, the
same way against 0.165.0, `gpt-6-luna`): sections 1 (`thread/list` keys unchanged, 32
keys per thread; the schema adds only the client methods `account/gcp/setup`,
`accountSession/list` and `accountSession/switch`, the fields `ThreadItem.startedAtMs` /
`completedAtMs`, `ThreadUsage.nativeUsageUsdMicros`, `HooksListParams.threadId`,
`HookMetadata.environmentId` and `ProcessExitedNotification.outputDrainTimedOut`, and no
server notification or request), 5 (the npm `codex` is now one process), 11 (a `never`
/ `danger-full-access` thread resumed by an app-server given other `-c` stays as it was;
the other two shapes not rerun), 13/14 (`model/list` the same eight models, all priced,
default `gpt-6.1-sol`; `total` keeps growing across a resume; reasoning tokens were 0 in
every turn, so the notes' "reasoning-token accounting across resume and fork" was not
reached), 15 (`login status`, `auth.json` unchanged by a turn), 17 (an unsubscribed
thread unloads within a minute and a message queued into it waits), 25 (OSC 7501 still
sent; the `?u` and DA1 queries now come before `6n`), 27 (the same four events and
keys; `cwd` is now the command's folder), 28 (the start race, not fixed), 33 (`codex
queue`'s options) and 34 (a TUI whose app-server is killed keeps trying to reconnect)
were measured again, and the same
e2e specs passed, the remote ones (E-SSH-23/24/25) too. `codex
--help`, `app-server --help`, `exec --help` and `resume --help` are byte-identical to
0.165.0's; `queue --help` and `doctor --help` (`--network-only`) differ. Still only on 0.153.4 or 0.159.3, and so inferred for 0.161+: section
1's update-notice key (0.164.0 accepts the key, its effect was not watched), 2, 3 (the
approval keys), 4, 9 (the trust question before connecting), 12 (`fileChange` /
`commandActions` shapes, the `open` shim) and 14's first prompt. `codex --help`,
`app-server --help`, `exec --help` and `resume --help` are byte-identical on 0.161.0,
0.162.1 and 0.163.0 (2026-10-16). On 0.164.0 (2026-10-23) `--help` adds
`migrate-nfs-db` and `app-server --help` adds `--startup-sign-out`,
`--print-startup-config`, `--startup-client-info` and `--cloud-skills-snapshot`; `exec
--help` and `resume --help` are unchanged.

Keep worktree tests inside a temporary repository. Record version, executable source,
matching request IDs, thread IDs and event order; redact login/account contents. Fixture
tests cannot replace these external checks.

## 8. Native status line

**Checked on 2026-10-16 with standalone Codex CLI 0.162.0** (`~/.local/bin/codex` →
`~/.codex/packages/standalone/current/bin/codex`), **without a model call.** The real TUI
ran in a temporary Git repository with an isolated `CODEX_HOME` and an unauthenticated
test provider pointing at an unused localhost port, both on its own and as
`--remote ws://…` against a separate `codex app-server --listen ws://…` given the same
`-c` overrides. The PTY output was decoded with pyte at 220, 160, 120, 100 and 55
columns. First measured on 2026-09-10 with 0.153.4; the findings below hold on both
unless marked.

- `[tui]` has three keys for this, and only three: `status_line`,
  `status_line_use_colors` and `terminal_title` (binary strings). `tui.status_line` is a
  flat, ordered list of built-in item IDs. Passing it with `-c` to the app-server and to
  the remote TUI displayed the selected items. A list of lists stops startup:
  `invalid type: sequence, expected a string in tui.status_line`. That server startup
  overrides supersede the file's list without rewriting it was checked by `config/read`
  on 0.153.4 only.
- **Without the override the TUI shows the owner's own list.** Measured 2026-10-23 on
  0.162.0, no model call: a TUI started as `--remote ws://…` against
  `app-server --listen ws://…`, isolated `CODEX_HOME` whose `config.toml` sets
  `[tui] status_line = ["project-name", "hostname"]`. With no `tui.status_line` `-c` on
  either process, the footer showed only the hostname (`project-name` showed nothing in
  that folder, which was not a repository). With Koloft's list given by `-c` to both,
  the footer showed Koloft's items and not the file's. With neither the file's list nor
  `-c`, it showed the default `model-with-reasoning` and `current-dir`, and no thread
  name on a fresh thread. The list is read on the TUI's side: with the TUI's
  `CODEX_HOME` listing `hostname` and the app-server's (another `CODEX_HOME`) listing
  `codex-version`, the footer showed the hostname; with no list in the TUI's home it
  showed the default, whatever the app-server's home said.
- The footer is one line. Long content ends in an ellipsis at every width tried;
  shrinking the terminal does not wrap it. `"\n"`, `newline`, `line-break`, `separator`
  and `spacer` each produce an "Ignored invalid status line items" warning (F2). The
  native configuration cannot reproduce a three-line footer.
- No item runs a user command or reads a file: `custom-command`, `command` and `custom`
  are rejected, and a picker search for "command" returns no matches.
- The `/statusline` picker offers 31 IDs: `model`, `model-with-reasoning`, `reasoning`,
  `current-dir`, `project-name`, `hostname`, `git-branch`, `pull-request-number`,
  `branch-changes`, `run-state`, `permissions`, `approval-mode`, `context-remaining`,
  `context-used`, `five-hour-limit`, `weekly-limit`, `codex-version`,
  `context-window-size`, `used-tokens`, `total-input-tokens`, `total-output-tokens`,
  `thread-credits`, `estimated-thread-cost`, `thread-id`, `fast-mode`, `daybreak`,
  `raw-output`, `thread-name`, `thread-title`, `workspace-headline`, `task-progress`.
  With no `tui.status_line` set, `model-with-reasoning`, `current-dir` and `thread-name`
  are ticked. The binary also carries descriptions for `daily-limit`, `monthly-limit`,
  `annual-limit`, `usage-limit` and `secondary-usage-limit`, but 0.162.0 rejects all
  five as invalid items.
- `account`, `account-email`, `plan`, `rate-limits`, `git-worktree`, `git-changes`,
  `git-review` and `session-cost` produce invalid-item warnings; picker searches for
  account, worktree, plan and usage return no matches.
- The picker describes `five-hour-limit` and `weekly-limit` as **remaining** usage on
  the primary and secondary limit, but they pick a window by its length (below). On the
  unauthenticated home both are omitted; the picker preview's `primary 0% · secondary
  0%` is sample text.
- **What `five-hour-limit` and `weekly-limit` draw.** Checked 2026-10-26 on 0.162.0, no
  real login: a TUI started as `--remote ws://…` against a small relay in front of an
  `app-server --listen ws://…` on a scratch `CODEX_HOME` (API-key `auth.json`, a local
  fake Responses server). The relay answered `account/read` as a ChatGPT `pro` account,
  answered the TUI's own `account/rateLimits/read` in section 15's shape, and pushed
  `account/rateLimits/updated`. The PTY output was decoded with pyte.
  - Primary `{usedPercent: 25, windowDurationMins: 300}`, secondary `{usedPercent: 60,
    windowDurationMins: 10080}`: the footer read `Context 0% used · 5h 75% left · weekly
    40% left · …` from the startup read, and kept it after a turn.
  - **The footer follows the TUI's own read, which it repeats every 60 s.** The TUI sent
    `account/rateLimits/read` at startup and then once a minute (7 reads in 390 s). When
    the relay answered the second read with new numbers, the footer changed at that
    minute (`5h 50% left · weekly 10% left`). A pushed `account/rateLimits/updated` with
    new numbers did not change the footer (it raised Codex's low-limit warning below),
    and the app-server's own push after each turn on the API-key home (`primary: null,
    secondary: null`) did not blank it.
  - The items pick a window by its length, not its slot: with only a primary
    `{usedPercent: 85, windowDurationMins: 10080}` (the shape section 15 measured on a Pro
    login), `weekly-limit` alone drew `weekly 15% left` and `five-hour-limit` alone drew
    nothing.
  - `account/rateLimits/read` answering `-32600` (signed out, or an API-key login): both
    omitted, no warning, the turn ran.
  - Neither item takes an "Ignored invalid status line items" warning. Below 25% left,
    Codex adds its own "Heads up, you have less than 25% of your weekly limit left"
    warning and a line above the composer; that comes with the data, not with the items.
  - Koloft's list `context-used, five-hour-limit, weekly-limit, git-branch,
    codex-version, model-with-reasoning, …` in a folder with no branch: at 100 columns
    both limits stayed and `current-dir` was cut with an ellipsis; at 80 columns the
    model name was cut too (`· probe-model defau…`).
  - `x-codex-primary-*` / `x-codex-secondary-*` headers on a custom provider's responses
    (API-key login) did not fill either item.
- `branch-changes` counts **committed** changes against the default branch only: an
  uncommitted edit showed `No changes`, the same edit committed showed `+2 -0`. It is
  not a substitute for working-directory change counts.
- `pull-request-number` is the open PR number for the current branch, omitted when
  unavailable; it carries no review or check status. `estimated-thread-cost`,
  `thread-credits` and `workspace-headline` are Enterprise-only and were omitted. The
  preview's `PR #123`, `~$1.82` and `5.2 credits` are sample values, not account data.
- `tui.terminal_title` (picker: `/title`) takes 25 IDs, `activity`, `thread-name` and
  `project-name` ticked by default. The title is written as OSC 0 with items joined by
  ` | ` (e.g. `ESC]0;Ready | gpt-5.2-codex default | feat/probe-branch | Context 0% used
  BEL`), rewritten as state changes, cleared with an empty OSC 0 on exit, and also
  emitted under `--remote`.
- A plain `codex -c …` shows a startup warning that command-line overrides require
  embedded mode instead of the shared background server; without `-c`, the TUI
  starts a managed `codex app-server --listen unix:// --managed-daemon` under
  `$CODEX_HOME/packages/app-server-daemon/`. The `--remote` launch showed no warning.
- The picker offers `Use theme colors` (`tui.status_line_use_colors`). No per-item
  background colors or Powerline separator settings are exposed.

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
item with `aggregated_output` (also `stdout`, `formatted_output` on 0.161.0; **on
0.162.1 only `aggregated_output`** — a `codex exec` turn on 2026-10-11 wrote the item
with the keys `type, id, process_id, command, cwd, parsed_cmd, source, status,
aggregated_output, exit_code, duration`, and the 0.162.0 notes say the output was
"consolidated into `aggregated_output`"; the wire frame's `aggregatedOutput`, which
Koloft reads, is unchanged). The same rollout's `turn_context` gained a
`permission_profile` object (`{type: "managed", file_system: …, network: …}`) beside
`approval_policy` and `sandbox_policy`, which still hold what §11 reads. Established by
`agent-tools-real-smoke.spec.ts` › "a real Codex in a worktree Koloft made gets the
ignored files .worktreeinclude lists, and echoes, with its shell tool, the port offset of
that worktree’s name" (green again on 0.162.1, 2026-10-11, and on 0.163.0, 2026-10-16).
**0.163.0 dropped its patched zsh backend, and the command line is unchanged**
(2026-10-16, a Node client on a stdio app-server, real turns on 0.162.1 and 0.163.0): the
model's `echo hi` still ran as `["/bin/zsh","-lc","echo hi"]`, the rollout item's keys are
the eleven above on both, with `source: "unified_exec_startup"` and `cwd` written as a
`file://` URL; on the wire the item's `command` is one string (`/bin/zsh -lc 'echo hi'`)
and `source` is `unifiedExecStartup`. The retired flags `features.shell_zsh_fork` and
`features.unified_exec_zsh_fork` (`-c` or `config.toml`) bring a `deprecationNotice`
notification ("… is deprecated and ignored. The patched zsh backend has been removed…"),
`-c zsh_path=…` a `configWarning` plus a thread `warning` and an ERROR line on stderr;
`shell_environment_policy` is still taken in silence. Koloft sends none of those keys.

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
- **Codex CLI 0.162.0 (2026-10-26) has no No**: in a git repository the question
  offers "1. Trust and continue / 2. Back to Agent Command Center". Picking 2 (↓ then
  Enter), or Esc, does not exit: Codex shows its task list ("Agent command center …
  No tasks yet") and writes nothing to `config.toml`; Esc there goes back to the
  ordinary prompt, and Ctrl+C there prints "Shutting down..." and exits 0. The same
  under `--remote`. In a plain empty folder that is not a git repository it did not
  ask at all. Probed with a pty driver, a temp HOME and `CODEX_HOME` holding an
  API-key `auth.json`.
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
run, `-a on-request -s read-only` led to an approval request.

**What `never` does with and without the sandbox, measured 2026-10-23 with `codex-cli
0.162.0`.** A Node client on `codex app-server` (stdio) with a throwaway `CODEX_HOME`
holding a copy of this Mac's login started one thread per setting (`thread/start` with
`approvalPolicy` and `sandbox`) and asked a real model to run `touch` on a file outside
the folder, then `curl https://example.com`; other threads asked for `git add` and
`git commit` in a plain checkout and in a linked worktree under
`<repo>/.claude/worktrees/`.

- `never` / `workspace-write`: no `…/requestApproval` request at all. The `touch` failed
  ("Operation not permitted", exit 1), the `curl` failed ("Could not resolve host", exit
  6), and `git add` failed in both checkouts ("Unable to create '…/.git/index.lock' /
  '…/.git/worktrees/<name>/index.lock': Operation not permitted", exit 128). The model
  reported the failures and stopped; nothing offered a way past them. Adding the
  repository's `.git` to `sandbox_workspace_write.writable_roots` on the app-server did
  not lift the `git add` refusal in the linked worktree.
- `never` / `danger-full-access`: no request; the `touch` and the `curl` (200) worked.
- `on-request` / `workspace-write` (what a trusted folder gets with no flags): the `curl`
  failure was followed by an `item/commandExecution/requestApproval` for an escalated
  retry.

So "skip permission prompts" can only mean `never` / `danger-full-access` for Codex:
with the sandbox kept, a session that never asks cannot even commit.

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
and `agent-tools-real-smoke.spec.ts` › "a real Codex session started with skip permission
prompts on runs with approvals and the sandbox off, and resumed after its tab closed …"
(before the change: `turn_context`
`never` / `workspace-write`, the write refused). A new thread with the choice on the
app-server alone, and no `-a`/`-s` on the TUI, is not probed yet. The resume case
passed again on 0.162.1 (2026-10-11; its `turn_context` read still finds
`approval_policy` and `sandbox_policy`, §10) and on 0.163.0 (2026-10-16).

**Codex CLI 0.163.0 restores a resumed thread's own permissions and ignores the
app-server's `-c approval_policy=…` / `-c sandbox_mode=…` on a resume.** Measured
2026-10-16 with a Node client on `codex app-server --stdio` and, for the TUI line, a
real `codex --remote unix://… resume <id>` on an `app-server --listen` started with
those two `-c` flags; a throwaway `CODEX_HOME` holding a copy of this Mac's login, real
turns, each turn's settings read from the rollout's `turn_context` (its keys as in
§10, nothing new for the changelog's "network approvals"):

- A thread started `never` / `danger-full-access` came back the same on a bare resume
  by a new app-server with no `-c` (on 0.162.1 the same resume came back `never` /
  `workspace-write`, as the bullet above says — that sentence holds only up to 0.162.1).
- The same thread resumed by an app-server with `-c approval_policy="never" -c
  sandbox_mode="workspace-write"` still ran `never` / `danger-full-access`: the `-c` was
  ignored. A thread started with no permission params (`on-request` /
  `workspace-write`) resumed with `-c approval_policy="never" -c
  sandbox_mode="danger-full-access"` stayed `on-request` / `workspace-write`, through
  the plain client and through the real TUI alike.
- Explicit params on the request win: `thread/resume {threadId, approvalPolicy:
  "on-request", sandbox: "workspace-write"}` on the `never` / danger thread ran
  `on-request` / `workspace-write`, and the next bare resume restored *that* — a value
  set by params becomes what the thread remembers. The `thread/resume` result carries
  `approvalPolicy`, `sandbox` and `activePermissionProfile` matching the `turn_context`.
- **A model and thinking level on a resume behave unlike the permissions** (2026-10-23,
  codex-cli 0.163.0 and 0.164.0 alike; a real TUI `codex --remote ws://… -C <repo> -c
  tui.status_line=… -c check_for_update_on_startup=false resume <id>` in a Python pty
  against an `app-server --listen`, one `gpt-6-luna` turn per case, `turn_context` read
  after). A thread started `gpt-6-luna` / effort `high` came back `gpt-6-luna` / `high`
  on a bare resume. `-m gpt-6-sol -c model_reasoning_effort="low"` on that TUI line was
  taken with no error, ran `gpt-6-sol` / `low`, and the thread remembered it. `-c
  model=… -c model_reasoning_effort=…` on the app-server was ignored on a resume. Koloft
  passes `-m` and an effort only on a scheduled job's start, never on a resume.
- **On 0.164.0 a `-c` given at two levels of one command line keeps both** (2026-10-23:
  `codex -c model=… exec -c model_reasoning_effort="low" …` ran with both on 0.164.0;
  0.163.0 dropped the top-level `model`). Koloft writes every `-c` at one level.

Koloft is not caught by this: it resumes a thread with the permission it saved for that
session (`permission` in its own metadata, the one the thread was started with), so what
the thread restores is what the `-c` would have set; the conductor's choice is the same
on start and resume — as long as the thread's last turn ran under that choice. A
`bypass` thread whose last turn was a resume without Koloft's `-c` (on 0.161–0.162 a
bare resume always came back `workspace-write`, above) keeps `workspace-write` on
0.163.0 while Koloft's row says bypass, and the old path cannot lift it (inferred from
the three resume shapes measured; that thread was not built). The `-c` pair on a
resume is dead weight on 0.163.0 and still the
thing that sets the sandbox on 0.161–0.162. A resume that should *change* a thread's
permissions would have to go through the `thread/resume` params (the TUI sends that
request; Koloft's relay would have to add them) — not needed today.

**The trust table decides the sandbox of a thread started with no sandbox flag.**
2026-10-16, codex-cli 0.162.0, `codex app-server --stdio` driven by a Node script, a
throwaway `CODEX_HOME`, no model turn: `thread/start {cwd}` with no `sandbox` and no
`approvalPolicy` answered `sandbox: {type:"workspaceWrite", networkAccess:true,
writableRoots:[…]}` / `approvalPolicy: "on-request"` for a folder with a
`[projects."<realpath>"] trust_level = "trusted"` table, and `sandbox: {type:"readOnly",
networkAccess:false}` / `"on-request"` for a folder without one — with the same `-c
sandbox_workspace_write.*` on the app-server, and whichever folder the app-server itself
started in. `config/read {cwd}` answered `sandbox_mode: null` for both. Not probed yet:
what the TUI over `--remote` sends after the owner answers its trust question in an
untrusted folder.

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
Protocol) relay) goes through an MCP server, never a sandboxed command: see section 26.

**`sudo` cannot start inside `workspace-write`.** `codex exec --skip-git-repo-check -s
workspace-write` (0.162.0, 2026-10-15, this Mac's login, a scratch folder) running
`/usr/bin/sudo -n -k true` got `zsh:1: operation not permitted: /usr/bin/sudo`, exit 127:
the sandbox refuses to exec the setuid binary at all, before any password question. That
Codex's own default (`read-only`) refuses it too, and that a command Codex runs outside
the sandbox after an approval reaches sudo: **inferred, not checked**.

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
- `reasoningOutputTokens` is a part of `outputTokens`, the way OpenAI's API counts it
  (2026-10-23, codex-cli 0.163.0 and 0.164.0, one `gpt-6-luna` turn at effort `high`
  through the app-server: 50 of 57 and 44 of 51 output tokens, `totalTokens` =
  `inputTokens` + `outputTokens` in each frame; the rollout files agree, below). Koloft
  does not add it on top. The frame's fields (`totalTokens`, `inputTokens`,
  `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`, `reasoningOutputTokens`
  under `total` and `last`, and `modelContextWindow`) are the same on 0.164.0.

**Token counts in the rollout files, checked on 2026-10-16 with `codex-cli 0.162.0`.** A
live probe in a throwaway `CODEX_HOME` (real tiny turns, deleted after), and a read of
the 46 rollout files on this Mac, written by 0.149.0-alpha through 0.162.0, printing
field names and numbers only.

- **Live frames.** `thread/tokenUsage/updated` is `{method, params, emittedAtMs}`, with
  `params` = `threadId, turnId, tokenUsage{total, last, modelContextWindow}`. `total`
  carries the turns from before a resume (13147 before; after a fresh app-server's
  `thread/resume` and one turn of 13800, `total` = 26947). Right after `thread/resume`,
  before any new turn, the new app-server sends the old last turn's frame again — same
  `turnId`, same `total`. `emittedAtMs` is the send time, not the turn's. No frame and no
  `Turn` carries a model; a thread can change model mid-way (`turn/start` with `model`;
  `thread/settings/updated` says so; `thread/read` shows only the current one).
- **Where.** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`, archived
  ones under `archived_sessions/`.
- **`token_usage_record`**, one line per request to the model: `timestamp` (ISO),
  `ordinal`, `payload{thread_id, turn_id, session_id, root_turn_id, response_id, usage,
  turn_token_usage, thread_token_usage}`. Each usage block has `input_tokens,
  cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens,
  total_tokens`. `turn_token_usage` and `thread_token_usage` are running sums that repeat;
  only `usage` is one request's own.
- **`turn_context`**, one line per turn: `payload{turn_id, root_turn_id, model, effort,
  approval_policy, sandbox_policy, …}` — the only place a turn's model is written.
- **`session_meta`**: `payload{id, cwd, timestamp, source, thread_source, cli_version,
  creator_account_id, …}`; `source` is `"vscode"`, `"exec"`, or `{subagent: {thread_spawn:
  {parent_thread_id, depth, …}}}`. A child agent's rollout holds two: its own first, then
  a copy of its parent's (all 11 files with two here; the second's `id` is the first's
  `forked_from_id` and `parent_thread_id`). Every `token_usage_record` in a file carries
  the first one's `id` as `thread_id`.
- **Rules that held on every file** (46 files, 273 turns, 4467 records): a `turn_id`'s
  `turn_context` is written before that turn's first record; `response_id` never
  repeats, within a file or across files, and is never null; the sum of a turn's
  `usage.total_tokens` equals its last `turn_token_usage.total_tokens`.
- **0.165.0 adds a `response_item` of `type: "configuration_update"`**, `{type,
  reasoning: {effort}}` with `metadata.harness_authored_configuration`, written in the
  middle of the first turn; every other record type and its keys are the same as
  0.164.0's (2026-10-28, three app-server turns per build in a throwaway `CODEX_HOME`).
  Koloft's usage scan reads only `session_meta`, `turn_context` and
  `token_usage_record`, so it passes over it. 0.165.0 also writes
  `thread_settings_applied` on a resume only at the next turn, where 0.164.0 wrote it
  at the resume itself.
- **`reasoning_output_tokens` is inside `output_tokens`**: in all 3753 records where it
  was above 0, `total_tokens = input_tokens + output_tokens` and reasoning ≤ output.
- **Size.** 46 files, 89 MB, read in 0.6 s.
- **A fork's rollout holds only its own requests** (2026-10-24, codex-cli 0.162.0, a
  real `codex exec` turn, then `codex fork <id> "<prompt>"` in a pty, throwaway
  `CODEX_HOME`): the new file's `session_meta` carries `forked_from_id` = the parent,
  and its one `token_usage_record` is its own request (new `response_id`, input 16074);
  none of the parent's records is copied. The TUI's exit line ("Token usage:
  total=… input=6,034 (+ 24,320 cached)") sums parent and fork, so it is not the
  fork's own spend.

**Price table.** Read on 2026-09-24 from OpenAI's pricing page
(`developers.openai.com/api/docs/pricing`, reached from `platform.openai.com/docs/pricing`,
through a web fetch that summarized the page), standard tier, US dollars per million
tokens (input / cached input / output): `gpt-6-astra` 10 / 1 / 50, `gpt-6-sol` 2 / 0.2 /
10, `gpt-6-luna` 0.1 / 0.01 / 0.5, `gpt-5.6-sol` 4 / 0.4 / 20, `gpt-5.6-terra` 2 / 0.2 /
12, `gpt-5.6-luna` 0.2 / 0.02 / 1.2, `gpt-5.5` 5 / 0.5 / 30, `gpt-5.4` 2.5 / 0.25 / 15,
`gpt-5.3-codex` 1.75 / 0.175 / 14, `gpt-5.2` 1.75 / 0.175 / 14, `gpt-5.1` 1.25 / 0.125 /
10, `gpt-5` 1.25 / 0.125 / 10. **`gpt-6.1-sol` 2 / 0.10 / 10** (the same page, fetched
2026-10-11; Codex 0.161.0 made it the default model of the bundled catalog, so a fresh
account home runs on it). **`gpt-6.1-terra` 1 / 0.05 / 5, long context 2 / 0.10 /
7.5** (the same page, fetched 2026-10-28; `model/list` offered it on Codex 0.164.0 and
0.165.0 alike that day, `isDefault: false`, efforts `low` … `ultra`). The page now also lists 30-minute and 12-hour
cache-write prices (about 1.25 and 2.5 times the input price), but Codex reported
`cache_write_input_tokens` 0 in every record of a fresh home's turns on 0.164.0 and
0.165.0 (2026-10-28), so Koloft prices cache writes at 0. The page lists
a higher "long context" price for prompts above 272K tokens; Codex's window on this Mac
(258400 on the wire, 272000 in `~/.codex/models_cache.json`) stays below it, so only
the short-context price is used — **no longer true for `gpt-6.1-sol`**: on 2026-10-16
the `models_cache.json` a fresh throwaway home got from `model/list` on 0.162.1 and on
0.163.0 gives it a `context_window` of 500000 (the other six 272000), and on 2026-10-28
the same file on 0.164.0 and 0.165.0 gives `gpt-6.1-terra` 500000 too, so a prompt above
272K tokens on either is billed at the long-context price (the context meter
reads `modelContextWindow` from the wire, not the table). The same page on 2026-10-16
("Long context: >272K input tokens", input / cached / output): `gpt-6.1-sol` 4 / 0.20 /
15, `gpt-6-astra` 20 / 2 / 75, `gpt-6-sol` 4 / 0.4 / 15, `gpt-6-luna` 0.2 / 0.02 / 0.75,
`gpt-5.6-sol` 8 / 0.8 / 30, `gpt-5.6-terra` 4 / 0.4 / 18, `gpt-5.6-luna` 0.4 / 0.04 /
1.8 — twice the short-context input and cached price and 1.5 times the output price,
except that a 272K-window model never reaches it (issue #669). Koloft prices a request
whose own `inputTokens` is above 272K at that second row (see `last` below). The model
ids match the
`slug`s in `~/.codex/models_cache.json` on the same day. `model/list` on 2026-10-16
(0.162.1 and 0.163.0 alike) listed `gpt-6.1-sol` (`isDefault: true`, efforts `low` …
`ultra`), `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`,
`gpt-5.6-luna`, each with `availableAccessPrograms {cyber: ["standard"]}`; the cache adds
`gpt-reserve` and `codex-auto-review` (visibility `hide`), and the binary's bundled
catalog also names `gpt-daybreak-blue-latest` and `gpt-daybreak-red-latest`, which this
account does not get. "Daybreak", on by default since 0.163.0, is a per-thread
cyber-access program (`daybreakEnabled` on `thread/start`, thread items and the
`thread/list` rows; `/daybreak` in the TUI; the `cli_daybreak` flag went from under
development to stable), not a change of the default model. A ChatGPT plan login is not billed per token:
this cost is what the same tokens would cost on the API, not what the person pays.

**`last` is one API request, not the turn's sum** (2026-10-18, codex-cli 0.162.0, this
Mac's login, a real `codex app-server` over stdio in a scratch folder, `gpt-6-luna`, one
turn that ran two shell commands, the thread archived after): the turn sent two
`thread/tokenUsage/updated` frames with the same `turnId`; the second had
`last.inputTokens` 18123 and `total.inputTokens` 35982 (= 17859 + 18123), so `last` is
the newest request and `total` the running sum. The rollout files agree: across the 60
newest rollouts under `~/.codex/sessions`, 917 `token_usage_record` lines belong to a turn
of more than one request (`turn_token_usage` ≠ `usage`); for 908 of them an `event_msg`
`token_count` has `last_token_usage` equal to the record's own `usage` (the request), for
none is it the turn's sum, and 9 match neither. A frame can come twice: right after
`thread/resume`, before any new turn, a fresh app-server sends the old last turn's frame
again with the same `turnId` and the same `total` (2026-10-16, codex-cli 0.162.0, a
throwaway `CODEX_HOME`, issue #225), so Koloft adds a request's long-context surcharge
only when `total` has grown. The same probe found that `total` after a resume still
holds the turns before it (13147 before; one more turn of 13800 gave 26947), while a
fresh observer has seen none of their `last` frames: those earlier requests stay at the
short price in the cost line.

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

**Which models a task can name.** 2026-10-26, standalone Codex CLI 0.162.0, `codex
app-server` on stdio in a throwaway `CODEX_HOME` and `HOME` with no login, `initialize`
then `model/list {}`: eight models, none hidden, each `{id, displayName,
supportedReasoningEfforts, defaultReasoningEffort, isDefault, upgrade, …}`.
`gpt-6.1-sol` "GPT-6.1-Sol" (`isDefault`), `gpt-6-astra` "GPT-6-Astra", `gpt-6-sol`
"GPT-6-Sol", `gpt-6-luna` "GPT-6-Luna", then `gpt-5.6-sol`, `gpt-5.6-terra`,
`gpt-5.6-luna` and `gpt-5.5`, whose `upgrade` names a `gpt-6-*` model. `gpt-6.1-sol`,
`gpt-6-astra` and `gpt-6-sol` take `low` … `max` and `ultra`; `gpt-6-luna` `low` …
`max`; `gpt-5.5` stops at `xhigh`. A signed-in plan can get fewer or more (section 13,
`availableAccessPrograms`); that a plan without `gpt-6-astra` refuses it at launch is
**not probed yet**.

## 15. One login per CODEX_HOME, and its rate limits

**The browser login ends on a loopback address that takes the redirect from anywhere on
that machine.** Codex CLI 0.162.1 in a Debian container (2026-10-15), a temporary
`CODEX_HOME`, no browser: `codex login` printed `Starting local login server on
http://localhost:1455.` and an `auth.openai.com/oauth/authorize` address whose
`redirect_uri` is `http://127.0.0.1:1455/auth/callback`, with a 43-character `state` and
a PKCE `code_challenge` (`S256`). It listened on 127.0.0.1:1455 only. A `curl` of the
callback with a wrong `state` got `400 State mismatch` and Codex kept waiting; with the
right `state` and a made-up `code` Codex tried the token exchange (`401 Unauthorized`),
showed `token_exchange_failed` and exited. So the address a phone's browser fails to load
at the end of the sign-in, opened on the machine Codex runs on, finishes the login, once.
`codex login --device-auth` instead printed `https://auth.openai.com/codex/device` and a
one-time code that `expires in 15 minutes`, and gave up after 15 minutes.

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

**An API-key home has an account but no rate limits.** Checked 2026-10-28 with Codex CLI
0.162.0, no model turn: a Node script ran `codex login --with-api-key` (a made-up key on
stdin) in a throwaway `HOME` and `CODEX_HOME`, then `codex app-server` on stdio there.
`account/read` answered `{account: {type: "apiKey"}, requiresOpenaiAuth: true}`;
`thread/start` answered a new thread; `account/rateLimits/read` answered error `-32600`,
"chatgpt authentication required to read rate limits".

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

**A broken or expired login reads as signed out.** Checked 2026-10-25 with Codex CLI
0.162.0, no model turn: a Node script ran `codex app-server` on three throwaway
`CODEX_HOME`s (and `HOME`s) holding no `auth.json`, an `auth.json` that is not JSON, and a
well-formed ChatGPT `auth.json` whose made-up tokens had expired an hour before. All three
answered `account/read` with `{account: null, requiresOpenaiAuth: true}`. Rate limits then
failed: `-32600` for the first two, `-32603` with the server's `401 Unauthorized` for the
expired one. So Koloft's probe sees a home whose login no longer works as signed out, and
marks the account expired. Offline is different: with `HTTPS_PROXY`, `HTTP_PROXY` and
`ALL_PROXY` pointed at a closed local port, the same expired login (and a made-up one not
yet expired) made `account/read` fail with error `-32603` ("workspace routing discovery
unauthorized (401)") instead of answering `account: null`, so a probe with no network ends
in an error and leaves the account's status alone. A real login whose access token ran out
while offline was not tried.

**Online, every made-up ChatGPT login reads as signed out; a made-up API key does not.**
Checked 2026-10-29 with Codex CLI 0.162.0, no model turn, with the network on: a Node
script ran `codex app-server` on stdio in throwaway `CODEX_HOME`s and sent `account/read`
twice. An `auth.json` of only `{tokens: {access_token, account_id}}` (no `id_token`)
answered `{account: null}` both times, and `codex login status` there printed "missing
field `id_token`". A well-formed one with a made-up unsigned `id_token`, access and refresh
token, not expired, tried to refresh against OpenAI (401 "token_expired") and answered the
first `account/read` with the same `-32603` as the offline case above, the second with
`{account: null}`. `{OPENAI_API_KEY: "<made up>"}` answered `{account: {type: "apiKey"}}`
both times, with nothing on stderr. So a test that needs a Codex account to stay signed in
without a real login can only use a made-up API key.

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
account the picker chooses.

**Memories and plugins stay in each home.** Checked 2026-10-28 with codex-cli 0.164.0
and 0.165.0, a Node client on `codex app-server` in throwaway homes signed in with a
copied `auth.json`. Memories are off by default on both (`codex features list`:
`memories stable false`) and a fresh home writes no memory files. With `[features]
memories = true` in `config.toml` (0.165.0), each home made its own `memories_v2/` (a git
repo), `memories_v2.lock` and `memories_v2_1.sqlite` at app-server start and queued its
own `memory_consolidate_global` job, also in a home whose shared folders and
`config.toml` linked to another's; no memory was written within 20 minutes (the job
failed with `failed_agent` and set a retry an hour later), so whether two homes end up
with the same memories was not seen (issue #1153). A signed-in turn on either build also
fetched the curated `figma` plugin (about 600 files) into
`<CODEX_HOME>/plugins/cache/openai-curated-remote/`, one copy per home.

**A deleted rollout leaves `thread/list` at once; an archived one moves to the
`archived: true` list.** Checked 2026-10-24 with codex-cli 0.162.0, a Node client on
`codex app-server` in a throwaway `CODEX_HOME` holding three copied interactive rollouts,
no login. Deleting one rollout file dropped its thread from the very next `thread/list`
on the same app-server, and from a fresh one; `thread/read` on the deleted id still
answered with its old `path` (from the home's sqlite), so only the listing says it is
gone. `thread/archive` on another moved it from the `archived: false` list to the
`archived: true` one, on the same and on a fresh app-server; removing `archived_sessions/`
dropped it from both. Every page was read (`nextCursor` to the end), so a thread missing
from a finished listing is gone, not just old.

**A new session's rollout appears at its first turn, and another app-server lists it at
once.** Checked 2026-10-27 with codex-cli 0.162.0, a Node client on two `codex
app-server`s in one throwaway `CODEX_HOME` (no login, the model provider pointed at a
closed local port): `thread/start` wrote nothing under `sessions/`; `turn/start` created
`sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` (and the day folders) within 2 ms, even
though the turn then failed; the second app-server's `thread/list` held the thread
0.25 s later, and dropped it 0.3 s after the file was deleted. Later writes to the
rollout touch only that file. So a watch on the default home's `sessions/` that lists
when a rollout file appears or goes sees every new or deleted session, and a turn
appended to a known rollout needs no listing.

**But "ok" above means no error, not the turns: a home reads a thread's turns only
once its own sqlite has loaded that thread.** Checked 2026-10-11 on Codex CLI 0.162.1
and 0.161.0 alike (so not a change of 0.162): in the layout Koloft makes (a default
home D; an account home B with its own `auth.json` and sqlite whose `sessions/` and
`archived_sessions/` link into D's), B's app-server ran one `gpt-6-luna` turn, and
D's app-server then answered `thread/list` with the thread (`status: notLoaded`,
`historyMode: paginated`), but `thread/read` with `includeTurns: true` with
`turns: []`, and `thread/turns/list` / `thread/items/list` with `data: []` — all
plain successes, no error. `thread/resume` from D returned the turn (1 turn, 14
items), and from then on `thread/read` in D returned it too, also from a fresh
app-server on D. A rollout copied into a fresh home's `sessions/` behaves the same
(listed, 0 turns until a resume), and the home that ran the session reads its turns
with no resume. So Koloft's read of a closed session's turns, which asks the default
home, comes back empty for a session that ran in an account home and was never
resumed from the default home (issue #486). Not probed: 0.159.3 (the
§19 read was from the home that made the session), and whether
`codex migrate-rollouts --apply` fills the index. A `codex exec` rollout (`source: "exec"`) is not in the
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

**The one-shot sometimes answers 15–45 s late.** 2026-10-19 and 2026-10-20, codex-cli
0.162.0, `gpt-6-luna`, the same argv: 15 direct runs with a fresh `CODEX_HOME` holding
only `auth.json` took 2.6–6.8 s, except one that took 43.7 s and still exited 0 with the
right answer and nothing unusual on stderr. Through `test/unit/sessionRoute.real.test.ts`
4 of 24 lines (2026-10-19) and 2 of 24 (2026-10-20) were cut off by the 15 s limit; the
rest took 2.7–9.3 s. Claude's Haiku one-shot answered 24 of 24 under 5 s both nights. So
a Codex one-shot still running at the limit gets a second run beside it, and the first
answer wins (#615).

**The login still lands in `auth.json` by default on 0.162.1; a keyring is opt-in.**
Checked 2026-10-11 with Codex CLI 0.162.1 (the npm package in a scratch folder),
throwaway `CODEX_HOME`s, a dummy key on stdin: `codex login --with-api-key` printed
"Successfully logged in", exited 0, and left `auth.json` (mode 600, keys
`OPENAI_API_KEY`, `auth_mode`) — plus, new since the 0.153.4 run, `log/codex-login.log`
and a `tmp/arg0/` folder — and no Keychain entry. `codex login status` exited 0. The
store is picked by the config key `cli_auth_credentials_store` (`file`, `keyring`,
`auto`, `ephemeral`; MCP has `mcp_oauth_credentials_store`), whose default the binary's
own strings give as `file` under "Fixed defaults for packaged Codex clients"; the
0.161.0 release notes' "keyring storage" is that opt-in. With `keyring` set and the
real `HOME`, the login wrote nothing to the home and made a Keychain entry with
service "Codex Auth" and an account `cli|<16 hex>` (removed by `codex logout`); with a
throwaway `HOME` it failed, exit 1, "A default keychain could not be found" — so a
home that copies `auth.json` between accounts keeps working only while that key stays
`file`.
On 0.164.0 (2026-10-23, throwaway homes): the keys of a copied ChatGPT `auth.json` were
the same before and after a model turn (`auth_mode`, `OPENAI_API_KEY`, `tokens` with
`id_token`, `access_token`, `refresh_token`, `account_id`, and `last_refresh`); the
0.164.0 source adds optional `tokens.oauth_provenance` and `tokens.login_owner_id`,
written on a browser or device-code login (read from upstream `login/src/token_data.rs`,
not seen on disk). `codex login --with-api-key` now prints "API key saved.
Authentication is checked when you send a request." and `login status` "API key
configured - …" (0.163.0: "Successfully logged in" / "Logged in using an API key -
…"); the exit codes, and the ChatGPT ("Logged in using ChatGPT", 0) and empty-home ("Not
logged in", 1) wording, are unchanged.

**Compressing old rollouts is opt-in on 0.163.0 and 0.164.0.** 2026-10-23, a Node
client on `codex app-server --stdio` in throwaway `CODEX_HOME`s (copied login), one
`gpt-6-luna` turn, the rollout's mtime set 8 days back: `codex features list` shows
`local_thread_store_compression under development false` on both. With `-c
features.local_thread_store_compression=true`, an app-server start replaced the cold
`.jsonl` with `<same name>.jsonl.zst` within 8 s (upstream: rollouts untouched for 7
days; also the `rollout/compress` method, present on both). `thread/list` and
`thread/read` still give a `path` ending `.jsonl`, a file that no longer exists;
`thread/search` and `thread/read` work; `thread/resume` turns it back into a plain
`.jsonl` (the `.zst` removed) before the next turn, and hooks then get that path as
`transcript_path`. The same held in a fresh home whose sqlite had never seen the thread
(listed, 0 turns on read, every turn on resume). 0.163.0 and 0.164.0 behaved the same on
every one of these app-server paths; the TUI's own `codex resume <id>` lookup was not
run. A 0.164.0 rollout is larger: one short turn wrote 100 KB against 41 KB on 0.163.0,
most of it one `additional_tools` record now that `incremental_tools` is on by default.

**The rate-limit reply also carries the credit balance and saved limit resets; one can be
spent through the app-server.** Checked 2026-10-13 with Codex CLI 0.162.0 and a real
ChatGPT Pro login, no model turn: a Node script sent `initialize`, `initialized` and
`account/rateLimits/read` to `codex app-server`. The reply held `rateLimits.credits:
{hasCredits: true, unlimited: false, balance: "62500.0000000000"}` (a decimal string),
`rateLimits.rateLimitReachedType: null` while under the limit, a top-level
`ordinaryUsageAllowed: true`, and a top-level `rateLimitResetCredits: {availableCount: 3,
credits: [...]}`, each credit `{id, resetType: "codexRateLimits", status: "available",
grantedAt, expiresAt, title: "Full reset", description}`, `expiresAt` 30 days after
`grantedAt`. The schema the same binary prints (`codex app-server generate-json-schema`)
types `credits` as nullable "only `availableCount` is known", and adds
`account/rateLimitResetCredit/consume` with params `{idempotencyKey, creditId?}` (no
`creditId`: the backend picks the next) and result `outcome`: `reset`, `nothingToReset`
("no current rate-limit window is eligible"), `noCredit` or `alreadyRedeemed`. Not
probed: a real `consume` — every try spends one of the owner's resets, so Koloft offers
it only on a walled account and only the fake codex has run it; whether
`nothingToReset` leaves the credit unspent is inferred from its description.

**A `codex login` stopped part way leaves the home signed out.** Checked 2026-10-28 with
Codex CLI 0.165.0 (Linux, `node:22-bookworm` Docker image, no account): `codex login` and
`codex login --device-auth`, each in an empty `CODEX_HOME` under `script`, were sent SIGHUP
8 s in, while waiting for the browser or the device code. Each home then held only a
`log/` folder, no `auth.json`, and `codex login status` printed "Not logged in" and
exited 1. So the probe Koloft runs when a sign-in tab closes reads such a home as not
signed in.

Not tried, because they need a second real login or would open a browser on this Mac:
- that `codex login` with `CODEX_HOME` set signs in only that home and exits 0 once
  done (Koloft execs `codex login` in the sign-in terminal, so the tab closes when it
  ends, and the probe after it decides) — **inferred, not checked**;
- that two homes with two different logins each use their own login, so moving new
  sessions between homes spreads use across the two accounts — **inferred, not checked**.

**What one app-server that stays up sees, and what it keeps from its start.** Checked
2026-10-17 with Codex CLI 0.162.0, one model turn. A Node script made a throwaway `HOME`
and `CODEX_HOME` (a copied `auth.json`, a `config.toml` trusting one folder; deleted
afterwards) and kept app-server A running while it asked:

- **Threads another app-server writes show up at once.** A second app-server B ran
  `thread/start` and one turn; A's next `thread/list` held the new thread, A's
  `thread/search` found it by the word the model answered, and the `path` in A's list and
  in A's `thread/read` were the one B's `thread/start` gave.
- **`config/read` reads `config.toml` again each time**: an `[mcp_servers.probe]` table
  appended to the file showed in A's next answer.
- **The sign-in is read once, when the app-server starts.** With `auth.json` moved out of
  the home, A still answered `account/read` with the account; a new app-server C started
  then answered no account, and kept answering no account after `auth.json` was put back.
  So an app-server started before a `codex login` in its home reports the old sign-in
  until it is restarted.
- **`account/rateLimits/read` asks the network each time**: four calls on one app-server,
  1.5 s apart, took 377–851 ms each (a busy Mac; `initialize` took 3.5 s there).
- **Questions sent together on one connection all get answered**: three `thread/search`,
  a `thread/list` and a `config/read` written before any answer came back were each
  answered, together in 16 ms (an empty home, no login).
- **An app-server that only answers such questions still starts processes of its own**:
  right after `initialize`, and again after `thread/list`, `thread/search`, `config/read`
  and `account/read`, it had `git` and `git-remote-https` children fetching over https
  (no login, a `config.toml` naming one MCP server, which was not started).

## 16. Codex on a remote machine

**Checked on 2026-10-16.** On the Mac: standalone Codex CLI 0.162.0 (`codex-cli 0.162.0`).
On the machine: the repo's Docker SSH lab image (`test/e2e/fixtures/sshd.Dockerfile`,
Debian 12 arm64, reached as `kuser` with a throwaway key), with `@openai/codex@0.162.0`
installed by `npm i -g` (it pulls `codex-linux-arm64`, a static
`aarch64-unknown-linux-musl` build with `codex-resources/bwrap`, root-owned). A Node
probe on the Mac drove `ssh -T <machine> 'cd <folder> && CODEX_HOME=<home> exec codex
app-server --stdio -c check_for_update_on_startup=false'`, and a Node relay built like
Koloft's (section 1) served the real TUI. A real ChatGPT Pro login was used; no
`auth.json` holding a usable refresh token ever reached the machine (below), the Mac's
own `auth.json` kept its `last_refresh` and mtime, and the container was removed after.

**What the machine needs.**
- System CA certificates. Without the `ca-certificates` package every HTTPS call fails;
  the surface errors are `account/login/completed {success:false, error:"workspace
  routing discovery failed"}` and `account/rateLimits/read` -32603 "error sending request
  for url (…/wham/usage)"; only `RUST_LOG=debug` shows "server certificate verification
  failed. CAfile: none".
- A sandbox the kernel allows. Under Docker's default profile both the bundled `bwrap`
  and Debian's `bubblewrap` 0.8.0 fail "No permissions to create a new namespace", so a
  `workspace-write` turn completes with its commandExecution and fileChange `failed`;
  `danger-full-access` ran them. With seccomp and AppArmor off, bwrap failed later
  ("setting up uid map: Permission denied"). That `workspace-write` works on a real
  host or VM with unprivileged user namespaces is **inferred, not checked**. Without
  `bwrap` on `PATH` every start sends `configWarning` ("Codex could not find bubblewrap on
  PATH … will use the bundled bubblewrap"; the TUI shows "⚠ 1 warning · f2"); with
  Debian's `bubblewrap` installed it is gone. The 0.162.0 refusal of a writable sandbox
  executable did not appear (the bundled one was root-owned); not probed with a
  user-writable copy.

**Signing in from the Mac: `chatgptAuthTokens`.** The 0.162.0 schema has
`account/login/start {type:"chatgptAuthTokens", accessToken, chatgptAccountId,
chatgptPlanType?}` (marked "[UNSTABLE] FOR OPENAI INTERNAL USE ONLY") and a server→client
request `account/chatgptAuthTokens/refresh {reason:"unauthorized", previousAccountId}`
answered with `{accessToken, chatgptAccountId, chatgptPlanType?}`. With `initialize`
carrying `capabilities.experimentalApi: true` (without it: not probed), an app-server on
an empty remote home took the Mac login's access token and account id: the call
answered at once, `account/updated {authMode:"chatgptAuthTokens", planType:"pro"}` came
~0.4 s later, and `account/read` then answered `{type:"chatgpt", planType:"pro"}` plus
`workspaceRouting`. Rate limits and `model/list` read normally, and turns ran (below). The
home got no `auth.json`, and a byte search of every file under the user's home and
`/tmp` found neither the access nor the refresh token. Logging in with a token whose
signature was broken made the server send `account/chatgptAuthTokens/refresh {reason:
"unauthorized"}` at once; answering it with the real token completed the login. The
login lives in the process: every connection to one `--listen` server saw it, and every
new `--stdio` process started signed out. How the Mac gets a fresh access token when its
own expires (`account/read {refreshToken: true}` on a local managed home, per the
GetAccountParams description) is **inferred, not checked** — running it rotates the
owner's refresh token.

A copied `auth.json` (refresh token replaced by a dummy before Codex started) also
signed the machine in (`authMode:"chatgpt"`) and ran turns; its `last_refresh` and mtime
did not change. A real refresh token on the machine was not probed.

**Turns over ssh.** Same frames as section 12: `thread/started`, `turn/started`,
`item/started`/`item/completed`, `item/agentMessage/delta`, `turn/diff/updated`,
`thread/tokenUsage/updated`, `account/rateLimits/updated`, `turn/moderationMetadata`,
`turn/completed`. "Reply pong" took 2.6–3.7 s from `turn/start`; `touch hello.txt` plus a
file edit took 6.2 s; `initialize` answered in ~0.2–0.3 s (ssh to a local container, not
a network). Files landed in the remote folder; the rollout in
`<home>/sessions/YYYY/MM/DD/`. A second ssh line's `thread/list` (no login needed) listed
the threads with `source:"vscode"` and the remote `cwd`; a third line's `thread/resume`
returned both turns and a turn there recalled the first answer. `thread/resume` also
sends `deprecationNotice` "Full-history hydration is deprecated for paginated threads;
use `excludeTurns: true`…".

**The real TUI.** `codex -c check_for_update_on_startup=false --remote unix://<relay
socket> -C <remote folder>` (Python PTY, 120×40) through a relay that, after the TUI's
`initialized`, sends its own `account/login/start chatgptAuthTokens` (id
`koloft-login-1`, its reply dropped), holds the TUI's frames until
`account/login/completed`, and answers refresh requests itself: no sign-in screen, the
reply rendered, "Worked for 1s". The TUI's Mac home got `config.toml`, `history.jsonl`
and `tui-thread-reference-capabilities/`, no `auth.json`. One Ctrl-C at an idle composer
detaches: "Disconnected from this task. Any running work continues." plus a `codex
--remote … resume <id>` line. The footer's `current-dir` shows the Mac folder until the
thread starts, then the remote folder; `git-branch` stays empty, because the TUI sends
`command/exec ["git","-c","safe.bareRepository=explicit","branch","--show-current"]` to
the remote with `cwd` = the Mac folder its process started in, answered -32603 "failed
to spawn command: No such file or directory (os error 2)". A 0.162.0 TUI against a
0.161.0 remote app-server ran a turn the same way.

**An app-server that outlives the ssh line.** `codex app-server --listen
unix:///tmp/x.sock` (started with `setsid nohup`) makes the path a symlink into
`/tmp/codex-daemon-<uid>/<hash>`, and the socket speaks WebSocket (an HTTP Upgrade got
101; a bare JSON line got nothing). `codex app-server proxy --sock <path>` pipes stdio
bytes to it, so a client speaks WebSocket through `ssh -T … proxy`. A turn running `sleep
20` survived a SIGKILL of the ssh client (the remote proxy process ended with it); a new
proxy line found the thread in `thread/loaded/list`, `thread/resume` answered `status:
active` with the turn `inProgress`, then delivered `turn/completed` and the command's
result. A second connection got only `thread/started` and `thread/status/changed` for
another connection's thread until it resumed it, then every turn notification.
`app-server daemon bootstrap` ("durable local app-server management for SSH-driven use")
was only read in help.

**Ending.** A SIGTERM to the ssh client of an idle `--stdio` app-server ended the remote
process within 0.3 s. Mid-turn: not probed.

**A `--stdio` app-server outlives a link that drops without a word.** Measured 2026-10-17,
`@openai/codex@0.162.0` by npm on the Docker SSH lab's Debian 12 target, reached from the
Mac's OpenSSH through the lab's jump host on one ControlMaster (`ControlPersist=yes`,
`ServerAliveInterval=15`, `ServerAliveCountMax=3`), no login, an empty home. Both a
SIGTERM and a SIGKILL to the Mac's ssh client ended the remote app-server (the npm `node`
wrapper and the native `codex`) within the 32 ms a `docker exec ps` takes. With the
target taken off its Docker network instead, the Mac's ssh client exited 59 s later. In
one of two such runs both processes were still running 5 s and 65 s after the network came
back: the target's `tcp_keepalive_time` was 7200 and sshd sets no `ClientAliveInterval`,
so nothing there notices before then (that it ends at the keepalive is **inferred, not
checked**); in the other they had ended by 5 s after it came back. With the Mac's ssh
client stopped by SIGSTOP, the remote app-server kept running, as on such a drop. Timing
on the same lab line, each run five times: a fresh line that sends `initialize` and one
`thread/list` answered in 40–98 ms (162 ms once, the first line of a run); on one line
kept open, each later `thread/list` answered in under 1 ms. The lab is a local container,
not a network.

**A `--listen` app-server shrugs off SIGTERM.** Measured 2026-10-17, `@openai/codex@0.162.0`
installed by npm on Debian 12 (Docker, arm64), signed in with `chatgptAuthTokens`, idle
after two real turns and with no client connected: the process tree was the npm `node`
wrapper (process-group leader), the native `codex app-server --listen …` under it, and a
`codex-code-mode` child in a process group of its own. `/proc/<pid>/status` showed SIGTERM
caught (not ignored) by both `node` and `codex`. A SIGTERM to the group, and one to the
native `codex` alone, left all three running 3–18 s later; while they lived, a new
app-server on the same `CODEX_HOME` resuming the thread drew the TUI's "This conversation
is open in another app" (§5). SIGKILL to every process of the tree ended them, and the
resume then worked. Debian's `sh` (dash) refuses `kill -KILL -- -<pgid>` ("Illegal number:
-"); `kill -- -<pgid>` and `kill -s KILL <pid> …` work.

**`--listen` refuses a socket folder others can write.** Measured 2026-10-17 on an Ubuntu
24.04.5 VM (tart, arm64, kernel 7.0), `@openai/codex@0.162.0` by npm, login umask `0002`:
with the socket's folder made `drwxrwxr-x` by `mkdir -p`, `codex app-server --listen
unix://<folder>/<name>.sock` exited at once with "Error: socket parent must be owned by
the user or root and prevent other users from replacing socket entries". The same VM
(AppArmor `kernel.apparmor_restrict_unprivileged_userns = 1`, no AppArmor profile for
`bwrap`, `bubblewrap` 0.9.0 from apt) also logged at start "Codex's Linux sandbox uses
bubblewrap and needs access to create user namespaces." Every sandboxed command then
failed with "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted" — through
Koloft, and the same from `codex sandbox -c sandbox_mode=workspace-write -- …` run
directly on the VM. With an AppArmor profile for `/usr/bin/bwrap` granting `userns`
(`apparmor_parser -r`), the direct run wrote inside the folder and got "Read-only file
system" outside it.

**The Mac's TUI starts a machine folder read-only.** Same VM, same day: with
`[projects."/home/admin/proj"] trust_level = "trusted"` in the machine's `CODEX_HOME`, the
machine's app-server alone answered `thread/start {cwd}` with `workspaceWrite` /
`on-request`; but a thread the Mac's 0.162.0 TUI started over `--remote … -C
/home/admin/proj` with no `-a`/`-s` ran `sandbox_policy: read-only` (its `turn_context`),
and its `touch` inside the folder was refused. A trust table for that path in the TUI's
own `CODEX_HOME` did not change it, while a top-level `sandbox_mode = "danger-full-access"`
there did (Docker lab, same version: the command ran with no `bwrap`). Given `-a on-request
-s workspace-write`, the thread
wrote inside the folder, was refused outside it, and after a resume (no flags) still
wrote inside and was refused outside.

**A login shell drops the server's `PATH` on Linux.** Checked on 2026-10-16 with
`@openai/codex@0.162.0` (`npm i -g`, `codex-linux-arm64`) in a plain
`node:22-bookworm-slim` container, as a non-root user whose shell is bash, no login:
the app-server ran with `model_provider` pointed at a local fake Responses API (plain
HTTP, `env_key` set) that answered the first request with one `exec_command` function
call. The app-server's own `PATH` began with `/opt/kbin`, which held a `koloft` script,
and its environment had `KOLOFT_TAB_ID`. By default the item's command was `/bin/bash
-lc '…'`; Debian's `/etc/profile` set `PATH` afresh, so the command saw Codex's own
`codex-path` folder and `/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games`,
`command -v koloft` found nothing, and `KOLOFT_TAB_ID` was still set. With `-c
allow_login_shell=false` the command was `/bin/bash -c '…'`, its `PATH` kept `/opt/kbin`
(after Codex's `codex-path` and an `arg0` folder in `CODEX_HOME/tmp`), and it found
`koloft`. The request's tool list was `exec_command, write_stdin, request_user_input,
apply_patch, view_image, get_goal, create_goal, update_goal, tool_search, web_search`.

**A hook trusted on the Mac's terms is trusted on the machine.** Same day, same container:
`hooks/list` on the Mac's codex-cli 0.162.0 (a new empty `CODEX_HOME`) with `-c
hooks.UserPromptSubmit=…` and `-c hooks.PostToolUse=…` gave keys
`/<session-flags>/config.toml:user_prompt_submit:0:0` and `…:post_tool_use:0:0` and their
`sha256:` hashes, `untrusted`. Writing those two `[hooks.state."<key>"]` tables with
`trusted_hash` into the machine's `CODEX_HOME/config.toml` with `awk` and `printf`, twice
over, left one table each, and the machine's 0.162.0 then listed both hooks `trusted`.

Not tried: `codex login --device-auth` on the machine; a real refresh token on the machine.

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
  reads the developer instructions is inferred, not checked, beyond that spec passing
  (again on 0.162.1, 2026-10-11).
- **A thread named with `thread/name/set` right after it starts keeps that name: the
  TUI does not title it.** 2026-10-21, Codex CLI 0.162.0, one real turn each run: a Node
  client on `codex app-server --listen ws://127.0.0.1:<port>` and a real TUI connected
  with `--remote` in a pty, given a first prompt, in a scratch `CODEX_HOME` holding a
  copy of this Mac's login (deleted afterwards). With no name sent, `thread/name/updated`
  brought the TUI's own title ("Fix README heading typo") about 2.3 s after the thread
  showed in `thread/list`. With `thread/name/set {threadId, name}` sent the moment the
  thread showed, the reply was `{}`, `thread/name/updated` carried that name, no other
  title came in the next 90 s, and `thread/read` still gave the name after the turn.
  `thread/name/set` on a thread the TUI had already titled replaced its title. One run
  of each. The method is in the request list of Codex CLI 0.161.0 too
  (`codex app-server generate-json-schema --experimental`, `ClientRequest.json`), not
  run there.
- **A resume never takes new developer instructions; a start's own instructions replace
  the `-c` ones.** 2026-10-16, Codex CLI 0.162.0, `gpt-6.1-sol`, an app-server client as in
  section 27. With `-c developer_instructions=` naming codeword ZEBRA: two turns, and a
  second `thread/start` on the same server, answered ZEBRA. A `thread/start` there with
  `developerInstructions: <OTTER text>`, or `config: {developer_instructions: <FALCON
  text>}`, answered OTTER / FALCON, and those rollouts held no ZEBRA. A thread started
  under ZEBRA that never named the word was then `thread/resume`d on a server with
  `-c …YAK`, and another with the `developerInstructions: <HERON>` param: both answered
  ZEBRA, and neither YAK nor HERON reached the rollout. So a newer Koloft prompt does not
  reach a resumed older session.
- **`$CODEX_HOME/AGENTS.md` reaches the model** as a `user` message
  `# AGENTS.md instructions\n\n<INSTRUCTIONS>…`: its codeword came back (same run).
  **Skills reach it only as a list**: a `developer` message `<skills_instructions>` holds
  `- <name>: <description> (file: r0/<name>/SKILL.md)`; asked for something only the body
  held, the model ran `cat <path>/SKILL.md` and answered it. `skills/list` gave `{name,
  description, path, scope: "user", enabled, pluginId}`; a fresh home was seeded with
  `skills/.system/` (imagegen, openai-docs, skill-creator, skill-installer).
- **The folder's AGENTS.md is a memory that survives a restart and a resume.** 2026-10-16,
  Codex CLI 0.162.0, real turns (`gpt-6.1-sol`, low effort), `codex app-server --stdio`
  with `approval_policy="never"`, `sandbox_mode="workspace-write"`, non-git scratch
  folders. The cwd's `AGENTS.md` reaches the model as a user message `# AGENTS.md
  instructions for <cwd>` before `<environment_context>`, untrusted folders too. With
  Koloft's Assist rule "Do not write or change files (your own memory folder aside)" as
  developer instructions and no `AGENTS.md`, a model told "Remember for next time: …"
  said it could not save across sessions and wrote nothing. With an `AGENTS.md` seeded
  beforehand saying "This file is your memory folder. When the owner asks you to remember
  something, add it here as one short line", the same rule plus Koloft's conductor gate
  (section 27; the butler has run without that gate since ADR-0029, and this was not
  measured again without it): a thread started before the seed and resumed after it
  wrote the fact into `AGENTS.md` with `apply_patch` (`*** Add File: <absolute path>`), and a new thread on a
  new app-server answered it; on resume Codex adds a fresh AGENTS.md message before the
  new turn. `features.memories` (stable, off by default) was tried too: per `CODEX_HOME`,
  run by a background consolidation agent at app-server start, its notes outside the cwd,
  and after two startups a new thread did not recall the fact.
- **`$CODEX_HOME/rules/*.rules` applies to a turn's commands.** 2026-10-16, Codex CLI
  0.162.0, a real turn in a trusted folder of a throwaway `CODEX_HOME` whose
  `rules/default.rules` held `prefix_rule(pattern=["touch"], decision="forbidden")`:
  asked to run `touch made-by-probe.txt`, the command was refused (`policy forbids
  commands starting with \`touch\``) and no file appeared. So a home Koloft makes per
  account sees the owner's own global instructions, skills and command rules only if it
  links them from the owner's home.
- **Developer instructions do not count as the owner asking for sub-agents.** Codex
  ships sub-agents on (`codex features list`: `multi_agent stable true`) but tells the
  model, last in its developer message, `Do not spawn sub-agents unless the user or
  applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or
  parallel agent work` (read with `codex debug prompt-input`). 2026-10-11, Codex CLI
  0.162.0, `codex exec`, gpt-6-astra at low effort, a folder whose README points at two
  files: the same sentence ordering one `explorer` sub-agent per file was given as
  `-c developer_instructions=` (two runs, two wordings: no sub-agent, the model read both
  files itself), as an `AGENTS.md` (the model went to spawn) and in the prompt (the model
  went to spawn). In both spawn runs `--ephemeral` made the spawn itself fail ("no rollout
  found for thread id").
- **`codex exec --json` shows a sub-agent only through the parent's `wait` items**: a run
  that started two sub-agents printed four `collab_tool_call` items, all `tool: "wait"`,
  and no spawn item; each child left its own rollout file under `$CODEX_HOME/sessions`
  that names the parent's thread id. 2026-10-11, Codex CLI 0.162.0, gpt-6-astra.
- **Skills:** a folder under `$CODEX_HOME/skills/<n>/SKILL.md` was listed by
  `skills/list` (scope `user`) and used by the model. `-c 'skills.config=[{path=…}]'`
  with a path to a folder, or to a `SKILL.md`, outside those roots added nothing to
  `skills/list`.
- **`skills/extraRoots/set {extraRoots: [<folder>]}` adds a skills folder for that one
  app-server, and the model gets it.** 2026-10-27, Codex CLI 0.162.0 (model turns, a
  throwaway `CODEX_HOME` holding a copy of this Mac's login, deleted afterwards) and
  0.161.0 (no model turn); a Node client on `codex app-server --stdio`. The method is in
  the schema without `--experimental` on both, and answered `{}` on a connection whose
  `initialize` asked for no experimental API. Afterwards `skills/list` showed
  `koloft` from `<folder>/koloft/SKILL.md` with scope `user`; the rollout's skill list
  named the folder as `r1` beside `skills/.system` as `r0`, and the model, asked for a
  word only the body held, read the file and said it. It works sent before
  `thread/start`, and sent after `thread/start` but before the first `turn/start`: the
  list is built at the first turn. Written in one burst right after `initialized`,
  with `thread/start` next and no wait for its answer, it was answered first and the
  skill reached the rollout, 4 of 4 rounds. A thread started without it and resumed on
  a new app-server that got it first also read the skill. Nothing is kept: the home got
  no `config.toml` and no `skills/koloft`, and a second app-server started on that home
  without the call listed no `koloft`.
  Given Koloft's plugin folder's `skills/` (whose parent holds
  `.claude-plugin/plugin.json` named `koloft`), a real 0.162.0 TUI started by Koloft
  listed the skill as `- koloft:koloft: …` with that folder as `r1`, and the model read
  the file (`agent-tools-real-smoke.spec.ts`, same day).
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
  same call started a turn at once. **The same on 0.163.0, whose notes say a follow-up
  typed in the TUI now steers the running turn** (2026-10-16, the same setup on
  `gpt-6.1-sol`): the reply came in 6 ms, `thread/queue/changed {threadId}` fired on
  add, mid-turn and at the end, the `sleep 20` ran to its end (`durationMs 19879`,
  `status completed`), the first turn answered and completed with no extra
  `userMessage`, the next `turn/started` came 5 ms later on its own with the queued
  `userMessage` (`clientId` as sent) first, and `thread/queue/list` was empty after.
  So a message Koloft queues is not an interrupt. `turn/steer` and `turn/interrupt` are
  methods on 0.161.0–0.163.0 (strings; `codex features list` shows `steer` as removed,
  on, and `instant_interrupt` under development, on since 0.162.1) — neither run.
- **Since 0.166.0 a thread nobody is subscribed to unloads within a minute, and a
  message queued into it then waits until someone resumes it.** 2026-10-30, 0.165.0
  against 0.166.0, a Node client on `codex app-server --stdio` in a throwaway
  `CODEX_HOME` and `HOME` signed in with a copied `auth.json`, `gpt-6-luna`. A thread
  the client stayed subscribed to was still loaded and `idle` after 90 s on both. After
  `thread/unsubscribe`, 0.166.0 sent `thread/closed` and dropped the thread from
  `thread/loaded/list` between 30 s and 60 s later (`thread/read` then `notLoaded`);
  0.165.0 still had it loaded 90 s later. On the unloaded 0.166.0 thread
  `thread/queue/add` still answered `queuedSubmission`, but no turn started in 25 s and
  the message stayed in `thread/queue/list`; the same for `codex queue --thread <id>
  --message …` from another process (exit 0, `Queued message …`). A later
  `thread/resume` ran all three queued messages within 40 s. On 0.165.0 both kinds of
  queued message started a turn within 25 s. Koloft queues only into the thread a live
  tab's TUI holds, through that tab's own stdio app-server; while the TUI reconnects to
  Koloft's relay (section 34) the relay keeps that app-server's connection, or a new
  app-server gets the TUI's `thread/resume` — so Koloft should not meet this (read from
  `codexTransport.ts`, not run on 0.166.0). A queue in the first minute after the
  unsubscribe, and a reconnect slower than a minute, were not run.

## 18. Which command lines open the full-screen TUI

**Read on 2026-09-27 from `codex --help` and each subcommand's `--help`, standalone Codex
CLI 0.153.4; the subcommand and option lists compared again on 0.163.0 and 0.164.0
(2026-10-23, below).** Koloft's Workbench terminal uses this to tell a command that opens
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
  `help`; also `-h`/`--help` and `-V`/`--version` anywhere. 0.164.0 adds
  `migrate-nfs-db` ("[experimental] Migrate configured SQLite databases to DELETE mode
  in place"; it runs and exits, its help says to stop every SQLite client first) and is
  the only change to `codex --help` from 0.163.0: no new top-level option takes a value.
  `mcp-server` is in neither 0.163.0's nor 0.164.0's list, and `codex mcp-server
  --help` prints the top-level help on both, so that word now reads as a prompt there
  (inferred, not run; it stays on Koloft's list for older builds) (2026-10-23, `--help`
  of both builds).
- **Top-level options that take a value** (so the word after them is not a
  subcommand): `-c/--config`, `--enable`, `--disable`, `--remote`,
  `--remote-auth-token-env`, `-i/--image`, `-m/--model`, `--local-provider`,
  `-p/--profile`, `-s/--sandbox`, `-C/--cd`, `--add-dir`, `-a/--ask-for-approval`.
  `-i/--image` takes one or more files; only the first is skipped, so
  `codex -i a.png b.png` reads as a prompt, which opens the TUI anyway.
- That `login` opens no full-screen screen is read off its help text ("Manage login"),
  not checked by running it.
- **Text in the terminal before the TUI starts is gone once it draws.** 2026-10-16,
  Codex CLI 0.162.0 started by Koloft (`--remote`) in a real Electron/xterm tab: a line
  Koloft wrote into the tab before Codex's first output was in neither the screen nor the
  scrollback of the active buffer once the start screen showed
  (`agent-tools-real-smoke.spec.ts` run). Seen again 2026-10-25 on 0.162.0 (a python pty
  answering the terminal's queries, the output replayed into `@xterm/headless`, a scratch
  `CODEX_HOME` with an API-key `auth.json`): the TUI turns on the alternate screen
  (`?1049h`) at once, so the line stays only in the normal buffer behind it. With
  `--no-alt-screen` (a top-level TUI flag, "Disable alternate screen mode") the same line
  stayed on row 0 and Codex drew its whole TUI inline below it. So Koloft, which starts
  Codex on the alternate screen, prints no account line above a Codex tab.

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
  with no tool gave one `final_answer`. The same two, in the same order, on 0.162.1
  (`codex exec`, one `echo` then "DONE", 2026-10-11); that binary also knows a third
  value, `partial_answer` (0.162.0 notes: "a partial answer message phase"), not seen
  on the wire — Koloft reads the text of every `agentMessage` whatever its phase.
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
- **"Implement this plan?" is the TUI's own menu, not a server request.** 2026-10-27,
  codex-cli 0.162.0, `gpt-6-astra` (low effort), a throwaway `CODEX_HOME` with a copied
  login, the real TUI in a python pty (120×40) with `--remote` to a WebSocket relay in
  front of `codex app-server --stdio` that logged every frame, 1 run: `/plan`, a question
  answered by digit, then the model wrote a two-step plan. The turn ended with
  `item/completed` of an item `{type: "plan", id: "<turnId>-plan", text: "1. …\n2. …"}`
  (streamed before as `item/plan/delta`), `thread/status/changed` to `idle` and
  `turn/completed`; then the menu showed ("Implement this plan?", "Yes, implement this
  plan", "No, stay in Plan mode", per the strings also "Yes, clear context and
  implement"), and no frame came from the server. Picking 1 sent `thread/settings/update`
  with `collaborationMode: {mode: "default", …}`, then `turn/start` with the text
  "Implement the plan.". So a client sees the plan only as a finished turn with a `plan`
  item; it cannot answer the menu with a reply.
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
- **The owner's own words go in as "None of the above" plus a note, by keys.** 2026-10-23,
  codex-cli 0.162.0, `gpt-6.1-sol`, the TUI in a pty with `--remote` to a relay shaped like
  Koloft's (WebSocket over TCP here, not Koloft's unix socket) in front of `codex
  app-server --stdio -c features.default_mode_request_user_input=true`, a throwaway
  `CODEX_HOME`. With an `isOther: true` question of 2 options on screen, Down, Down, Tab,
  the words, Enter (each written alone, 300 ms apart) moved to "3. None of the above",
  opened its notes line, filled it and sent `{answers: {<id>: {answers: ["None of the
  above", "user_note: <words>"]}}}`; the history read "answer: None of the above / note:
  <words>", and the model read both.
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
- **In the default mode a newer Codex offers `request_user_input_async`.** 2026-10-12,
  codex-cli 0.162.0, an Assist task Koloft started on this Mac (its own folder, the
  Assist gate as `PreToolUse` hook): the model called a tool named
  `request_user_input_async` with `{questions: [{title, options: ["Done, I’m signed
  in"]}]}`; the hook got that `tool_name`. The gate denied it, and the model asked the
  same thing in plain text instead. With the gate letting it through, the call returned
  `{"accepted":true}` at once, the TUI (over Koloft's relay) drew no question, and the
  model then called `sleep` (`{duration_ms: 60000}`, hook `tool_name` `clocksleep`) to
  wait for an answer. So it does not wait for the owner the way AskUserQuestion does;
  where its answer would arrive was not probed.
- **`features.default_mode_request_user_input=true` makes the waiting question work in
  the default mode.** 2026-10-12, codex-cli 0.162.0, a Node client on `codex app-server
  --stdio` (`experimentalApi: true`), a throwaway `CODEX_HOME`, real turns on two
  models. `codex features list` shows the flag `under development`, off (still so on
  0.164.0, 2026-10-23, and `config/read` reads it back `true` when set). With it, 3 of 3
  turns asked through `request_user_input` (2 of them not told which tool): the server
  sent `thread/status/changed` with `activeFlags: ["waitingOnUserInput"]` and
  `item/tool/requestUserInput` shaped as above but with `isBlocking: false`; the turn
  stayed open until the client answered 15 s later, then went on with the answer.
  Without it, the call came back "request_user_input is unavailable in Default mode".
  Either way a `PreToolUse` hook got `tool_name: "request_user_input"` with the whole
  `questions` array, before the server refused or raised it. The model's tool list held
  `request_user_input`, `request_user_input_async` and `sleep` with or without the flag.
  The same day, through Koloft itself (an Assist task with the flag and the gate, the
  real TUI over `--remote`): the model called `request_user_input` with two options and
  the TUI drew it as a question the owner could pick by digit. In one run whose brief
  still allowed a plain-text question, the model asked in plain text instead; told to
  ask every question with that tool, it did. What `isBlocking: false` changes is below.
  The same on 0.163.0 (2026-10-16, the flag on, `on-request` / `read-only`):
  `waitingOnUserInput`, then `item/tool/requestUserInput` (`isBlocking: false`,
  `autoResolutionMs: null`), the turn waited 10 s for the answer, then
  `serverRequest/resolved {threadId, requestId}` came, the flags cleared and the turn
  completed with the picked option; `default_mode_request_user_input` is still under
  development, off, on 0.161.0–0.163.0.
- **Several questions and free text, with the flag on.** 2026-10-16, Codex CLI 0.162.0,
  `gpt-6.1-sol`, `features.default_mode_request_user_input=true`, an app-server client as
  in section 27. Asked for two questions in one call, the model sent one request with
  `questions: [{id: "colour", …}, {id: "size", …}]`, each `isOther: true`, two options,
  `isBlocking: false`; `{answers: {colour: {answers: ["Blue"]}, size: {answers:
  ["Large"]}}}` gave "You prefer blue and large." A string that is not an option,
  `{colour: {answers: ["Purple with green stripes"]}}`, was repeated back word for word.
  `["Red", "user_note: but only dark red, like wine"]` came back as "Red but only dark
  red, like wine". That the TUI's notes field sends that `user_note: ` prefix is inferred
  from a string in the binary, not seen on the wire. Each time: `waitingOnUserInput`,
  then `serverRequest/resolved`, then the turn went on.
- **`isBlocking: false` means the TUI answers it with nothing after 120 s.** 2026-10-24,
  codex-cli 0.162.0, `gpt-6.1-sol`, `features.default_mode_request_user_input=true`, a
  throwaway `CODEX_HOME` with a copied login, one question (Red / Green) left unanswered,
  1 run each way. The full-screen `codex --no-daemon` alone in a python pty: the
  `function_call_output` was `{"answers":{}}` 120.0 s after the call, and the screen showed
  "auto-resolves in 1m 00s" in the last minute. The same through Koloft's relay (a
  scheduled run in the hand-test sandbox): the app-server's own log said `<- response:
  ToolRequestUserInput { request_id: Integer(0), response: ToolRequestUserInputResponse {
  answers: {} } }` from `client_name="codex-tui"` at 120.05 s; the model then said
  "Awaiting your answer." and the turn completed. A Node client on a bare `codex
  app-server --stdio` that never answered saw no `serverRequest/resolved` and no
  `turn/completed` in 300 s. So the countdown lives in the TUI, not the server; the model's
  instructions say "If `request_user_input` returns no answers, continue with best
  judgment". **A Plan-mode question does not count down.** 2026-10-27, codex-cli 0.162.0,
  `gpt-6-astra` (low effort), the flag on, a throwaway `CODEX_HOME` with a copied login,
  the real TUI in a python pty (120×40) with `--remote` to a WebSocket relay in front of
  `codex app-server --stdio` that logged every frame, 1 run: `/plan`, then a prompt asking
  one Red / Green question. The request came with `isBlocking: true, autoResolutionMs:
  null`; the screen drew no "auto-resolves", the TUI sent nothing for 150 s, and a digit
  then answered it as usual. No config key or request field that lets a client make a
  default-mode question blocking was found: `isBlocking` and `autoResolutionMs` show up in
  the 0.162.0 strings only as fields of the question event and request. **The TUI goes by
  the `isBlocking` it is sent, so a relay that sets it to `true` stops the countdown.**
  Same day and setup, default mode, 1 run: the app-server sent `isBlocking: false`, the
  relay passed the request on with `isBlocking: true`; the TUI drew no countdown, sent
  nothing for 150 s, and a digit then answered it (`serverRequest/resolved`, the turn went
  on with the pick); the answer frame is the same either way. A second run, same setup:
  Down, Down, Tab, the words, Enter (300 ms apart) on such a rewritten question sent
  `{answers: {colour: {answers: ["None of the above", "user_note: Purple with dots"]}}}`,
  as on a non-blocking one, and the model repeated the words. Not probed: Esc on it, and
  whether a non-null `autoResolutionMs` counts down on its own.
- **Several questions by keys: one answer per question, the last one sends them all.**
  2026-10-29, codex-cli 0.162.0, the full-screen `codex --no-daemon` in a python pty
  (120×40, screen read through `pyte`), a throwaway `CODEX_HOME` whose `config.toml` points
  `model_provider` at a fake Responses server on localhost (`wire_api = "responses"`, no
  login), `features.default_mode_request_user_input=true`; the fake answered the first turn
  with a `request_user_input` call of two questions (ids `fruit` and `size`, two options
  each, no `isOther` sent by the fake) and logged the next request. The TUI drew
  "Question 1/2 (2 unanswered)", each question with `3. None of the above` and "tab to add
  notes | enter to submit answer | ←/→ to navigate questions". A digit on question 1 moved
  to "Question 2/2 (1 unanswered)" ("enter to submit all"). Two runs, keys 300–400 ms
  apart: `2`, then Down, Down, Tab, `Medium please`, Enter sent `{"answers":{"fruit":
  {"answers":["Banana"]},"size":{"answers":["None of the above","user_note: Medium
  please"]}}}`; Down, Down, Tab, `A ripe mango`, Enter on question 1, then `1`, sent
  `{"size":{"answers":["Small"]},"fruit":{"answers":["None of the above","user_note: A ripe
  mango"]}}`. So Koloft answers each question in turn by its own keys, with nothing after
  the last.
- Not probed: `isSecret`, a form with several fields or a field that is not an enum, and
  an elicitation `mode` other than `form`.

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
  as Alt+Enter and adds a line; 30 ms apart works. Rechecked 2026-10-19 on Codex CLI
  0.162.0 (`codex --no-daemon` in a python pty, a temporary `CODEX_HOME` holding a fake
  API key, the screen read through `pyte`): `/status` then `\x1b\r` in one write left
  `› /status` in the composer, unsent; a lone CR 2 s later ran it.
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
- **What a slash command prints is written to no file; only `/diff`'s text crosses the
  wire** (2026-10-26, Codex CLI
  0.162.0, a real `codex --remote` TUI in a python pty, 120×40, the screen read through
  `pyte`, on a Node relay in front of `codex app-server --stdio` that logged every line; a
  temporary `CODEX_HOME` whose model was a fake Responses-API server on localhost, no
  login; one model turn, then `/status`, `/diff` and `/mcp`, each typed, Esc, Enter). The
  screen showed each answer, but none of its words were in the rollout file,
  `history.jsonl`, `state_5.sqlite`, `thread_history_1.sqlite` or `logs_2.sqlite` (their
  `-wal` files too), where the turn's reply was. On the wire: `/status` sent nothing
  (without a login there were no limits to ask for); `/mcp` sent
  `mcpServerStatus/list`, whose reply is data, not the drawn text; `/diff` sent five
  `command/exec` requests (`git rev-parse --is-inside-work-tree`, two `git config` reads,
  `git … diff --no-textconv --no-ext-diff --submodule=short --ignore-submodules=dirty
  --color`, `git ls-files --others --exclude-standard`), and the `diff` reply's `stdout`
  held the diff the pager showed, colour codes included.
- **Esc at an idle prompt**: one shows "esc again to edit previous message"; a second
  one opens "Browsing transcript", where Enter rewinds.
- **Queued messages and idle**: two `thread/queue/add` sent during a turn ran as two
  more turns, one each, right after it; between turns the thread status went `idle`
  and `active` again within 3–4 ms. Each queued `userMessage` item carried the
  `clientUserMessageId` as `clientId`, and `thread/queue/list` was empty as soon as the
  last one's turn started.
- **The popup on 0.163.0 has 55 entries; `/config` and `/daybreak` are the ones 0.162.1
  lacks** (2026-10-16, `codex --no-daemon` in a python pty, each list scrolled; `/keymap`,
  `/daemon` and `/side` are on both). `/keymap` names a "Global Leader ctrl-x"
  (`tui.keymap.global.leader`, default `ctrl-x`), "Chat Interrupt Turn esc", "Composer
  Queue tab" and "Toggle Side Conversation ctrl-/" among 153 actions (§25).

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
- **A fresh standalone install links `~/.local/bin/codex` and adds that folder to PATH
  in `~/.zprofile`** (a block between `# >>> Codex installer >>>` markers), so `zsh -l -c`
  and `zsh -l -i -c` both find `codex` right after it. (2026-10-11, 0.162.1, macOS 27:
  `curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh` under
  `zsh -l -i` with a fresh temporary `HOME`, `CODEX_HOME` unset.)

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
  checks of PR #3 in its composer unsent …"). Both paste cases passed again on 0.162.1
  (the npm package, 2026-10-11).
- The paste over ssh and tmux is not probed for Codex.
- **A picture path in the message is opened when the question needs it.** Measured
  2026-10-28, Codex CLI 0.162.0, `codex exec -s read-only` with Koloft's element-pick
  text (its `Picture:` line names a PNG of a canvas with the word ZEBRA drawn on it; the
  word nowhere in the text) and "What word is drawn in the picked element? Answer with
  the word only.": it answered `ZEBRA`. The interactive TUI was not used for this: on
  start it asked "Background server has incompatible feature settings" with a "Restart
  with these settings" choice that would reach the other Codex sessions on the same Mac.

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

Rechecked 2026-10-25 on this Mac with Codex CLI 0.162.0, and the schema,
`thread/searchOccurrences` and `thread/turns/list` again with 0.161.0 (`npm install
@openai/codex@0.161.0` into a scratch folder): the same Node client and scratch `CODEX_HOME`, one real turn in a work
folder named `work-quokkadir77`, then one in a folder holding an `AGENTS.md` with the
marker `pangolinrule55`.

- **`thread/search` matches every user-role message in the rollout, Codex's own too**:
  `quokkadir77` (only in the folder name), `zsh`, `2026`, `timezone` and `Los_Angeles`
  each hit the thread with a snippet cut from `<environment_context> <cwd>…</cwd>
  <shell>zsh</shell> <current_date>…</current_date> <timezone>…</timezone> …`, and
  `pangolinrule55` hit with a snippet from `# AGENTS.md instructions for <folder>
  <INSTRUCTIONS> … </INSTRUCTIONS>`. The developer-role messages (`<skills_instructions>`,
  `<multi_agent_role>`) are not searched: `SKILL.md`, `multi_agent_role`, `sub-agents`
  returned nothing. Its params have no filter that leaves these blocks out.
- **`thread/searchOccurrences { threadId, searchTerm, cursor, limit }` matches only the
  person's typed messages and the model's answers** (its schema: "visible user messages
  and both partial and final assistant answers"), and answers `{ data: [{ turnId,
  itemId, snippet, snippetMatchRange: { start, end }, turnCursor }], nextCursor }`, the
  range in UTF-16 units inside the snippet (`zebrafinch42`, at the end of the prompt,
  came back as `... ban" followed by … Marker: zebrafinch42`). `quokkadir77`, `zsh` and `pangolinrule55` gave `data: []`; `BANJO`,
  `zebrafinch42` and `ban` each gave the line they are in. After the first call on a
  fresh app-server (20–200 ms) each call took 0.3–1 ms on these threads, and 75–160 ms on
  one thread with 40,000 extra rows (220 MB of JSON) written straight into its
  `thread_history_1.sqlite` table.
- **It reads the per-thread index in `thread_history_1.sqlite`, not the rollout, and a
  thread missing from that index answers `data: []` even for a word it holds**: with the
  thread's rows and `thread_history_projection_state` row deleted, and again with the
  rollout copied into an empty `CODEX_HOME`, `banjo` gave `[]`, as did `thread/read`
  (`turns: []`) and `thread/turns/list { threadId, limit: 1 }` (`data: []`), while
  `thread/search` still found it. `thread/resume` built the index: afterwards all three
  answered. `thread/turns/list` with `limit: 1` answers one turn for an indexed thread, so
  an empty answer tells a thread Codex has not indexed; for an id Codex does not know it
  errors `-32600 "thread not loaded: <id>"`. Nothing in the thread object
  `thread/search` returns tells the two apart. A real home on this Mac had 13 of its 68
  unarchived threads (all `source: vscode`, all with turns) outside the index.
- Not probed: whether Codex later indexes such threads on its own.

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
- **Mouse and focus reports:** on its welcome screen (2026-10-13, 0.162.0, a scratch
  `CODEX_HOME`, otherwise as above) the TUI sent both `h` and `l` for 1000, 1002, 1003
  and 1006, and only `?1004h` (focus reports); the order was not recorded. What it does
  with a cut mouse report was not run.
- Not run: the same keys through ssh and tmux, since Koloft starts no remote Codex tab
  (§16).
- **A bare `codex` may stop on a "Background server has incompatible feature settings"
  dialog** (choices "Run without daemon this time" / "Restart with these settings"),
  which is why probes run `codex --no-daemon`; `codex features list` shows
  `daemon_auto_start stable true` on 0.162.1, and 0.162.1's notes say the check now
  fires only for explicit command-line feature overrides. `--no-daemon` is refused with
  `--remote` ("--no-daemon cannot be used with --remote"), and Koloft's TUI, which
  connects with `--remote` to Koloft's own app-server, showed no such dialog in the
  real-binary e2e cases on 0.162.1 (2026-10-11) or 0.163.0 (2026-10-16). Strings read
  the same day; the dialog itself was not raised.
- **Since 0.163.0 the TUI tells its terminal what it is doing with OSC 7501, with no
  query first** (2026-10-16, `codex --no-daemon -c check_for_update_on_startup=false` in
  a python pty at 100×40 on 0.162.1 and 0.163.0, the raw bytes saved, two env shapes:
  Koloft's — `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Apple_Terminal`,
  no `TERM_SESSION_ID` — and the same without `TERM_PROGRAM`; also a TUI under
  `--remote`): 0.163.0 writes `ESC ] 7501 ; state=idle:app=codex ESC \` about 1.6 s in,
  `state=working:app=codex` 30 ms after a typed CR, `state=idle:app=codex` when the
  answer ends, and `state=clear` at exit — unasked (there is no `7501;?` query in the
  binary), the same with or without `TERM_PROGRAM`, and under `--remote`. The strings
  also name `blocked` (not seen) and an iTerm2 `OSC 21337;status=…` (not seen).
  Unlike Claude Code's (CC§12: query-gated, with `id` and `kind`), it carries only
  `state` and `app`. 0.162.1 writes none of it. Koloft's terminal does not handle 7501
  for either CLI (issue #487). The startup and exit sequences are otherwise the same on
  both versions and both env shapes (on 0.166.0, 2026-10-30, Koloft's env shape, too,
  except that the `?u` and DA1 queries now come before `6n`): `?2004h`, `>7u`,
  `?1004h`, the `6n`, OSC 10/11 and `?u`/DA1 queries, `?1049h`, `?1007l`, then `?1000h ?1002h ?1003h ?1006h`; at exit
  `?1006l ?1015l ?1003l ?1002l ?1000l <1u ?1007l ?1049l <u ?2004l ?1004l` — so the
  mouse modes are set at start and reset at exit, not both on the welcome screen as the
  bullet above says from 2026-10-13. No XTVERSION query is sent. 0.163.0's strings drop
  `TERM_SESSION_ID` from the terminal-detection env list (`ITERM_SESSION_ID` stays);
  `TERM_PROGRAM` and `Apple_Terminal` are still named, and nothing the TUI wrote differed
  with `TERM_PROGRAM` set.
- **Ctrl+X (0x18), the leader key 0.163.0 adds, shows nothing at the idle composer in
  3 s**; a following Esc shows "esc again to edit previous message". One Ctrl+C at an
  empty composer quits at once (both versions). What Ctrl+X followed by another key does
  was not run; Koloft itself never sends 0x18 (a conductor's `koloft session keys` would
  have to name it).

## 26. Reaching the Workbench browser: sandbox, MCP servers and their environment

**A command in the sandbox cannot reach 127.0.0.1; an MCP server can.** Checked
2026-10-04 with Codex CLI 0.159.3, Node 24.13.0, a fresh temporary `CODEX_HOME` and `HOME`
each run, a dummy API key (`codex login --with-api-key`), no model turn. A Node script
started a small WebSocket server on `127.0.0.1:<port>` and ran `codex sandbox [flags] --
node client.mjs ws://127.0.0.1:<port>`:

| sandbox | result |
|---|---|
| no flags (default config) | exit 2, the client's socket failed, the server saw nothing |
| `workspace-write` | same |
| `read-only` | same |
| `workspace-write --log-denials` | same, and "Sandbox denials: None found." |
| `workspace-write` + `sandbox_workspace_write.network_access=true` | exit 0, ping and pong went through |

The same script then wrote an `[mcp_servers.probe]` entry (a tiny stdio MCP server that
opens the WebSocket and logs its environment) into `config.toml`, started `codex
app-server` with `PROBE_VAR` and `PLAYWRIGHT_MCP_CDP_ENDPOINT` in its environment, and sent
`initialize`, `initialized` and `thread/start` (`sandbox: "workspace-write"`,
`approvalPolicy: "on-request"`). The MCP server reached the socket (it runs outside the
sandbox) but saw **neither variable**: Codex hands an MCP server a cleaned environment.
`env_vars = ["PLAYWRIGHT_MCP_CDP_ENDPOINT"]` on the entry, in `config.toml` or as
`-c mcp_servers.probe.env_vars=[…]` on the app-server, passed that one variable through.

**What Koloft builds on, checked 2026-10-10** with Codex CLI 0.162.0, `@playwright/mcp`
0.0.83 (installed into a scratch folder), Node 24.13.0, a fresh temporary `CODEX_HOME` and
`HOME`, a dummy API key, no model turn. The `config.toml` held `[mcp_servers.playwright]`
(`command` = node, `args` = [`…/@playwright/mcp/cli.js`, `--headless`], `env_vars =
["OWNER_VAR"]`) and a second entry running `/bin/cat`. A headless Chrome stood behind a
small WebSocket forwarder on 127.0.0.1 that, like Koloft's relay, refused a second client
while one was connected ("this endpoint already has a client").

- `config/read` (`{cwd}`) answered `config.mcp_servers` keyed by entry name, each with
  `command`, `args`, `env_vars` (only when set), `enabled`, `environment_id` and
  `tool_timeout_sec`. It took 50–270 ms on a fresh app-server.
- `-c mcp_servers.playwright.env_vars=["OWNER_VAR","PLAYWRIGHT_MCP_CDP_ENDPOINT","PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS"]`
  **replaces** the entry's list (so Koloft repeats the owner's names in it); `config/read`
  then showed the three names.
- `mcpServer/tool/call` (`server`, `threadId`, `tool`, `arguments`) ran
  `browser_navigate` on a `data:` page with no model turn; the page title came back and
  the forwarder saw one connection. So the real `@playwright/mcp` drove the browser at the
  endpoint the app-server's environment named.
- **One MCP server process per thread.** After `thread/start` for thread A, one
  `@playwright/mcp` process ran under the app-server; after a second `thread/start` (B), two.
  B's first `browser_navigate` opened a second connection, which the forwarder refused, and
  the tool answered "Target page, context or browser has been closed … this endpoint
  already has a client". `thread/unsubscribe` of A (what `/new` and `/clear` send after
  their `thread/start`, §21) answered `unsubscribed`, but A's process and its connection
  stayed **about 60 s**; once it had exited, B's `browser_navigate` connected and worked.
  When the forwarder instead closed A's connection itself (code 1008) right after B's
  `thread/start`, B's first `browser_navigate` connected and worked at once, and A's
  process did not connect again by itself (two connections in all).
- **`-c` keys: bare names only.** `-c 'mcp_servers.pw-dash.env_vars=["C"]'` worked;
  `-c 'mcp_servers."my.pw server".env_vars=[…]'` stopped the app-server at start ("invalid
  transport in `mcp_servers."my`"): the flag splits its key on every dot, quotes or not.
- Not tried: a child agent's thread (it needs a model turn) — that it, too, gets its own
  MCP server process, and so is refused while its parent's holds the endpoint, is
  **inferred, not checked**; and that `env_vars` takes only names (no other entry shape)
  is **inferred, not checked**.

**With a model turn, inside a Koloft tab, checked 2026-10-10** with Codex CLI 0.162.0 (its
default model), `@playwright/mcp` 0.0.83 run as `playwright-mcp --headless`, a Koloft
`codex-home` account, the tab on Codex's own default permissions
(`agent-tools-real-smoke.spec.ts` › "a real Codex reads a page title…"):

- Asked to navigate to a local page and reply with its title, Codex called
  `playwright.browser_navigate`; the tool result began `Page Title: <title>` and the reply
  was the title alone. The rollout records the call as an `item_completed` event whose item
  is `{"type":"McpToolCall","server":"playwright","tool":"browser_navigate",…}`.
- Before the first call in each thread Codex stops on its own question,
  `Allow the playwright MCP server to run tool "browser_navigate"?`, options `1. Allow`,
  `2. Allow for this session`, `3. Always allow`, `4. Cancel`. Unanswered, the turn waits.
  It asked again in the thread `/new` started.
- The page loads were made by the Workbench guest (the same user agent as the guest's own
  load, a plain Chrome string with no `Electron/` and no `HeadlessChrome`); in some runs the
  MCP navigated the tab already open, in others it opened a second tab marked "agent
  driving".
- After `/new`, the new thread's first `browser_navigate` worked at once.
- The same case passed on 0.162.1 (2026-10-11), `/new` included.

**A shell command in the sandbox reaches the browser with two settings, checked
2026-10-11** with Codex CLI 0.162.0, @playwright/cli 0.1.22 run on Electron 43.7.3's Node
(PLATFORM§42), a fresh temporary `CODEX_HOME`, and a `HOME` outside `/tmp` and `$TMPDIR`
so its folders were not writable by default.

- Through `codex app-server`'s `command/exec` (no model turn; the command ran under the
  configured policy) against a headless Chrome's CDP endpoint on 127.0.0.1:
  - `sandbox_mode="workspace-write"` alone: `playwright-cli open` failed, `connect EPERM
    127.0.0.1:<port>`.
  - plus `sandbox_workspace_write.network_access=true`: the CLI's daemon stopped first on
    `EPERM … mkdir '<HOME>/Library/Caches'` — it keeps its session files under
    `~/Library/Caches/ms-playwright/daemon/<hash>` and also writes
    `~/Library/Caches/ms-playwright/b/browser@<hash>`, so `writable_roots` set to
    `…/ms-playwright/daemon` alone still failed, on `ms-playwright/b`.
  - plus `writable_roots=["<HOME>/Library/Caches/ms-playwright"]` (the folder made
    beforehand, outside the sandbox): `open`, `eval document.title`, `screenshot` and
    `close` all worked; the daemon's unix socket under `$TMPDIR/pw-<hash>/cli/` needed
    nothing more, since `workspace-write` leaves `$TMPDIR` writable.
  - With the network on, `curl https://example.com` from the same sandbox answered 200:
    `network_access` opens the internet too, not only 127.0.0.1. No proxy variable was
    set.
- **`-c sandbox_workspace_write.writable_roots=[…]` replaces the list in `config.toml`**:
  with `["/tmp/owner-root"]` in `config.toml` and `-c …=["/tmp/koloft-root"]` on the
  app-server, `config/read` showed only `/tmp/koloft-root`.
- **`codex sandbox` is no stand-in for a session on 0.162**: it now refuses to run
  without `-P/--permission-profile`, and under `-P :workspace` the legacy
  `sandbox_workspace_write.network_access=true` was ignored (TCP to 127.0.0.1 still
  EPERM).
- **Real model turns through Koloft** (a dev build in a scratch `HOME`, the relay of the
  tab's own Workbench, a Koloft `codex-home` account whose `config.toml` held only the
  folder's trust table, a tab opened from the sidebar's ＋, so no `-a`/`-s` on the TUI):
  - With the two settings given to the tab's app-server only, the turn's `turn_context`
    read `on-request` / `workspace-write` with `network_access: true` and that one extra
    writable root. The model ran `playwright-cli open <url>`, `eval document.title`
    and `echo "$PLAYWRIGHT_CLI_SESSION"` in one command; the title came back, the page
    load came from the Workbench guest, and the session name was `koloft-<tab id>`, with
    no question to the owner. So a default ＋ tab runs `workspace-write`, and the
    app-server's `-c` reaches the turn's sandbox with no flag on the TUI.
  - Without them (`network_access: false`) the same command failed with `connect EPERM`,
    and Codex then asked "Would you like to run the following command? … Allow the
    requested Playwright commands to connect to the local browser outside the sandbox?"
    with only `1. Yes, proceed` and `2. No` — no "always" choice. With `1` it ran outside
    the sandbox and read the title.
  - An earlier run with the same settings written in `config.toml` read the title, waited
    20 s past the turn's end, and in the next turn `eval document.title` still answered
    from the same daemon: a detached daemon started by a turn's command outlives the turn.
  - Inside the sandbox each CLI start printed Electron's `codesign_util.cc …
    task_name_for_pid` line on stderr (PLATFORM§42); one reply quoted it back.
- **The same holds with approvals off, as an Assist runs.** 2026-10-11, codex-cli 0.162.0,
  `codex exec -s workspace-write -c approval_policy="never"` in a temp folder, a model
  turn asked to `curl` a local HTTP server on 127.0.0.1: without
  `sandbox_workspace_write.network_access=true` curl failed to connect and the server saw
  nothing; with it the server answered and saw one request.
- Not tried: a `read-only` thread (`network_access` belongs to `workspace-write` only, so
  the CLI is refused there — **inferred, not checked**), and a user on the newer
  `default_permissions` profiles, which the `-P` result suggests ignore these legacy keys
  — **inferred, not checked**.
- **MCP tool approval, and `approve`.** 2026-10-16, codex-cli 0.162.0, app-server driven by
  a Node script, a tiny stdio MCP server (one tool `ping`) given as `-c
  mcp_servers.probe.command=…`/`args=[…]`, real model turns asked to call it:
  - `on-request`: the first call in each new thread sent `mcpServer/elicitation/request`
    with `mode: "form"`, `message: "Allow the probe MCP server to run tool \"ping\"?"`,
    `_meta: {codex_approval_kind: "mcp_tool_call", persist: ["session","always"], …}`;
    `{action:"accept"}` ran it. A second thread on the same app-server asked again.
  - `never` (an Assist): no request; the call failed with `MCP tool call requires
    approval, but approval policy is never`.
  - `-c mcp_servers.<name>.default_tools_approval_mode="approve"` (values `auto`, `prompt`,
    `writes`, `approve`): the call ran with no request under `on-request` and under
    `never`.
- **A failed `config/read` drops every browser setting at once**: Koloft builds
  `network_access`, the Playwright cache root and the `env_vars` passthrough from one
  `config/read`, so a read lost to section 28's race leaves a tab with no network (unless
  a git account's pick gives it, section 29) and no CDP endpoint for the MCP server.

## 27. Hooks on one app-server, and their trust

**Checked on 2026-10-11 with standalone Codex CLI 0.162.0.** Node scripts drove
`codex app-server --stdio` (`initialize` with `experimentalApi: true`, `initialized`,
`hooks/list {cwds:[<folder>]}`, then `thread/start` or `thread/resume` and real model
turns), each in a throwaway `CODEX_HOME`, with the hook given only as
`-c hooks.PreToolUse=[{hooks=[{type="command",command="…"}]}]` on the app-server's
command line. The hook command was a small Node script that logged its stdin.

- **It fires before each of these tools**, with `tool_name`: `Bash` (shell),
  `apply_patch`, `mcp__<server>__<tool>`, `collaborationspawn_agent` and
  `collaborationwait_agent`. Its stdin is one JSON object: `session_id`, `turn_id`,
  `transcript_path`, `cwd` (the thread's folder), `hook_event_name: "PreToolUse"`, `model`,
  `permission_mode`, `tool_name`, `tool_input`, `tool_use_id`. For `apply_patch`,
  `tool_input.command` is the whole patch (`*** Begin Patch` … `*** End Patch`), and its
  `*** Add File:` paths were relative to `cwd` (`*** Add File: note.txt`).
- **Claude Code's deny shape is honoured**: printing
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`
  stopped the call, and the model quoted the reason back word for word. It held under
  `approval_policy="never"` with `sandbox_mode="workspace-write"`, on `thread/start` and on
  `thread/resume`. Other built-in tools (`web_search`, `view_image`, `update_plan`) were not
  probed.
- **The hook lists as `/<session-flags>/config.toml:pre_tool_use:0:0`**, `source:
  "sessionFlags"`, `eventName: "preToolUse"`, `command` exactly as given, with a
  `currentHash` (`sha256:…`) and a `trustStatus`: `untrusted` with no entry, `modified`
  with an entry for another hash, `trusted` with a matching one. An untrusted hook does not
  run and nothing says so (section 17 for SessionStart).
- **Trust is a table in the home's `config.toml`**:
  `[hooks.state."<key>"]` then `trusted_hash = "<currentHash>"`. A second table for the
  same key made the whole file unreadable for hooks: `hooks/list` answered `hooks: []` and
  `errors: [{…, message: "…config.toml:14:14: duplicate key"}]`. A home whose
  `config.toml` is a symbolic link to a shared file reads the table through the link.
- **The hash follows the command string alone**: the same command under two different
  config file keys had the same hash, and `sh "$KOLOFT_CODEX_GATE"` kept
  `sha256:f74c4b76…` when `KOLOFT_CODEX_GATE` pointed at another path. So builds that put
  their own script path in the environment share one trust entry.
- **A `$NAME` in the command is expanded by a shell from the app-server's environment**:
  `sh "$KOLOFT_PROBE_GATE"` given as a SessionStart hook ran the script that variable
  named. The hook also saw every other variable of the app-server's environment.
- **The trust is read again on each ask**: a table written while the app-server ran made
  the next `hooks/list` on that same server say `trusted`; a second app-server started
  after the write, with the same `-c` and another value of the variable, said `trusted` on
  its first ask.
- **`hooks/list` needs the connection's own `initialize`**: sent first it answered
  `{"code":-32600,"message":"Not initialized"}`, and a second `initialize` on a connection
  that already had one answered `{"code":-32600,"message":"Already initialized"}`. A stdio
  app-server has one connection, and Koloft's TUI sends its own `initialize` through it
  (section 1), so Koloft cannot ask the tab's own app-server before its TUI connects; it
  asks a second app-server started with the same command line, environment and folder.
- **An owner's own PreToolUse hook in `config.toml` stays next to the one given with `-c`.**
  2026-10-11, codex-cli 0.162.0, temp `CODEX_HOME`, no model turn: with
  `[[hooks.PreToolUse]]` … `command = "echo owner-hook"` in `config.toml` and
  `-c hooks.PreToolUse=[…sh "$KOLOFT_CODEX_GATE"…]` on the command line, `hooks/list`
  listed both — `source: "user"` with key `<config path>:pre_tool_use:0:0`, and
  `source: "sessionFlags"` with key `/<session-flags>/config.toml:pre_tool_use:0:0` — and
  trusting the second left the first `untrusted`.
- **Codex keeps the trust table when it rewrites `config.toml` itself.** Same run:
  `config/value/write {keyPath:"model", value:"gpt-6", mergeStrategy:"replace"}` rewrote
  the file (`model = "gpt-6"`), kept the owner's hook and the
  `[hooks.state."/<session-flags>/config.toml:pre_tool_use:0:0"]` table byte for byte, and
  the next `hooks/list` still said `trusted`.
- Not probed yet: a real TUI connected over `--remote` to the hooked app-server, and
  whether both PreToolUse hooks run in one turn (each needs a model turn, so a signed-in
  account).

**All twelve events, checked on 2026-10-16 with standalone Codex CLI 0.162.0, real model
turns (`gpt-6.1-sol`, `effort: "low"`).** A Node client drove `codex app-server --stdio`
(`initialize` with `experimentalApi: true`) in a throwaway `CODEX_HOME` (a copy of this
Mac's login, deleted afterwards; the folder trusted), each hook given as
`-c hooks.<Event>=[{hooks=[{type="command",command="node <script> <Event>"}]}]` and
trusted with its `[hooks.state."<key>"] trusted_hash` table. The event list and the
stdin/stdout shapes were also read from the binary, which embeds a JSON schema per event
(`<event>.command.input` / `.command.output`).

- **The events are exactly** `PreToolUse`, `PermissionRequest`, `PostToolUse`,
  `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`,
  `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt` (no `Notification`). Each lists in
  `hooks/list` as `/<session-flags>/config.toml:<snake_case event>:0:0` and needs its own
  trust table. **0.164.0 adds `PreModelRequest` and `PostModelRequest`** (2026-10-23,
  one `gpt-6-luna` turn, each trusted with its own table): one pair per model request;
  stdin `session_id`, `turn_id`, `cwd`, `transcript_path`, `model`, `hook_event_name`,
  and on Post also `status`, `error` and `token_usage` (`input_tokens`,
  `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`,
  `reasoning_output_tokens`, `total_tokens`). Upstream says their output cannot stop or
  change the request. Koloft hooks neither.
- **Every stdin carries** `session_id`, `transcript_path`, `cwd`, `hook_event_name`,
  `model`; all but `SessionStart`/`SessionEnd` add `turn_id`. `UserPromptSubmit` adds
  `prompt`; `PostToolUse` adds `tool_name`, `tool_input`, `tool_use_id`, `tool_response`
  (for `Bash` the output as one string); `Stop` adds `stop_hook_active`,
  `last_assistant_message`. **Since 0.166.0 the `cwd` of `PreToolUse` and `PostToolUse`
  is the command's own folder**: a command the model ran in `work/sub` gave `…/work/sub`
  there, where 0.165.0 gave the thread's `…/work`; the keys and the order of the four
  events were the same on both (2026-10-30, one `gpt-6-luna` turn per build, throwaway
  homes). The reply-language and hold hooks read no `cwd`; the look at the folder
  around a shell command reads it.
- **Two hooks for one event go in one `-c`, as two groups.** 2026-10-30, codex-cli
  0.166.0, `codex app-server` in a throwaway `CODEX_HOME`, no turn, `hooks/list` only:
  `-c hooks.PreToolUse=[{matcher="Bash",hooks=[…]},{matcher="Bash",hooks=[…]}]` listed
  both, keyed `…config.toml:pre_tool_use:0:0` and `…:pre_tool_use:1:0`
  (`<event>:<group>:<hook>`), each with its own hash and trust.
- **When each fires:** `SessionStart` at the first turn after `thread/start`,
  `thread/resume` or a compaction, not at `thread/start` itself. `UserPromptSubmit`, then
  `PreToolUse`/`PostToolUse` around each tool, then `Stop` at the end of each turn.
  `SessionEnd` ran when the app-server exited, not on `thread/unsubscribe`. A sub-agent's
  tool calls ran `PreToolUse`/`PostToolUse` with the parent's `session_id` plus
  `agent_id`/`agent_type`; no `SessionStart`, `UserPromptSubmit` or `Stop` ran for the
  child.
- **`hookSpecificOutput.additionalContext` reaches the model** from `SessionStart`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `SubagentStart`: "Always end your
  reply with the word X" made the reply end with X each time. It is saved in the rollout
  as a `developer` message.
- **A blocked `Stop` keeps the same turn going.** 2026-10-20, codex-cli 0.162.0,
  `gpt-6.1-sol` low effort, the same Node client and throwaway `CODEX_HOME`, one real turn
  whose `Stop` hook printed `{"decision":"block","reason":"<text>"}` once: one
  `turn/started` and one `turn/completed` with one turn id; no `idle` status in between;
  after the first answer `hook/completed` `status: "blocked"`, then an item
  `{type: "hookPrompt"}` carrying `<text>`, then a second `final_answer` that obeyed
  `<text>`, then `Stop` ran again (`"stop_hook_active":true`, compact JSON; the first had
  `false`) and the turn completed.
- **`Stop` with `{"decision":"block","reason":"…"}` makes the model go on**, and
  **`PermissionRequest`** answering `{"decision":{"behavior":"allow"}}` runs the command with
  no request reaching the client (`deny` stops it).
- **An owner's own `UserPromptSubmit` hook in `config.toml` stays next to one given with
  `-c`**, as for PreToolUse above (2026-10-16, no model turn: `hooks/list` listed both).
- **Hooks run outside the sandbox.** 2026-10-16, a real turn in an untrusted folder
  (`sandbox: {type: "readOnly"}`, `exclude_slash_tmp`): the `UserPromptSubmit` and
  `PostToolUse` hooks appended to a file under `~/Library/Caches`, and the reply ended
  with the word the prompt hook asked for.
- **The rollout `transcript_path` names keeps each note the model writes as one line
  holding** `"role":"assistant","content":[{"type":"output_text","text":"<note>"}],"phase":"commentary"`
  (`"final_answer"` for the reply), read off a 0.162 TUI rollout of 2026-10-15 on this
  Mac. **A note is in the file when the next tool's `PostToolUse` runs**: 2026-10-16,
  0.162.0, a real Koloft Codex tab (the opt-in case in `agent-tools-real-smoke.spec.ts`):
  after an English turn, a Chinese prompt's hook quoted that turn's English reply back,
  the model wrote a Chinese note, ran `ls`, and the `PostToolUse` hook saw that note
  (it gave the plain reminder, not the quote of the English reply).

## 28. Two app-servers starting at once in a home no app-server has used

**Checked on 2026-10-12 with standalone Codex CLI 0.162.0**, no model turn. A Node script
made a fresh temporary `CODEX_HOME` and folder, started two `codex app-server --stdio`
in it at the same moment and sent each an `initialize`; six rounds, then six more in a
home where one app-server had already started and stopped first.

- **Fresh home: in 4 of 6 rounds one of the two exited with code 1 at once**, never
  answering `initialize`, its stderr
  `Error: failed to initialize sqlite state runtime under <CODEX_HOME>: failed to initialize state runtime at <CODEX_HOME>`.
  The other started and answered. A home used once before: 0 of 6.
- **`codex login` leaves a home in that fresh state**: after `codex login --with-api-key`
  in an empty `CODEX_HOME` it held only `auth.json`, `log/codex-login.log` and `tmp/arg0`.
  So a Codex account Koloft has just signed in is such a home until an app-server runs
  in it.
- Seen in Koloft the same day (real Codex, an account home holding only a copied
  `auth.json`): a short-lived app-server Koloft starts to ask one thing lost this race to
  another of Koloft's app-servers starting in the same home, and exited this way 27–116
  ms after it started. Once it was the one asking `hooks/list` for an Assist's gate
  (section 27; `discord-real-smoke.spec.ts`), and the Assist was refused; once it was
  the one asking `config/read` for a tab's browser settings (section 26;
  `agent-tools-real-smoke.spec.ts`), and the tab ran with no network, so
  `playwright-cli` could not reach the browser. A second app-server started right after
  answered as usual.
- **Not fixed on 0.164.0** (2026-10-23, the same method, fresh homes holding only a
  copied `auth.json`): 5 of 6 rounds lost one app-server with the same error (0.163.0
  the same day: 1 of 6). One 0.164.0 round where both answered logged
  `failed to install system skills: … Directory not empty (os error 66)`.
- **Not fixed on 0.166.0** either (2026-10-30, the same method): 2 of 6 fresh-home rounds
  lost one app-server with the same error, exit 1, 50–76 ms after start (0.165.0 the
  same day: 5 of 6); a home used once before, 0 of 6 on both.

## 29. Git credentials from inside the sandbox

2026-10-11, codex-cli 0.162.0, macOS 27, fake tokens and a local git smart-HTTP stub on
127.0.0.1; commands run through the app-server's `command/exec` (no model turn), under
the configured sandbox.

- **A credential helper can ask Koloft's main process through files in `/tmp`.** Under
  `workspace-write` a shell helper wrote a request JSON into a `/tmp/koloft-…` folder made
  beforehand outside the sandbox, and read the answer main wrote back; about 100 ms on top
  of main's own delay. git has no timeout of its own while the helper waits (15 s was
  fine).
- **`network_access` decides whether git reaches the server at all.** Without it git
  cannot connect, so the helper's answer never matters. With
  `sandbox_workspace_write.network_access=true`, `git ls-remote` against the stub sent the
  helper's username and password.
- **`read-only`**: the helper cannot write its request and fails at once.
- **`GIT_CONFIG_COUNT/KEY_n/VALUE_n` in the app-server's environment reach the command it
  runs**, so an `include.path` given there is loaded. That a model turn's shell sees them
  too is inferred, not checked.
- **The user's own Keychain**: the login Keychain file was readable inside the sandbox
  only with the network on; that the user's `osxkeychain` helper therefore comes back
  empty in a default Codex tab is inferred, not checked.
- **When the helper gives up** (main silent): it prints one line and exits 1, and git
  falls back to its prompt (`fatal`, exit 128, with `GIT_TERMINAL_PROMPT=0`).
- **A real model turn in a Koloft Codex tab does the same.** 2026-10-12, codex-cli 0.162.0,
  a dev build with the tab in a worktree of a repository picked for a Koloft git account,
  `network_access=true` given only for that pick, the request folder in `/tmp`: asked to
  run `git ls-remote origin`, the turn's shell listed `refs/heads/main` from a local fake
  GitHub, which saw the account's login and token (no request with credentials reached it
  before the turn). No question was put to the owner. Established by
  `agent-tools-real-smoke.spec.ts` › "a real Codex turn's git, inside its sandbox, reaches
  the server with the picked account's token through Koloft".
- **ssh with a key in Koloft's own folder works inside the sandbox once the network is
  on.** 2026-10-13, codex-cli 0.162.0, `command/exec` under `workspace-write`, a
  repository whose included config set `core.sshCommand = "ssh -i '<~/Library/Application
  Support/…/key>' -o IdentitiesOnly=yes"`: the command read the key and `git push` reached
  a Gitea 1.24.6 over ssh; without `network_access` ssh failed with `connect to host …:
  Operation not permitted`. In both runs git could not write inside the repository's
  `.git` (`index.lock`, `refs/remotes/origin/main.lock`: `Operation not permitted`), so the
  push went out but the remote-tracking ref was not updated.
- **`.git` is read-only inside a writable root, and a model turn asks before it commits.**
  2026-10-16, codex-cli 0.162.0, real model turns through an app-server with the
  parameters Koloft's TUI sends for each tab kind (folder trusted; `exclude_slash_tmp`
  because the scratch repositories sat under `/tmp`), asked to `git add -A && git commit
  -m probe && git push origin HEAD` to a local bare repository:
  - A ＋ tab (`on-request`/`workspace-write`): `fatal: Unable to create
    '<repo>/.git/index.lock': Operation not permitted`; one run then sent
    `item/commandExecution/requestApproval` to rerun it outside the sandbox, another only
    reported the failure. A worktree tab: the same on `<repo>/.git/worktrees/<name>/
    index.lock`. An Assist (`never`): the same error, exit 128, no request.
  - With `<repo>/.git` (and for a worktree also `<repo>/.git/worktrees/<name>`) added to
    `sandbox_workspace_write.writable_roots`, commit and push ran with no question.
- Not probed yet: a push to the real github.com from a Codex turn.

## 30. A PreToolUse hook that waits before it lets a command run

**Checked on 2026-10-19 with standalone Codex CLI 0.162.0**, real model turns
(`gpt-6.1-sol`, effort low) through `codex app-server --stdio` in a throwaway
`CODEX_HOME` holding a copy of this Mac's login (deleted afterwards), the hook given with
`-c hooks.PreToolUse=[{hooks=[{type="command",command="…",timeout=N}]}]` and trusted as
in section 27. The hook was a Node script that slept, then exited 0 printing nothing; the
turn asked for a shell `echo hi > out.txt`.

- **`timeout` is in seconds; left out it is 600** (`hooks/list` shows `timeoutSec: 600`;
  read, not waited out). A hook that outlived it (`timeout=5`, 20 s sleep) was killed: the
  client got `hook/completed` `status: "failed"` with `hook timed out after 5s`, and the
  **command ran anyway**; the model saw a normal result.
- **A hook that waited 75 s, 130 s (`timeout=3600`) or 300 s let the command run** once it
  exited: 80.0, 135.9 and 304.8 s for the whole turn.
- **A wait longer than about 31 s costs model requests.** The model runs commands through
  a code-mode `exec` tool that returns after a 31 s wall time ("Script running with cell ID
  1 / Wall time 31.0 seconds") while the hook still holds the command; the model then calls
  `wait` about every 12 s, each a new model request of 15–16.5k input tokens (mostly
  cached) and 31 output tokens. Some of those requests also carry a line such as "The shell
  call is still pending." (about once a minute, from 83 s on). Totals for the turn: 2
  requests and 29,942 tokens with no wait, 8 and 121,463 at 75 s, 15 and 231,440 at 130 s,
  27 and 427,325 at 300 s.
- **A hook entry may carry `matcher` and `timeout`, and the trust hash covers them.**
  2026-10-19, codex-cli 0.162.0, a throwaway `CODEX_HOME`, `hooks/list` only (no model
  turn): `-c hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="…",timeout=60}]}]`
  listed `matcher: "Bash"`, `timeoutSec: 60`; without them `matcher: null`,
  `timeoutSec: 600`. The same command string with and without them gave different
  `currentHash` values (`sha256:101e5f…` against `sha256:26f729…`), so the hash is of the
  whole hook entry, not the command string alone (section 27 measured only entries that
  differed in their command). Not probed: that a model turn skips the hook for a tool the
  `matcher` does not name.
- Not probed yet: whether a wait under 31 s costs anything at all (the cutoff), and the
  same in a full-screen TUI tab instead of a bare app-server.

## 31. A one-shot ⌘P routing answer

2026-10-21, codex-cli 0.162.0, `gpt-6-luna`, the `CODEX_ONE_SHOT` argv with a fresh
`CODEX_HOME` holding only `auth.json`, the ⌘P routing prompt of `routeJob` and the typed
lines of `test/unit/sessionRoute.real.test.ts`.

- **It names the right rule but writes another rule's JSON.** For "how's blog doing on
  the Electron article" (blog is not git) it answered
  `{"workspace":2,"worktree":"main",…,"why":"规则 1：询问 blog …"}` in 8 of 26 answers:
  the `why` names rule 1 (hand it to the sessions already working there) while the object
  has rule 6's shape (start a session there).
- **Asked for a `"rule"` number after `"why"`, it repeats the rule it named.** With
  `"rule": <the number of the rule you named in "why">` as the last field, 10 of 10
  answers to that line carried `"rule":1`, 4 of them still in rule 6's shape, so a parser
  that trusts the number sent all 10 to the check-in (and 8 of 8 more through the test).
  The other lines kept their landing: a run of all 24 lines had one wrong answer,
  "让所有正在跑的会话都提交一下代码" as rule 1, while 20 more tries of that line alone
  with this prompt, and 10 without the field, all gave rule 5 or 8.
- **Asked for the number before `"title"` and `"why"`, it decides again and decides
  worse.** With `"rule": <the number of the rule you took>` as the first added field,
  "koloft里…为什么session list前没有展示agent对应的icon" went to rule 8 or 5 (7 of 10)
  or rule 3 (1 of 10), where the prompt without it gave rule 6 in 10 of 10.

## 32. No wake-up after the turn ends

2026-10-26, codex-cli 0.162.0 (`~/.codex/packages/standalone/current/bin/codex`),
`codex exec --ephemeral --ignore-user-config -s read-only` in an empty folder, the
owner's login, `gpt-6.1-sol`, told to call no tool:

- The request itself was not captured on this route (it goes to OpenAI). On the API-key
  route the request's tool list was read at a fake Responses server (section 16):
  `exec_command, write_stdin, request_user_input, apply_patch, view_image, get_goal,
  create_goal, update_goal, tool_search, web_search`, none of which schedules anything.
- Asked for every tool it can call, the model listed `functions.wait`,
  `request_user_input`, `request_user_input_async`, `exec`, `apply_patch`,
  `create_goal`, `get_goal`, `update_goal`, `exec_command`, `write_stdin`,
  `view_image`, the MCP resource tools, `request_plugin_install`, `clock__curr_time`,
  `image_gen__imagegen`, `web__run`, `clock.sleep` and the `collaboration.*` agent tools,
  and answered that none of them starts a turn after the current one has ended (its own
  account of its tools, not read from the request).
- Asked to quote them, it gave `clock.sleep` as "Pause execution for a specified
  duration. The sleep ends early when new input arrives for the active turn. Returns the
  elapsed wall-clock time." with `duration_ms` from 1 to 43200000; and
  `collaboration.followup_task` as sending a task to "an existing non-root target agent",
  never to the thread itself. A Codex wait therefore runs inside the turn, which stays
  open, so the tab reads as working; there is no wake-up to keep a finished tab for, the
  way Claude Code's `/loop` (CC§8) or Muse's `cron_create` (MUSE§9) leave one.
- `codex features list` on that build shows `sleep_tool` stable and on, and
  `in_app_local_automation` stable and on; the binary's only other traces of
  scheduling are thread-source labels ("Scheduled follow-ups", "Scheduled automations")
  and a prompt line telling the model to prefer `clock.sleep` "over automations". No
  app-server method or model tool that makes an automation was found in its strings;
  what makes one in the Codex desktop app was not probed.

## 33. A message queued from outside Koloft

2026-10-28, codex-cli 0.162.0 (`~/.codex/packages/standalone/current/bin/codex`), a
throwaway `CODEX_HOME` with no login (deleted afterwards), a Node client on
`codex app-server --stdio` (`initialize` with `experimentalApi: true`), the folder trusted,
a `UserPromptSubmit` hook given with `-c` and trusted as in section 27 that logged its
stdin. Each turn then failed at the model (401), after the hook had run. One run.

- **Anything that knows the tab's `CODEX_HOME` and thread id can put a turn into it.**
  `codex queue --thread <id> --message "[Discord] …"`, run as a separate process with the
  same `CODEX_HOME`, printed `Queued message <id> for thread <id>.` and exited 0. The
  stdio app-server, which no client of that process had asked, sent
  `thread/queue/changed`, then (once its running turn ended) `turn/started` for a turn
  whose `userMessage` held the text, with a `clientId` Codex made up (a UUID). The home
  gained `queue_1.sqlite`, which is how the two processes met. That a TUI on `--remote`
  in front of that server draws it is inferred, not checked: the server, not the TUI,
  drained the queue.
- **`UserPromptSubmit` cannot tell who queued a message.** For the message Koloft's own
  `thread/queue/add` sent (`clientUserMessageId: "koloft-discord-1"`) and for the one
  `codex queue` sent, the stdin had the same fields: `session_id`, `turn_id`,
  `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `prompt` — the
  text as sent, no client id. The hook ran before the turn's `userMessage` item was
  sent, so the id was not in the rollout yet either.
- **The `prompt` is compact JSON with non-ASCII text left as UTF-8.** A queued
  `[Discord] 你好 "a" <b> é<TAB>x<LF>line2` reached the hook as
  `"prompt":"[Discord] 你好 \"a\" <b> é\tx\nline2"`: only the quote, the tab and the line
  feed escaped, as Node's `JSON.stringify` does (second run, same setup).
- **0.166.0 trims `codex queue`'s options and adds `--resume`.** 2026-10-30, `codex queue
  --help` against 0.165.0's: `-i`, `-m`, `--oss`, `--local-provider`, `-s`,
  `--approve-for-me`, `--dangerously-bypass-approvals-and-sandbox`,
  `--dangerously-bypass-hook-trust`, `--worktree` and `--add-dir` are gone (`-m` now
  exits 2; it exited 0 on 0.165.0), `-C` sits under "Local server options (without
  --remote)", and `-c` says queued messages use the thread's model. `--resume` against a
  thread unloaded from a stdio app-server exited 0 with `Warning: message was queued,
  but could not resume thread …: start a local daemon or specify a server with
  --remote`, and the message waited as in section 17. Koloft never builds a `codex
  queue` line; the shim only lets it through without a TUI.

## 34. A TUI whose connection drops, and an app-server that dies mid-turn

2026-10-29, codex-cli 0.162.0 (`~/.codex/packages/standalone/current/bin/codex`), a
throwaway `CODEX_HOME` with a made-up API key in `auth.json` (deleted afterwards), the folder
trusted. One run of each.

- **The TUI reconnects to the same `--remote` URL by itself.** A real `codex --remote
  unix://…` TUI in a Python pty (120×40) behind a Node relay to one `codex app-server
  --stdio`. After the TUI's `thread/start` was answered, the relay terminated the
  WebSocket (the TUI saw 1006). The TUI opened a new connection 3 ms later, and again
  after 1, 2, 4 and then every 8 s while each attempt was closed. Each new connection
  began with `initialize`.
- **A `--stdio` app-server answers a second `initialize` with an error.** The relay fed
  the reconnected TUI's `initialize` to the same app-server: `{"error":{"code":-32600,
  "message":"Already initialized"},"id":"initialize"}`, and the TUI dropped that
  connection at once. So a TUI can never rejoin an app-server it has already
  initialized unless something in between answers the second `initialize` itself.
- **What a reconnected TUI sends.** With a fresh app-server behind the relay, the second
  connection sent `initialize`, `initialized`, `account/read`, `model/list`,
  `configRequirements/read`, `collaborationMode/list`, then `thread/resume` with the old
  thread id and `excludeTurns: true`, then `plugin/list`. It stayed connected.
- **A message queued but not started survives an app-server that dies; the turn that was
  running does not.** A Node client on a stdio app-server whose model provider pointed at a
  local HTTP server that never answered (`model_provider` with `base_url`,
  `wire_api = "responses"`, `supports_websockets = false`). `turn/start` "A" stayed
  `inProgress`; `thread/queue/add` "B" (`clientUserMessageId: "probe-b"`) was answered
  `queuedSubmission` and `thread/queue/changed`. Then a SIGKILL of the app-server. A new
  app-server on the same home answered `thread/resume` with status `idle` and turn A
  `interrupted` (its `userMessage` kept), then on its own sent `thread/queue/changed`,
  `turn/started` and `item/started` for B's `userMessage` with `clientId: "probe-b"`, and
  asked the model. Nothing re-ran A. Every `item/started` and `item/completed` carried
  `threadId` and `turnId`.
- **A reconnected TUI counts its numeric request ids from 1 again** (`account/read` was
  `id: 1` on both connections), so a late reply to a request the first connection sent
  can carry the id of a different request on the second.
- **No method removes or reorders a queued message.** Read in that binary's
  `app-server generate-json-schema` output, not tried on the wire: `ClientRequest` lists
  none (`thread/queue/add` itself is not in the generated schema either), so a message
  queued again lands behind those still queued.
- **A TUI whose app-server is killed keeps trying on 0.165.0 and 0.166.0 too.**
  2026-10-30, a real TUI on `--remote unix://…` to an `app-server --listen` of its own
  (no relay in between), the app-server sent SIGKILL: both drew "Reconnecting to
  server… ⌃c quit" and were still running 45 s later. The 0.166.0 notes' "Improve TUI
  reconnect recovery" was not told apart from 0.165.0 by this.

