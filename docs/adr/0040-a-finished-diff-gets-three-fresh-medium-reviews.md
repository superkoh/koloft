# 0040 A finished diff gets three fresh `/code-review medium` runs, merged

**Constraint**: one `/code-review` run finds only some of a diff's bugs, and a fresh run
on the same diff finds a different few (CC§20). A review has to end in minutes and is
paid for on every PR.
**Decision**: three `medium` runs at once, each a fresh process, their reports merged by
the session. On Koloft's own past PRs this caught two to three times what one run did,
about as much as three `high` runs, for less money and half the slowest wait (CC§20).
**Rejected**:
- One `low` run, the step before: it caught none of the known bugs and stops part way
  on a big diff (CC§20).
- One run of any level: half or less of what three `medium` runs catch.
- `high` ×2 or ×3: about the same catch for more money, and its slowest run is twice
  as long.
- `xhigh` and `max`: `xhigh` costs more than three `medium` runs for no more catch, and
  `max` is slow, costly and runs into usage limits.
- A custom review skill (several readers, each reading its part of the diff to the
  end): most of its findings were real, but it caught none of the known bugs.
