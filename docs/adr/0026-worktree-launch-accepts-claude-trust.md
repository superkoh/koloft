# 0026 Only a session the owner asked for writes an agent's folder trust

**Constraint**: `claude -w <name>` in a repo Claude has never been trusted in does not
ask the trust question — it prints an error and exits at once (`CC§9`). In a folder it
has never been trusted in, every agent's TUI first asks whether to trust it (`CC§9`,
`CODEX§11`, `MUSE§10`, `AGY§5`), and a session nobody is watching sits on that question
for good.
**Decision**: Koloft writes the agent's own trust entry for the folder (Claude
`hasTrustDialogAccepted: true` in `~/.claude.json`, Codex `trust_level = "trusted"` in
`config.toml`, Muse `trust.json`, Antigravity `trustedWorkspaces`) when:
- the person starts a new worktree session — that click counts as their yes; it covers
  the workspace folder and, for Codex, Muse and Antigravity, the new worktree's own
  folder too (Codex 0.159.3 stopped counting the workspace's entry for it);
- an agent starts a session with `koloft session new` — the butler from Discord, or any
  session — in a workspace the owner added to the sidebar, or in the butler's own
  folder: the owner added that folder and asked for the work, and nobody is at the
  terminal to answer.
Nothing else writes it: a main session the person starts at the Mac gets the agent's
own question in the terminal, a scheduled run keeps the jobs form's warning, and a
launch that fell back to another folder writes nothing. The same rule holds on a remote
machine, where the entry is written there, over ssh.
**Rejected**: refusing the launch and telling the person to open a main session first
to answer the question — one click beats that detour, and from Discord there is no
terminal to answer in. Also writing trust for a scheduled run or a fallback folder:
nobody said yes, and home would trust everything.
