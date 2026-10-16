# 0038 Every Muse session runs with its sandbox network open

**Constraint**: under Muse's default sandbox network (`proxy-only`) a command the model
starts cannot even listen on a port of its own machine (`listen EPERM`, MUSE§8), so a
dev server (`npm run dev`) never starts. Only `--sandbox-network enabled` or the
`:unrestricted` profile let it listen.
**Decision**: the owner chose (October 2026) that every Muse session Koloft starts gets
`--sandbox-network enabled`, not only the ones that drive the Workbench browser or use
a git account, so a Muse session can run a dev server like a Claude session can. The
cost is that a network fetch no longer stops to ask (MUSE§15). Claude Code has no
sandbox at all, so this stays stricter than a Claude session.
**Rejected**: opening the network only for a session that needs it (the browser, a git
account) — the earlier rule; most sessions then could not run a dev server. A setting
in Settings to open it — one more switch the owner must know to turn on.
