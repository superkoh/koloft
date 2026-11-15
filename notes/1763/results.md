# #1763 probe results (2026-11-15)

Setup: Docker (Debian bookworm, the `agy-a-img` and `koloft-muse-probe-1411` images plus zsh 5.9),
a normal user whose login shell is `/bin/zsh`, `~/.zshrc` = `export PATH="$HOME/rc-only/bin:$PATH"`,
`rconly-tool` only in `~/rc-only/bin`. Each agent was started directly (not through a built Koloft)
with `SHELL=/bin/zsh` and the PATH the remote tab script builds:
`~/.local/bin:~/.koloft/node/bin:/opt/homebrew/bin:/usr/local/bin:` + sshd's default PATH.
A fake model made the agent's own shell tool run
`command -v rconly-tool || echo NOT-FOUND; echo "PATH=$PATH"`.

| agent | how | rc-only tool, PATH as today | with `"$SHELL" -lic` PATH appended |
|---|---|---|---|
| Claude Code 2.1.325 linux-arm64 | `claude -p` and interactive TUI in a python pty, fake Messages API, Bash tool | NOT-FOUND (both); SessionStart hook NOT-FOUND | found (interactive), hook found |
| Antigravity 1.5.7 and 1.5.9 linux-arm64 | TUI in a python pty, `--dangerously-skip-permissions`, fake Gemini server, `run_command` | NOT-FOUND | found (1.5.9) |
| Muse Code 1.4.11 | `muse exec --approval-mode never --disable-sandbox`, fake `/responses` model, `bash` tool | NOT-FOUND | see below |

- Claude Code writes the PATH it was started with into its shell snapshot
  (`~/.claude/shell-snapshots/snapshot-zsh-*.sh` holds `export PATH=<that PATH>`), so whatever
  `.zshrc` adds is overwritten before each Bash call.
- `zsh -lic 'printf %s "$PATH"'` (what Koloft already asks each machine for) printed
  `~/rc-only/bin` first; a plain `sh -c` with today's PATH did not find the tool.

Scripts: `setup.py` (root, puts the rc file and tool in place), `cc_probe.py <shell> [interactive]`,
`agy_probe.py <shell> <agy binary>`, `muse_probe.py <shell>`, `control.py`; `APPEND=<path>` adds a
PATH at the end.
