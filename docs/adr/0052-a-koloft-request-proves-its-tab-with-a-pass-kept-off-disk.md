# 0052 A koloft request proves its tab with a pass that is kept off disk

**Constraint**: a `koloft` request used to say which tab it came from, and Koloft believed it
(GitHub issue #2339). One line, `KOLOFT_TAB_ID=<the butler's tab> koloft discord send …`, let any
session pass for the butler; a session could also run another Codex or Antigravity tab's
`koloft` file, whose folder `ls /tmp` shows. The owner asked that each tab hold something
the others cannot simply name, that it is never printed, logged or written to a plain file
a person or agent can read, that a session already open when Koloft is updated keeps
working until it closes, and that no "no pass, so go by the id" path stays open for good.
**Decision**: every tab gets `KOLOFT_TAB_PASS`, an HMAC of its tab id under a random key
that lives only in the memory of this Koloft run. Each `koloft` script sends it; Koloft
answers only when it is that tab's pass. A session on another machine gets it through the
0600 file the tab package already uses, read into the session and deleted as it starts, and
keeps it in its tmux session's own environment; when a tab lands on a tmux session that is
already running, as after a restart, the machine writes the new tab id and pass there, but
only into a session that already holds a pass. A tmux session that holds none, or one Koloft
could not ask about, was started by a Koloft without passes: that tab alone is still found by its tmux name or tab id, without a
pass, until it starts a session of its own, and it is never handed a pass, so it is found the
same way after the next restart too. Those sessions only get fewer: no session a Koloft with
passes starts ever joins them, so the way in without a pass ends when the last of them ends. A pass file a failed launch leaves on the machine is
removed by the next tab Koloft sends there.
**Rejected**: finding the caller by its process tree (the pid in the request is the
caller's to write, a check from the process table costs every request and, on another
machine, one more ssh call, and a command that leaves its parent, as `nohup` does, would be
refused); a pass or key stored on disk or in the Keychain, so a tab keeps it across restarts
(the attach step hands out a new one instead, so nothing is stored); trusting the tmux name
again once a pass fails (the request writes that name too).
**Cost taken**: a Workbench shell on another machine opens with one more ssh call, to take
its pass over, and a session found on its machine by its tmux session is found through the
processes it runs under, never `TMUX_PANE`, which the caller sets. The pass stops naming,
not reading: on the Mac one `ps -axEww` shows the environment of every agent process, and
on a Linux machine `/proc/<pid>/environ` does (PLATFORM§74); a session that prints its own
environment writes its pass into its transcript.
