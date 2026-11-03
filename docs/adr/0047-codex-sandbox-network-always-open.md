# 0047 Every Codex tab runs with its sandbox network open

**Constraint**: Codex reads `sandbox_workspace_write.network_access` once, when its
app-server starts, and a running tab never gets new launch options (CODEX§26, CODEX§29).
Without it, `git push` and anything else that needs the network fails inside the
sandbox. A tab the owner opened before picking a git account for its repository, a
remote tab (no Workbench browser there), and a tab with browser control off would stay
offline until restarted; a tab that does not ask to rerun the command outside the
sandbox just fails.
**Decision**: the owner chose that every Codex tab Koloft starts, on this Mac and on a
remote machine, gets `sandbox_workspace_write.network_access=true`, as every Muse
session gets its network (ADR-0038). The cost: a network command no longer stops to ask
in an on-request tab, and the login Keychain file is readable inside the sandbox
(CODEX§29), now in every tab. Koloft starts Claude Code with no sandbox at all, so this
stays stricter than a Claude session.
**Rejected**: opening the network only for a tab that drives the Workbench browser or
sits in a repository with a picked git account — the earlier rule; a pick made after
the tab started never reached it. Restarting a running tab when its repository gets an
account — it cuts off a turn the owner may be in the middle of.
