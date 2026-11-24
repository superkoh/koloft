# 0053 The repo's developer checks run as each agent's own hooks, never as git hooks

**Constraint**: the repo is worked on by Claude Code, Codex and Antigravity sessions, and
each must meet the same three checks: a fresh worktree installs its node_modules, an
edited code file is checked for comments, and a push or a new pull request waits for
`format:check`, `check:comments`, `check:agent-words`, `check:agent-imports` and `typecheck`. The owner decided these run inside the
agent's own session, through the hooks each agent reads from the repo, and not through
git.
**Decision**: Claude Code keeps `.claude/settings.json`, which calls the three scripts
directly. Codex reads `.codex/config.toml` and Antigravity reads `.agents/hooks.json`;
both call `scripts/agent-hook.sh`, which finds node and runs `scripts/agent-hook.mjs`,
which translates that agent's hook input into what the three scripts read and their
answer into what that agent understands. The hook lines stay fixed: Codex trusts a hook by
a hash of its line (CODEX§27), so a changed line runs nowhere until
`node scripts/trust-codex-hooks.mjs` is run again on every machine, and the logic lives in
the scripts, whose contents the hash does not cover. Each line first checks that the
script exists, so a worktree made before the scripts did lets everything through.
**Rejected**: git hooks (`pre-push`, and `post-checkout` for the install) — they cover
every agent and person with one file, but the owner rejected running the checks through
git. One hook file read by every agent — no agent reads another's file, and Codex and
Antigravity read neither `.claude/settings.json` nor each other's. Pointing Codex and
Antigravity straight at the three scripts — their input and output differ from Claude's
(an Antigravity hook that prints anything on a pass blocks the tool, AGY§12; a Codex edit
is one patch naming several files).
