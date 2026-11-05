# Probe: Codex managed worktrees (issue 489)

Codex CLI 0.166.0 (standalone build), macOS arm64, 2026-11-05. No login: a throwaway
`CODEX_HOME` holds a made-up API key and points the model at a stand-in Responses
server inside `probe.mjs`, which answers with the tool calls a real model would make.

```
node notes/489/setup-lab.mjs <lab dir> 18789
node notes/489/probe.mjs <lab dir> <case> <path to the codex binary> 18789
```

| case | what runs | what it shows |
| --- | --- | --- |
| `exec` | `codex exec --worktree -C <repo>` | where `--worktree` puts the checkout, and from which commit |
| `remote-tool` | TUI with `--remote unix://…` (as Koloft starts it) through a logging relay to `codex app-server` | which tools the model gets; `frames.json` is every line both ways |
| `local-tool` | TUI with its own built-in app-server | the model searches for and calls `create_worktree`, then polls it |
| `remote-new` / `local-new` | the same two TUIs, `/new` typed | whether the "Where should the new conversation run?" picker shows |
| `local-disable` | `local-tool` with `--disable worktrees` | whether that flag still turns the tools off |
| `remote-listen-tool` | `remote-tool`, but the TUI reaches `codex app-server --listen unix://…` directly (no relay, so no `frames.json`) | the same: no worktree tool offered |
| `remote-fork` | TUI with `--remote`, one turn, then `/fork` | whether a picker shows for a fork |
| `remote-flag` | TUI with `--remote … --worktree` | whether Koloft could start a Codex worktree session with the flag |

The lab repo has a `main` pushed to a bare `origin`, then a local `feature` branch one
commit ahead, so the base commit of each worktree tells which branch it came from
(`733afa…` is `origin/main`, `538b71…` is `feature`; hashes differ per run of
`setup-lab.mjs`). Paths in `out/` are rewritten to `<lab>`.
