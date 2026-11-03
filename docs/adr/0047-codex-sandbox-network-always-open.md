# 0047 Every Codex tab runs with its sandbox network open

**Constraint**: Codex reads `sandbox_workspace_write.network_access` once, when its
app-server starts, and a running tab never gets new launch options (CODEX§26, CODEX§29).
Without it, `git push` and anything else that needs the network fails inside the
sandbox. A tab the owner opened before picking a git account for its repository, a
remote tab (no Workbench browser there), and a tab with browser control off would stay
offline until restarted; the butler and scheduled runs never ask to leave the sandbox,
so they just fail.
**Decision**: the owner chose (November 2026) that every Codex tab Koloft starts, on
this Mac and on a remote machine, gets `sandbox_workspace_write.network_access=true`,
as every Muse session gets its network (ADR-0038). The cost is that a network command
no longer stops to ask in an on-request tab. Claude Code has no sandbox at all, so this
stays stricter than a Claude session.
**Rejected**: opening the network only for a tab that drives the Workbench browser or
sits in a repository with a picked git account — the earlier rule; a pick made after
the tab started never reached it. Restarting a running tab when its repository gets an
account — it cuts off a turn the owner may be in the middle of.
