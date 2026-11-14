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
tracker changes only once that rename came back clean, and only if no other rename (a
`/clear`'s, from the hook) changed it meanwhile. Until then the tracker still holds the old
name, so a kill of that name asked for while the rename is on the wire (the tab closed in
that moment) is one command that tries the old name and, finding no session, the new one:
the session has one of the two whenever the rename lands. Sent for the old name alone it
can find no session, which tmux reports like a session already gone, and the conversation
would keep running on the machine with no tab and no error. The kill does not wait for the
rename and pick a name from its result: a rename can take on the machine and still come
back failed (the link drops, the name file cannot be written).
A `/clear`'s rename is the hook's, on the machine, and reaches the tracker only one mirror
pull later, and the hook writes the new name to `tabs/<tab>.tmux` only after renaming, so a
kill between those two steps finds no session under any name it knows. So a tab's start
keeps its tmux session's id and creation time in `tabs/<tab>.tmuxid`, read from inside
the pane before the agent runs, and a kill given the tab tries that first: an id
survives every rename. It kills by id only when both still match the machine's
`list-sessions`, since ids start again at `$0` once the tmux server restarts and an old
id can name another tab's session (PLATFORM§35). It then tries the names (a tab started
before the id was kept has no id file) and, last, the name in `tabs/<tab>.tmux`, never
an empty one (tmux would pick a session itself: another tab's), and prints the name it
ended. Muse and Antigravity tabs pass their tab too. Koloft books that session as ended by it, and a launch of a conversation the
machine still lists waits for every kill on the wire there (any one of them may be ending it
under its new name) before choosing between attach and start. A tab's start deletes both
files, so a name or id left by an earlier run of that tab id never reaches a kill. Reading the file
in a separate ssh call first (as Muse and Antigravity tabs do) costs one more round trip
and leaves the books naming the old session while the kill runs.
**Rejected**: renaming in the hook script on any report whose session id differs from the
tmux name (as the Antigravity hook does). A fork's Stop would then rename the parent tab's
tmux session to the fork's id whenever the fork's hook runs with the tab's `TMUX` (not
probed yet); the rename from the Mac, after Koloft has read `continued-in`, does not
depend on that.
