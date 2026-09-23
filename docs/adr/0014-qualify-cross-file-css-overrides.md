# 0014 An override of a shared class from another CSS file repeats that class

**Constraint**: when two rules have the same specificity and sit in different CSS files,
Vite's bundle order picks the winner, and nothing in either file shows that order.
**Decision**: an override of a shared class that lives in its own CSS file doubles the
selector (`.file-tree.bv-body`, `.ft-search.bv-search`), so it wins whichever file is
bundled first.
**Rejected**: a bare `.bv-body` / `.bv-search` — cleaner to read, but it wins only by
source order, which can flip silently.
