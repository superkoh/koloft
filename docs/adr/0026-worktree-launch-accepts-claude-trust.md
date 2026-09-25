# 0026 Only a worktree session the person starts writes Claude's folder trust

**Constraint**: `claude -w <name>` in a repo Claude has never been trusted in does not
ask the trust question — it prints an error and exits at once (`CC§9`).
**Decision**: when the person starts a new worktree session and `~/.claude.json` has no
trust for the workspace folder (or a parent), Koloft writes
`hasTrustDialogAccepted: true` under that folder's real path; that click counts as
their yes. Nothing else writes it: a main session gets Claude's own question in the
terminal, a scheduled run keeps the jobs form's warning, and a launch that fell back to
another folder writes nothing.
**Rejected**: refusing the launch and telling the person to open a main session first
to answer the question — one click beats that detour. Also writing trust for a
scheduled run or a fallback folder: nobody said yes, and home would trust everything.
