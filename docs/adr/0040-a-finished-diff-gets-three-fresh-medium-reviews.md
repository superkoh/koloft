# 0040 A finished diff gets three fresh `/code-review medium` runs, merged

**Constraint**: one `/code-review` run finds only some of a diff's bugs, and a fresh run
on the same diff finds a different few (CC§20). A review has to end in minutes and is
paid for on every PR.
**Decision**: three `medium` runs at once, each a fresh process, their reports merged by
the session. On Koloft's own past PRs this caught two to three times what one run did,
about as much as three `high` runs, for less money and half the slowest wait (CC§20).
All of this, and the Rejected list below, was measured on Claude Code's review recipe
up to 2.1.327. The recipe changed in 2.1.328, and on 2.1.329 one `medium` run caught as
much as three (CC§20). That sample is small (12 bugs, three runs, about 1 in 6 odds
that the two misses were luck) and no other level was measured on the new recipe, so
whether to keep three runs, drop to one, or move level is open in GitHub issue #2260.
**Rejected** (on the recipe up to 2.1.327):
- One `low` run, the step before: it caught none of the known bugs and stops part way
  on a big diff (CC§20).
- One run of any level: half or less of what three `medium` runs catch.
- `high` ×2 or ×3: about the same catch for more money, and its slowest run is twice
  as long.
- `xhigh` and `max`: `xhigh` costs more than three `medium` runs for no more catch, and
  `max` is slow, costly and runs into usage limits.
- A custom review skill (several readers, each reading its part of the diff to the
  end): most of its findings were real, but it caught none of the known bugs.
