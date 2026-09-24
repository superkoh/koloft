# 0026 A worktree session accepts Claude's folder trust for the repo on the person's behalf

**Constraint**: `claude -w <name>` in a repo Claude has never been trusted in does not
ask the trust question — it prints an error and exits at once (`CC§9`). So the first
session in a newly added workspace, if it is a worktree session, died on start.
**Decision**: when the person starts a new worktree session and `~/.claude.json` has no
trust for the workspace folder (or an ancestor), Koloft first writes
`hasTrustDialogAccepted: true` under that folder's real path. That click counts as their
yes. Nothing else writes it: a main session gets Claude's own question in the
terminal, and a scheduled run — a worktree launch nobody clicked — keeps the jobs
form's warning. Never when the launch fell back to another folder (the home folder
would trust everything under it). A Codex worktree session follows the same rule: its
native TUI asks the same kind of question (`CODEX§9`), so Koloft writes
`trust_level = "trusted"` for the workspace folder into Codex's `config.toml`
(`CODEX§11`), on the same trigger.
**Rejected**: refusing the launch and telling the person to open a main session first
to answer the question — the owner chose one click over that detour.
