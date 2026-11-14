# #810 — local Codex tabs of one account share one Codex server

**Core idea:** local Codex tabs signed in to the same account (the same `CODEX_HOME`)
talk to one `codex app-server`. What makes a tab's server its own today — its env and
its `-c` settings — travels with the tab's thread instead.

## What a user sees

| Case | Today | After |
|---|---|---|
| Open the first local Codex tab of an account | 1 server for the tab (~60 MB idle, ~90–110 MB after a turn) | the same: that tab starts the account's server |
| Open each further local Codex tab of that account | +1 server, ~90–110 MB after a turn | +0–15 MB inside the shared server |
| 10 local Codex tabs, one account | ~1 GB in servers | ~0.1–0.2 GB |
| The Codex server of a tab crashes | that tab's TUI reconnects to a new server (up to 3 times, CODEX§34); other tabs untouched | **every local Codex tab of that account** reconnects at once to one new server; a turn that was running in any of them is lost |
| Close a Codex tab | its server and everything it ran are killed | its turn is interrupted, its background commands are stopped, its thread is let go; the server stays while another tab of that account is open |
| Codex tab on a remote machine | one server per tab on the machine | unchanged (see the eight kinds below) |

Memory numbers: `docs/codex-cli-contract.md` section 38 (codex 0.166.0, stand-in model
turns; a real model turn's size is not measured). MCP servers (the Workbench browser's
Playwright MCP) are one process per thread either way, so they are not counted.

## How

```
today                                   after
TUI-1 ─ relay-1 ─ app-server-1          TUI-1 ─ relay-1 ─┐
        (--stdio, env of tab 1,                          ├─ app-server (--listen unix://…,
         -c of tab 1)                   TUI-2 ─ relay-2 ─┘   one per CODEX_HOME + binary)
TUI-2 ─ relay-2 ─ app-server-2                thread 1: config = env of tab 1, …
        (--stdio, env/-c of tab 2)            thread 2: config = env of tab 2, …
```

- **The relay stays one per tab** (`createCodexTransport`: the TUI's own socket, the
  observer, Koloft's own requests such as `thread/queue/add` and `thread/name/set`, the
  skills call). Only its upstream changes: from a `CodexProcess` it owns to a WebSocket
  connection into the account's shared `--listen` server — a new `CodexUpstream`, the
  same seam `MachineCodexUpstream` already uses. Each TUI keeps its own connection and
  its own `initialize`, so Codex itself keeps request ids and thread notifications apart
  (CODEX§38: every connection also sees other threads' `thread/started` and
  `thread/status/changed`, nothing else).
- **The relay adds the tab's settings to the TUI's thread openers.** On `thread/start`,
  `thread/resume` and `thread/fork` from the TUI it merges into `params.config`, with
  dotted keys so nothing else is replaced: `shell_environment_policy.set.<VAR>` for each
  of the tab's env values, and the tab's MCP env (below); on
  `thread/start` it also sets `developerInstructions` (the TUI sends `null`; a start's
  own instructions win over `-c`, CODEX§17). The env is not saved with a thread
  (CODEX§38), so every resume, every `/new`, and every reconnect after a server crash
  sends it again.
- **A pool, one server per (`CODEX_HOME`, codex binary path).** The first tab starts it
  with the settings every tab shares as `-c`; the last tab to close stops it. A new
  codex version after an update gets a new server; tabs on the old one keep theirs.

### Where each per-tab setting goes

