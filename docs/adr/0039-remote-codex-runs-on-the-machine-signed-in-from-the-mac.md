# 0039 A remote Codex tab runs its app-server on the machine, its screen on the Mac, and its login stays on the Mac

**Constraint**: Koloft reads every Codex tab through the frames its relay carries
(CODEX§1), so the relay must sit between the TUI and the app-server. A remote session
must outlive an ssh drop or a sleeping Mac, as a remote Claude tab does in tmux. Codex
keeps a login inside the app-server process (CODEX§16), and each Koloft launch may pick
a different account (CODEX§15, ADR-0030). A refresh token that sits on a machine can be
read by anyone with that machine's account, and Codex rotates it on use. The `koloft`
command on the machine tells Koloft its tab only through `KOLOFT_TAB_ID` in its
environment.
**Decision**: each remote Codex tab starts its own `codex app-server --listen
unix://…` on the machine (setsid, nohup), with that tab's `KOLOFT_TAB_ID`, its worktree's
port offset and its config, in one shared `~/.koloft/codex-home` that holds no
`auth.json`, so every thread on that machine sits in one place whatever account ran it.
The TUI runs on the Mac with `--remote` on Koloft's relay; the relay reaches the server
through `ssh … codex app-server proxy`, speaks WebSocket over that line, and after a drop
opens a new line and resumes the thread. After the TUI's `initialized` the relay signs
the server in with `chatgptAuthTokens` read from the picked account's home on the Mac,
holds the TUI's frames until `account/login/completed`, and answers every token refresh
request itself. Closing the tab ends the server; the first launch on a machine in each
app run ends the servers a crash left behind.
**Rejected**:
- The TUI in tmux on the machine, like Claude: Koloft would need a relay and node on
  the machine to see the frames, and a second copy of everything CodexObservation does.
- One shared app-server per machine: one process holds one login and one environment,
  so two tabs on two accounts, or the `koloft` command telling its tab, would clash.
- `--stdio` over each ssh line: the server and its running turn die with the line.
- Copying `auth.json` to the machine, or `codex login` there: a refresh token on the
  machine, and a sign-in per machine per account.
