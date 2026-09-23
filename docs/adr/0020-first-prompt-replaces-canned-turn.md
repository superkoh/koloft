# 0020 In fake-claude, a `--` first message replaces the canned startup turn

**Constraint**: real claude writes a turn's records before it asks for permission, and
Koloft's tracker treats any user or assistant record read after a permission
Notification as new work, clearing the approval mark about 400 ms later.
**Decision**: when a launch carries `-- <text>`, fake-claude fires only SessionStart and
then runs the text through the same handler a typed line uses. It writes no canned
records, no NOTES.md and no prompt/stop pair.
**Rejected**: writing the canned turn and then the first message — records land after
the permission prompt, the approval mark clears, and a `/need-approval` job flakes
instead of failing.
