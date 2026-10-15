# Probe: does `skipDangerousModePermissionPrompt` in a `--settings` file skip Claude Code's one-time Bypass Permissions screen?

2026-10-15, Claude Code 2.1.300 (macOS arm64). Each run: a scratch `CLAUDE_CONFIG_DIR` whose `.claude.json` has onboarding done and the work folder trusted, no MCP servers, a python pty; claude is killed after 20 s. Run as `CLAUDE_BIN=<path to claude> python3 probe.py <variant> <flag>`.

| Command | Variant | Flag | Result (last screen text, trimmed) |
|---|---|---|---|
| `probe.py none dsp` | key nowhere | `--dangerously-skip-permissions` | WARNING_SCREEN — "… running in Bypass Permissions mode … ❯ No, exit / Yes, I accept" |
| `probe.py flagsettings dsp` | key in a `--settings` file | `--dangerously-skip-permissions` | no-warning — prompt open, footer "⏵⏵ bypass permissions on (shift+tab to cycle)" |
| `probe.py usersettings dsp` | key in the config dir's `settings.json` | `--dangerously-skip-permissions` | no-warning — same footer |
| `probe.py none pm` | key nowhere | `--permission-mode bypassPermissions` | WARNING_SCREEN |
| `probe.py flagsettings pm` | key in a `--settings` file | `--permission-mode bypassPermissions` | no-warning — same footer |

A no-flag launch, with and without the key in a `--settings` file, Shift+Tab pressed five times: auto → manual → accept edits → plan → auto; bypass is never offered in either run.

Not probed: the same on Linux (the remote case); the docker ssh lab run during the build covers it.
