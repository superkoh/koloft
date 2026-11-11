# Probe results for #1597 (2026-11-11)

A scratch Playwright spec on top of the e2e Docker ssh lab (`startSshLab`, a built
Koloft, fake Codex and fake Claude Code on the machine). A tool `ztool` sits only in
`/opt/ztools/bin`, which one line of the user's rc file puts on PATH. Each case opens
a remote Codex tab, types `/sh command -v ztool` and reads the exit code and the
app-server's PATH from `/proc/<pid>/environ`.

## On `main` (the start script runs `bash -lc`)

| login shell, where its PATH line is | Codex tab | app-server PATH holds `/opt/ztools/bin` |
|---|---|---|
| bash, end of `~/.bashrc` | exit 1 | no |
| zsh, `~/.zshrc` | exit 1 | no |

## First try: `"$SHELL" -lic` inside the start script (under the tab's `ssh -tt`)

| case | Codex tab | row bound after |
|---|---|---|
| bash, end of `~/.bashrc` | exit 0 | 1402 ms |
| zsh, `~/.zshrc` plus `echo` and `sleep 25 &` | exit 0 | 1384 ms |
| bash, `~/.bashrc` plus `echo` and `sleep 25 &` | exit 0 | 1418 ms |
| tcsh, `~/.login` | exit 1 | 1414 ms |
| fish, `config.fish` | exit 0 | 1380 ms |

No temp file left in `/tmp`. Dropped after review: with a terminal there, an rc file
that asks a question could wait for ever.

## Final: the start script is handed the PATH Koloft asks once per machine

| case | Codex tab | row bound after |
|---|---|---|
| bash, end of `~/.bashrc` (kept as e2e E-SSH-51) | exit 0 | — |
| zsh, `~/.zshrc` plus `echo` and `sleep 25 &` | exit 0 | 1927 ms |
| tcsh, `~/.login` | exit 1 | 1893 ms |
| fish, `config.fish` | exit 0 | 1405 ms |

## Other agents

A fake Claude Code tab on the bash and zsh machines: `command -v ztool` not found
(`sh exit=127`). Muse Code and Antigravity share that tab script; not run.
