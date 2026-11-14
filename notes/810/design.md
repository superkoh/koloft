# #810 — local Codex tabs of one account share one Codex server

**Core idea:** local Codex tabs signed in to the same account (the same `CODEX_HOME`)
and started with the same server settings talk to one `codex app-server`. What makes a
tab's server its own today — its env and its per-tab settings — travels with the tab's
thread instead.

## What a user sees

| Case | Today | After |
|---|---|---|
| Open the first local Codex tab of an account | 1 server for the tab (~60 MB idle, ~90–110 MB after a turn) | the same: that tab starts the account's server |
| Open a further local Codex tab of that account | +1 server, ~90–110 MB after a turn | about +0–15 MB in the shared server (measured up to 3 threads; more is extrapolated) |
| 10 local Codex tabs, one account | ~1 GB in servers | ~0.15–0.25 GB, extrapolated from 3 |
| The Codex server crashes | that tab reconnects to a new server; other tabs untouched | **every local Codex tab sharing that server** reconnects at once to one new server; a turn running in any of them stops, as one tab's does today |
| A tab's TUI drops its connection (sleep, a hang) | Koloft kills and restarts that tab's server (CODEX§34) | only that tab's connection is redone; the server and other tabs are untouched |
| Close a Codex tab | its server and every process under it are killed at once | its turn is interrupted and its background commands end within ~2 s; its MCP processes go when Codex unloads the thread, up to a minute later; a process that left its process group (`nohup`, `setsid`) is found by its env and killed (below) |
| Restart a Codex tab (⇧⌘R), or close it and open the same session again within a minute, while another tab of that account stays open | new server, new env | resumes at once in the shared server, which still has the thread loaded with the old tab's env; Koloft answers that old tab id for the new tab until the thread unloads (below), so the shim, `koloft` and the Workbench browser still reach the right tab |
| Type `/resume <id>` in a Codex tab for a session another live tab holds | the second server gets "open in another app" (writer lock, CODEX§5, §15) | both tabs show the thread; the second tab's commands run with the first tab's env |
| Sign in again after a login expired | the next new tab gets a new server with the new login | the account's server is replaced after the new sign-in (open tabs reconnect, as on a crash) |
| Koloft itself crashes | each orphan `--stdio` server exits on its own within ~14 s (CODEX§5) | the `--listen` server does not exit by itself (CODEX§16); the next Koloft start ends it and everything under it |
| Codex is updated while tabs are open | each new tab starts a server of the new version | a new tab starts a new server for the new version; tabs on the old one keep it until they close |
| Codex tab on a remote machine | one server per tab on the machine | unchanged (see the eight kinds) |

