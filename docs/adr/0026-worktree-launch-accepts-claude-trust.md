# 0026 Only a worktree session the person starts or opens, a scheduled run's worktree under a folder they trusted, or a session an agent starts in a sidebar workspace, writes an agent's folder trust

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
- a scheduled run makes its new worktree inside a workspace folder the agent already
  trusts: the yes the person gave that folder covers the worktree Koloft makes in it,
  and Codex and agy ask again in a worktree under a trusted folder (`CODEX§11`, `AGY§5`).
  Muse gets the same outcome without writing, from `--trust-workspace`; Claude needs
  nothing, as `-w` runs from the trusted folder itself;
- an agent starts a main session with `koloft session new` — the butler from Discord,
  or any session, a scheduled run's too — in a workspace the owner added to the
  sidebar, or in the butler's own folder: adding the folder is the owner's yes, and
  nobody is at the terminal to answer. A worktree it starts is trusted by the first
  rule's code; a folder the sidebar does not hold (the caller's own fallback folder,
  home) gets nothing.
- the person opens an Antigravity session in a worktree Koloft made — a recovered one, a
  resumed one — whose workspace agy already trusts: that earlier yes covers it, but agy
  does not carry a folder's trust down to its subfolders and has no flag that trusts for
  one run (`AGY§5`), so the worktree folder is written as well. Muse gets the same outcome
  without writing, from `--trust-workspace` for that run. A git worktree the person made
  themselves is not Koloft's and gets agy's own question.
Nothing else writes it: a main session the person starts at the Mac gets the agent's
own question in the terminal, a scheduled run in a workspace the agent does not trust
keeps the jobs form's warning and stops on the question, and a launch that fell back to
another folder writes nothing. The same rule holds on a remote machine, where the entry
is written there, over ssh.
**Rejected**: refusing the launch and telling the person to open a main session first
to answer the question — one click beats that detour, and from Discord there is no
terminal to answer in. Also writing trust for a scheduled run in a folder nobody
trusted, or for a fallback folder: nobody said yes, and home would trust everything.
Also refusing Codex jobs in a git workspace: those jobs could then never run.
