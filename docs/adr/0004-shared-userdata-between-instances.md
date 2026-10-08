# 0004 Startup never wipes files that other Koloft instances share

**Constraint**: several Koloft installs can run at once on one userData folder (two dev
runs from different checkouts, or the installed app next to a release build of a
worktree under test), and a peer may have been running for days.
**Decision**: startup never wipes the shared folders. The statusline mod folder is one
for all installs: it names no binary, so whichever install wrote it last still works for
the others, and startup rewrites a file in it only when the text differs, because every
live claude session reloads the mod on any write there, same text or not (CC§16). Registration
and pick files are deleted only once they are older than a fixed age. A tab's marker
files (`<tab>.answerable`, `<tab>.conductor`) live as long as the tab, so they are
deleted at startup only when the instance whose pid is in the tab id is no longer
running.
**Rejected**: wiping at startup, or pruning by age, deletes files a live peer still
uses.
