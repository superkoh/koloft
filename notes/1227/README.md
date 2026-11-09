# Probe for #1227: how Muse and Antigravity exit on macOS when a person quits

A throwaway clone of a macOS 26.6.2 tart VM, no screen, commands run with `tart exec`.
`quit.py <muse,agy> <runs>` starts each agent in a python pty that answers the
terminal's queries, waits 10 s (the input box is drawn by then), sends one way of
quitting, and reads the exit code with `waitpid` (15 s limit). Muse 1.4.14 runs
`--provider echo --trust-workspace`; agy is the manifest's 1.5.3 darwin arm64 build
(sha512 checked), on the API-key route against a small fake Gemini server
(`fake-gemini.mjs`, not included: it answers every POST with one `ok` SSE event).

| agent | `/exit` | `/quit` | Ctrl+C ×2, 0.3 s | Ctrl+C ×2, 0.8 s | Ctrl+D ×2, 0.3 s |
| --- | --- | --- | --- | --- | --- |
| Muse 1.4.14 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 |
| agy 1.5.3 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 | 0, 0, 0 |

After the first Ctrl+C or Ctrl+D, Muse showed `Press Ctrl-C again to quit` (`Ctrl-D`),
agy `press ctrl+c again to exit` (`ctrl+d`).
