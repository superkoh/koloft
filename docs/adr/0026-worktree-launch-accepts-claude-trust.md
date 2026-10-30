# 0026 Only a worktree session the person starts, or a session an agent starts in a sidebar workspace, writes an agent's folder trust

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
- an agent starts a main session with `koloft session new` — the butler from Discord,
  or any session, a scheduled run's too — in a workspace the owner added to the
  sidebar, or in the butler's own folder: adding the folder is the owner's yes, and
  nobody is at the terminal to answer. A worktree it starts is trusted by the first
  rule's code; a folder the sidebar does not hold (the caller's own fallback folder,
  home) gets nothing.
Nothing else writes it: a main session the person starts at the Mac gets the agent's
own question in the terminal, a scheduled run itself keeps the jobs form's warning,
and a launch that fell back to another folder writes nothing. The same rule holds on a remote
machine, where the entry is written there, over ssh.
**Rejected**: refusing the launch and telling the person to open a main session first
to answer the question — one click beats that detour, and from Discord there is no
terminal to answer in. Also writing trust for a scheduled run or a fallback folder:
nobody said yes, and home would trust everything.
