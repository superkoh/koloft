# 0019 The save-conflict diff matches only the shared start and end

**Constraint**: the editor buffer can be about half a megabyte. A true line-by-line
diff builds a table that grows with the square of the line count, and it would freeze
the panel just when the user needs to read the conflict.
**Decision**: `diffLines` keeps the lines both sides share at the start and at the end,
and shows everything between as "theirs out, mine in". It stays linear.
**Rejected**: a real shortest-edit diff (LCS or Myers) — nicer on a file changed all
over, but quadratic in the worst case, and it freezes the UI on big files.
