# 0044 Koloft renames a moved remote conversation's tmux session from the Mac

**Constraint**: on a remote machine a Claude tab's tmux session is named `k-<session id>`,
and Koloft reads which sessions are alive, and which one to attach after a restart, from
those names. When Claude Code moves a conversation to a new id (CC§5), no SessionStart
fires for the new id, so the hook script's rename never runs and the name keeps the
phantom start's id. Only Koloft tells a move from a `/fork` copy: it reads the
`continued-in` record at the end of the old transcript. A fork's reports carry the
parent tab's hook settings and a new id, the same shape as a moved conversation's.
**Decision**: when `followMovedConversation` follows a move on a remote tab, Koloft runs
`tmux rename-session` over ssh to `k-<new id>` and writes the new name to
`~/.koloft/tabs/<tab>.tmux`, which the tab's reconnect reads; the tab's tmux name in the
tracker changes only once that rename came back clean.
**Rejected**: renaming in the hook script on any report whose session id differs from the
tmux name (as the Antigravity hook does). A fork's Stop would then rename the parent tab's
tmux session to the fork's id whenever the fork's hook runs with the tab's `TMUX` (not
probed yet); the rename from the Mac, after Koloft has read `continued-in`, does not
depend on that.