| Per tab today (server env or `-c`) | After |
|---|---|
| `ZDOTDIR` (open shim), `KOLOFT_TAB_ID`, browser control env, `KOLOFT_PORT_OFFSET` | thread `config.shell_environment_policy.set` — reaches commands, `ZDOTDIR`'s `.zshenv` included (CODEX§38) |
| Reply-language / said / notice / Discord-said / shell-wrote file paths, read by the hooks | hooks see only the server's env (CODEX§38). The hook commands are the same for every tab, so they go on the server once; the hook script finds the tab's files from stdin `session_id` (= the thread id, CODEX§38; a sub-agent's tool calls carry the parent's, CODEX§27): Koloft writes `<hookRegDir>/<threadId>.codex-tab` holding those paths when the relay sees the opener's reply, before the TUI can start a turn |
| `developer_instructions` (Koloft prompt, role) | `thread/start` `developerInstructions`. A resume takes no new instructions either way (CODEX§17), same as today |
| `approval_policy` / `sandbox_mode` on a resumed tab | `thread/resume` params `approvalPolicy` / `sandbox` (in the schema; not run) |
| Playwright MCP `env_vars` (forwards the server env, which no longer holds the tab's values) | thread config with dotted keys, `"mcp_servers.<name>.env.<VAR>"` = the tab's browser endpoint values. Dotted keys merge: the server's `-c` MCP entries and the owner's `config.toml` ones still start (CODEX§38); a nested `mcp_servers` object would have replaced the `-c` ones |
| `sandbox_workspace_write.network_access`, writable roots, `default_mode_request_user_input`, status line, hooks | the same for every tab: `-c` on the shared server |
| `skills/extraRoots/set` after `initialized` | unchanged: sent per connection; the roots are the same for every tab |

### Closing, crashing, leftovers

- **Close a tab:** the relay sends `turn/interrupt` (if a turn runs),
  `thread/backgroundTerminals/clean` and `thread/unsubscribe` for the threads it
  opened, then closes its connection. `clean` ended that thread's background command
  within 2 s and left the other thread's running; `unsubscribe` plus a closed
  connection alone let it run to its end (CODEX§38). Codex unloads an unsubscribed idle
  thread within a minute (CODEX§16), and its MCP processes with it.
- **Server crash:** the pool starts one new server; each relay drops its TUI, which
  reconnects and resumes (CODEX§34) and gets its config again. The 3-replacements limit
  becomes per server.
- **Koloft crash:** `endCodexAppServersLeftByACrash` matches `app-server --stdio`; it
  must also match the pool's `--listen` command.
- **Foreign frames:** the observer already ignores frames of other threads
  (`codexObservation.ts`, `p.threadId !== this.threadId && !ownedChild`). The relay also
  drops, before the TUI, `thread/started` / `thread/status/changed` of threads it did
  not open and that are not its children (children are known from `spawnAgent` items,
  as the observer does). What a TUI does with a foreign `thread/started` is **not probed
  yet**.
- **Two tabs on one thread:** a resume of a thread another connection holds keeps the
  first env (CODEX§38). Whether Koloft can open one Codex session in two tabs at once is
  inferred not to happen, not checked.

## The eight tab kinds

| Kind | What it does |
|---|---|
| Codex, local | shares its account's server (this change) |
| Codex, remote (SSH) | unchanged: one server per tab on the machine (`codexTabScript`). The memory is the machine's, not the Mac's; sharing there means moving the tab's exports into thread config and a per-machine pool over ssh — a separate change if wanted |
| Claude Code, local / remote | not affected: no Codex server |
| Muse Code, local / remote | not affected: no Codex server |
| Antigravity, local / remote | not affected: no Codex server |

## Upgrade

An existing user sees no setting change. Tabs restored at the first launch after the
update resume their threads into the shared server; the relay sends their env again,
which is what a new server needs anyway (CODEX§38).

## Rejected

- **Koloft multiplexes one `--stdio` server itself:** it would have to rewrite request
  ids and route every notification by thread. `--listen` does that inside Codex, and
  Koloft already runs `--listen` servers on remote machines.
- **One shared server for the account's side server (#755) too:** another ~60 MB per
  account, but the side server is `--stdio` with a different life; left out.

## Size and tests

- Runtime: a server pool and a WebSocket upstream (new), the opener rewrite in the
  relay, launch changes in `codexSessions.ts`, the hook script's lookup by
  `session_id`, the leftover sweep. Roughly +400 / −150 lines under `src/`, guessed.
- `fixtures/fake-codex.js` must learn `--listen` with several connections, and the
  thread config, before any e2e can show two tabs on one server.
- E2E flows to run: the Codex specs (local tabs, resume, `/new`, close, server
  replacement, agent tools / browser, reply language), and the remote Codex specs to
  show they are unchanged.
