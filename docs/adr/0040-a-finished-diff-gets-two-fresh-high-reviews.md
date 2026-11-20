# 0040 A finished diff gets two fresh `/code-review high` runs, merged

**Constraint**: one `/code-review` run finds only some of a diff's bugs, and a fresh run
on the same diff finds a different few (CC§20). A review has to end in minutes and is
paid for on every PR.
**Decision**: two `high` runs at once, each a fresh process, their reports merged by the
session. On Claude Code 2.1.329, on Koloft's own past PRs with 12 later-fixed bugs, this
caught 3.3 of them for $4.91 a PR, where the three `medium` runs used before caught 1
for $4.41; its slowest run took 13.4 minutes, and each run is given 25, as a `high` run
on the older recipe once took 20.1 (CC§20). The sample is small (8 PRs, three
`high` runs each), and the numbers hold only for the recipe Claude Code sends from
2.1.328; a recipe change is a reason to measure again.
**Rejected** (on 2.1.329):
- Three `medium` runs, the step before: from 2.1.328 they caught no more than one did.
- One `high` run: 2.3 caught for $2.46; the second run adds about one more bug.
- Three `high` runs: 4 caught against two runs' 3.3, for half again the cost of two.
- One `xhigh` run: 4 caught for about the cost of three `high` runs, but it took a
  median 21 and up to 29 minutes, past the 25 each run is given, and it missed bugs
  `high` caught.
- `low` and `max` (measured on the recipe up to 2.1.327): `low` caught none of the known
  bugs and stops part way on a big diff; `max` is slow, costly and runs into usage limits.
- A custom review skill (several readers, each reading its part of the diff to the
  end): most of its findings were real, but it caught none of the known bugs.
