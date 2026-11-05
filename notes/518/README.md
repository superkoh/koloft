# Issue 518 probes: a sandbox that reaches the Workbench browser and not the internet

Run 2026-11-05 on macOS, codex-cli 0.166.0, Claude Code 2.1.318, Node 24.13.0. No login:
both CLIs talked to a fake model server on 127.0.0.1. A small HTTP server on 127.0.0.1
stood in for Koloft's relay; a headless Chrome's CDP port stood in for the Workbench
browser in the `playwright-cli` runs. Every `*proxy*` variable was removed first.

| Script | What it runs |
|---|---|
| `probe-codex-sandbox.mjs` | `codex sandbox -P <profile>` with six configs (P1–P6) |
| `probe-codex-session.mjs` | `codex app-server`: `command/exec`, then `thread/start` + a fake-model turn whose `exec_command` runs the probe (S1–S9) |
| `probe-codex-playwright.mjs` | `codex app-server` `command/exec` running real `playwright-cli` (W1–W3) |
| `probe-claude-sandbox.mjs` | `claude -p --settings` with a fake Anthropic API, the model's `Bash` runs the probe (C0–C6) |
| `probe.sh`, `client.mjs`, `pw.sh` | what runs inside the sandbox |

Run one with `node notes/518/<script> [variant,variant]`.

## Codex

| Run | Setup | 127.0.0.1 | github.com | example.com | unix socket |
|---|---|---|---|---|---|
| S1 | today: `sandbox_mode=workspace-write`, `network_access=true` | 200 | 200 | 200 | ok |
| P1 | profile with `network.enabled`, `network_proxy` feature off | 200 | 200 | 200 | ok |
| P2 | + feature on | 403 (proxy) | fail | fail | EPERM |
| P3 | + `allow_local_binding` | 200 | fail | fail | EPERM |
| P4 | + `domains: github.com` | 200 | 200 | fail | EPERM |
| S2/S4 | P4 + `unix_sockets: <realpath TMPDIR>`, on the app-server, model turn | 200 | 200 | whole command fails | ok |
| S5/S9 | S2, but `thread/start` sends `sandbox: workspace-write` | EPERM | fail | fail | EPERM |
| W2 | S4 + `filesystem: ~/Library/Caches/ms-playwright = write` | `playwright-cli open/eval/close` work | | fail | |

## Claude Code

| Run | Settings | 127.0.0.1 | github.com | example.com |
|---|---|---|---|---|
| C0 | no sandbox (today) | 200 | 200 | 200 |
| C1 | `sandbox.enabled` | EPERM | fail | fail |
| C2 | + `allowedDomains: [github.com]`, `allowLocalBinding` | 200 | 200 | fail |
| C6 | C2 + `filesystem.allowWrite: ~/Library/Caches/ms-playwright`, `allowUnixSockets: /private/tmp/claude-<uid>` | `playwright-cli open/eval/close` work | | fail |

The measured facts are in `docs/codex-cli-contract.md` §26 and
`docs/claude-code-contract.md` §24.
