# 0024 Changes learns which worktree its baseline is for even while it is hidden

**Constraint**: the Workbench resolves the baseline while the panel is showing, and that
includes the time another tab (a file tab) covers Files, so the Changes half is not
active. No e2e flow switches worktree while Changes is covered.
**Decision**: the Changes fetch effect notes which root the coming baseline is for
before its `active` gate, and fetches only once the baseline and the root match.
**Rejected**: putting the `active` check first, the usual shape for an effect — a
baseline that arrives while Changes is covered is then never tied to the new root, the
two never match again, and after a worktree switch Changes stays on "Reading the change
set…" for good.
