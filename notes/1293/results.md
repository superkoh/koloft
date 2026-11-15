# #1293 probe: keys typed before Codex's trust question

codex-cli 0.166.0, macOS, 2026-11-15. `drive.py` starts `codex app-server --listen ws://…`
in a throwaway `CODEX_HOME` (an API-key `auth.json` with a made-up key, empty
`config.toml`) and a throwaway `HOME`, waits 2 s, then runs the TUI as Koloft does
(`codex --remote ws://… -C <repo>`) in a pty (120×40) that answers the terminal's
queries. `<repo>` is a fresh `git init` folder. Each run lasts 25 s, then Ctrl+C twice.
"Server log" means which JSON-RPC methods the app-server's own `RUST_LOG=info` log shows.

| Run (`mode`, keys) | What the screen did | `config.toml` after | Server log |
|---|---|---|---|
| `wait`, no keys | "Ask Codex to do anything" composer at 0.09 s (banner still says "loading"), then "Folder access … Trust this folder? › 1. Trust and continue / 2. Back to Agent Command Center" at 0.24 s, and it stays | unchanged | no `config/batchWrite`, no `thread/start` |
| `early`, `fix the readme typo` one key per 30 ms, then Enter, starting the moment the composer shows | first key `f` lands in the composer; the question comes up 10 ms later; every further letter changes nothing on it; Enter picks "1. Trust and continue"; the session opens with `f` in the composer | `[projects."<repo>"] trust_level = "trusted"` | `config/batchWrite`, then `thread/start` |
| `early-chunk`, one write of `ESC[200~fix the readme typo ESC[201~` + Enter | the paste is ignored by the question; Enter trusts and starts; the composer is empty | trusted | `config/batchWrite`, `thread/start` |
| `early-paste`, the same paste sent one byte per 30 ms | the lone `ESC` closes the question; the screen becomes "Agent command center … No tasks yet"; everything after is lost there | unchanged | no `config/batchWrite`, no `thread/start` |
| `wait`, Ctrl+C at 25 s on the question | Ctrl+C closes the question to "Agent command center"; the second Ctrl+C prints "Shutting down" | unchanged | no `config/batchWrite`, no `thread/start` |

So the dead session of #1293 comes from a key the question reads as "back": Esc (alone,
or an Esc byte that arrives apart from the rest of its sequence) or Ctrl+C. Letters and
a whole paste do nothing to it; Enter answers yes.
