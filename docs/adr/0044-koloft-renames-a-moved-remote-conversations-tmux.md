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
pull later, so a tab's kill then tries, last, the name in the tab's `tabs/<tab>.tmux`, never
an empty one (tmux would pick a session itself: another tab's), and prints the name it
ended. Every hook (Claude Code's, Antigravity's, Muse's) writes the new name to that file
before it renames the session, so a kill landing between the two finds the session under
the old name or under the file's; a Claude Code rename that fails puts the old name back,
so a reconnect still attaches. Koloft books that session as ended by it, and a launch of a
conversation the machine still lists waits for every kill on the wire there (any one of
them may be ending it under its new name) before choosing between attach and start. A
tab's start deletes the file, so a name left by an earlier run of that tab id never
reaches a kill. Muse and Antigravity tabs read the file in a separate ssh call first, so
the books name the session it held then, and pass their tab as well, so the kill reads the
file again in case a rename landed after that read.
**Rejected**: renaming in the hook script on any report whose session id differs from the
tmux name (as the Antigravity hook does). A fork's Stop would then rename the parent tab's
tmux session to the fork's id whenever the fork's hook runs with the tab's `TMUX` (not
probed yet); the rename from the Mac, after Koloft has read `continued-in`, does not
depend on that. Also rejected: killing by the tmux session id (`$N`), kept in a file at a
tab's start. An id outlives renames, but ids start again at `$0` when the tmux server
restarts (PLATFORM§35), a tab that attaches to a running session never runs the line that
keeps it, and an id left from an earlier start of the same tab id would be tried before
the right name.