Memory: `docs/codex-cli-contract.md` section 38 (codex 0.166.0, stand-in model turns;
a real model turn's size is not measured). MCP servers are one process per thread
either way, so they are not counted.

## How

```
today                                   after
TUI-1 ─ relay-1 ─ app-server-1          TUI-1 ─ relay-1 ─┐
        (--stdio, env of tab 1,                          ├─ app-server (--listen unix://…)
         -c of tab 1)                   TUI-2 ─ relay-2 ─┘  one per (CODEX_HOME, codex
TUI-2 ─ relay-2 ─ app-server-2                               version, server -c list)
        (--stdio, env/-c of tab 2)            thread 1: config = env of tab 1, …
                                              thread 2: config = env of tab 2, …
```

- **The relay stays one per tab** (`createCodexTransport`: the TUI's own socket, the
  observer, Koloft's own requests such as `thread/queue/add` and `thread/name/set`, the
  skills call). Its upstream becomes a WebSocket connection into the shared `--listen`
  server, a new `CodexUpstream`. Each TUI keeps its own connection and its own
  `initialize`, so Codex keeps request ids, thread notifications and approval requests
  apart (CODEX§38: an approval request reached only the client that started the
  thread; other clients see only `thread/started` / `thread/status/changed`).
- **Reconnects are split in two.** Today `canReplaceTheServer()` is false whenever an
  `upstream` factory is given (`codexTransport.ts`), so a new upstream gets no
  reconnect for free; it is written for this:
  - *the TUI leaves* → the relay opens a new upstream connection for the TUI's next
    connect; the server is not touched and `onServerReplaced` is not called;
  - *the server dies* → the pool starts one new server (at most 3 times per server
    instead of per tab), each relay drops its TUI, which reconnects and resumes and gets
    its config again (CODEX§34).
- **The relay adds the tab's settings to the TUI's thread openers.** On `thread/start`,
  `thread/resume` and `thread/fork` it merges into `params.config`, with dotted keys so
  nothing else is replaced (CODEX§38): `shell_environment_policy.set.<VAR>` for each
  of the tab's env values and `mcp_servers.<name>.env.<VAR>` for the tab's Playwright
  MCP values; on `thread/start` it also sets `developerInstructions` (the TUI sends
  `null`; a start's own instructions win over `-c`, CODEX§17). The env is not saved
  with a thread (CODEX§38), so every resume, `/new` and reconnect sends it again.
- **The pool** keys a server by `CODEX_HOME`, the codex version Koloft already reads
  (`availability().version`; an in-place update keeps the binary path) and the server's
  own `-c` list. Tabs whose server settings differ (another status-line choice, other
  hook trust, a folder whose project config gives other writable roots or MCP entries)
  get different servers; most tabs have the same and share. The server runs in the
  account home's folder, not a tab's; each thread's `cwd` comes from its TUI (`-C`).
  The last tab to close stops the server. A new sign-in for that home replaces it, as
  Koloft already drops its side server then (`codexSessions.ts`).

### Where each per-tab setting goes

| Per tab today (server env or `-c`) | After |
|---|---|
| `KOLOFT_TAB_ID`, browser control env (`PLAYWRIGHT_CLI_SESSION`, `PLAYWRIGHT_MCP_OUTPUT_DIR`, `KOLOFT_BROWSER_CDP`, … — all keyed by the tab id), `KOLOFT_PORT_OFFSET` | thread `config`, `shell_environment_policy.set.<VAR>` — reaches commands (CODEX§38) |
| `ZDOTDIR` (the open shim, a new folder per launch today) | the same key; a closed tab's shim folder stays while a later tab holds its still-loaded thread (the alias below) |
| Reply-language / said / notice / Discord-said / shell-wrote file paths, read by the hook script | hooks see only the server's env (CODEX§38). The hook commands are the same for every tab, so they go on the server once; the script finds the tab's files from stdin `session_id` (= the thread id, CODEX§38; a sub-agent's tool calls carry the parent's, CODEX§27): Koloft writes `<hookRegDir>/<threadId>.codex-tab` holding those paths when the relay sees the opener's reply, before the TUI can start a turn |
| `developer_instructions` (Koloft prompt, role) | `thread/start` `developerInstructions`. A resume takes no new instructions either way (CODEX§17), same as today |
| `approval_policy` / `sandbox_mode` on a resumed tab | `thread/resume` params `approvalPolicy` / `sandbox` (in the schema; not run) |
| Playwright MCP `env_vars` (forwarded the server env, which no longer holds the tab's values) | thread config `mcp_servers.<name>.env.<VAR>` = the tab's values; dotted keys keep the server's `-c` MCP entries and the owner's `config.toml` ones (CODEX§38) |
| Status line, hooks and their trust, `network_access`, writable roots, `default_mode_request_user_input`, the Playwright MCP approval mode | the server's `-c`, part of the pool key |
| `skills/extraRoots/set` after `initialized` | unchanged: sent per connection; the roots are the same for every tab |
| The conductor gate and its allow file (named in the issue) | gone from `main` (no `KOLOFT_CODEX_GATE` in `src/`; the butler runs without it since ADR-0029) |
| Sub-agent threads | get the parent thread's `set` (CODEX§38), as they get the server env today |

### Closing, the quick reopen, crashes, leftovers

- **Close a tab:** the relay sends `turn/interrupt` (if a turn runs),
  `thread/backgroundTerminals/clean` and `thread/unsubscribe` for the threads it
  opened, then closes its connection. `clean` ended that thread's background command
  within 2 s and left another thread's running; `unsubscribe` alone let it run to its
  end (CODEX§38). Then Koloft kills the processes under the shared server whose env
  holds this tab's `KOLOFT_TAB_ID` (macOS `ps -E` shows the env of the owner's other
  processes: 312 of them carried a `KOLOFT_TAB_ID` on this Mac), which catches what
  left the process group, as the per-tab tree kill does today. MCP processes go when
  Codex unloads the thread (CODEX§16). The worktree removal after close runs as today;
  the thread may still be loaded then, as a TUI's thread is today until its server dies.
- **The quick reopen and the restart:** a resume of a thread the shared server still
  has loaded keeps the env it was loaded with (CODEX§38). A restart always gets a new
  pty id (`restartSession.test.ts`: `codex-restart` → `codex-restarted`), and a
  reopen from history is a new tab, so that env names a tab that is gone. Koloft keeps,
  per loaded thread, the tab id its env names; when another tab resumes that thread,
  Koloft makes the old id an alias of the new tab (agent requests by `KOLOFT_TAB_ID`,
  the browser endpoint keyed by tab id, the Playwright session and output folder), and
  keeps the old open-shim folder, until the thread is unloaded (`thread/loaded/list`
  no longer holds it; CODEX§17 saw it go 30–60 s after the last unsubscribe). The relay learns whether the thread is loaded with
  `thread/loaded/list` before it forwards the resume.
- **Koloft crash:** at start, Koloft ends every pool server left by an earlier run
  (`endCodexAppServersLeftByACrash` today matches only `app-server --stdio` and kills
  only the server) together with its process tree.
- **Foreign frames:** the observer already ignores other threads' frames
  (`codexObservation.ts`, `p.threadId !== this.threadId && !ownedChild`). The relay
  also drops, before the TUI, `thread/started` / `thread/status/changed` of threads it
  did not open and that are not its children (known from `spawnAgent` items, as the
  observer does). What a TUI does with a foreign `thread/started` is not probed yet.
- **Two tabs on one thread:** Koloft refuses to open one stored session twice
  (`storedSessions.ts`), but a `/resume <id>` typed in a TUI is not stopped today
  either; with a shared server the second tab gets the first tab's env.

## Not probed yet — the first build steps

1. (Done: a sub-agent thread gets its parent's `set`, CODEX§38.)
2. A real TUI over `--remote` on a shared server: a foreign `thread/started`, `/new`,
   `/resume`, a reconnect.
3. `thread/fork` with `config`; `thread/resume` with `approvalPolicy` / `sandbox`.
4. Whether an unloaded thread lets go of its writer lock (CODEX§15). Another account's
   home has its own locks: §15 saw home B resume and take a turn while home D held the
   writer, so resuming in another account is not blocked.

## The eight tab kinds

| Kind | What it does |
|---|---|
| Codex, local | shares a server with the account's other local Codex tabs (this change) |
| Codex, remote (SSH) | unchanged: one server per tab on the machine (`codexTabScript`). The memory is the machine's, not the Mac's; sharing there means moving the tab's exports into thread config and a per-machine pool over ssh |
| Claude Code, local / remote | not affected: no Codex server |
| Muse Code, local / remote | not affected: no Codex server |
| Antigravity, local / remote | not affected: no Codex server |

## Upgrade

No setting changes. Tabs restored at the first launch after the update resume their
threads into the shared server; the relay sends their env again, which a new server
needs anyway (CODEX§38).

## Rejected

- **Koloft multiplexes one `--stdio` server itself:** it would have to rewrite request
  ids and route every notification and approval by thread. `--listen` does that inside
  Codex, and Koloft already runs `--listen` servers on remote machines.
- **Fold the account's side server (#755) in too:** another ~60 MB per account, but
  the side server is `--stdio` with a different life; left out.
- **Resume a still-loaded thread at once and accept the old env:** commands would
  reach a closed tab's Workbench and shim.
- **Wait until Codex unloads the thread before resuming:** simpler than the alias, but
  every ⇧⌘R of a Codex tab would wait 30–60 s while another tab of that account is
  open.

## Size and tests

- Runtime: a server pool and a WebSocket upstream (new), the opener rewrite and the
  loaded-thread wait in the relay, the split reconnect, launch changes in
  `codexSessions.ts`, the hook script's lookup by `session_id`, the per-tab process
  sweep on close, the leftover sweep at start, the tab-id alias. Roughly +550 / −150 lines under
  `src/`, guessed.
- `fixtures/fake-codex.js` must learn `--listen` with several connections and the
  thread config before any e2e can show two tabs on one server.
- E2E flows to run: the local Codex specs (start, resume, `/new`, close, restart,
  server replacement, agent tools / browser, reply language, Inbox questions), and the
  remote Codex specs to show they are unchanged.
